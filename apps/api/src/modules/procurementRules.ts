import {
  activeRuleSet, CHECK_TYPE_TR, COMPLIANCE_CHECKS, DEFAULT_RULESET, PROJECT_METHOD_TR, PROJECT_METHODS, validateComplianceRule,
  type CheckKey, type CheckType, type ComplianceRule, type ProjectMethod,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { conflict, notFound, unprocessable } from '../errors.ts';

/**
 * v2 Faz 7 (D112) Görev 5: sürümlü satınalma kuralları kataloğu (R6, R7).
 * Set DRAFT doğar (kiracı başına tek açık taslak), kuralları yalnız taslakta eklenir/değişir/silinir; yayımlanınca değişmez.
 * Yayım tarihi bugünden (Europe/Istanbul) önce olamaz. Bir gün için yürürlükteki set: yayımlı ve effective_from ≤ gün olanların
 * en büyük effective_from'lusu; aynı gün birden çok set varsa sonra yayımlanan (büyük sürüm) geçerlidir (`ruleSetForDay`).
 * Kural doğrulaması domain `validateComplianceRule` ile (422 hata listesiyle). Denetim motoru Görev 6'dadır.
 */

const STATUS_TR = { DRAFT: 'Taslak', PUBLISHED: 'Yayımlandı' } as const;
type Phase = 'DRAFT' | 'IN_FORCE' | 'SCHEDULED' | 'SUPERSEDED';
const PHASE_TR: Record<Phase, string> = { DRAFT: 'Taslak', IN_FORCE: 'Yürürlükte', SCHEDULED: 'İleri tarihte yürürlüğe girecek', SUPERSEDED: 'Yerini yenisine bıraktı' };
const PARAM_LABEL_TR: Record<string, string> = {
  minBids: 'En az teklif sayısı', maxAgeMonths: 'Risk değerlendirmesinin en fazla yaşı (ay)', maxLevel: 'İzin verilen en yüksek risk seviyesi',
  tolerancePercent: 'Tutar toleransı (%)', threshold: 'Şablon uygunluk puanı eşiği',
};
const DRAFT_EXISTS = 'Açık bir taslak kural seti var; yeni taslak açmadan önce onu yayımlayın ya da düzenlemeye devam edin.';
const NOT_DRAFT = 'Yayımlanmış kural seti değiştirilemez; değişiklik için yeni sürüm taslağı açın.';

const todaySql = `(now() AT TIME ZONE 'Europe/Istanbul')::date`;
async function today(tx: Tx): Promise<string> {
  return (await tx.query<{ d: string }>(`SELECT ${todaySql}::text AS d`)).rows[0]!.d;
}

interface SetRow {
  id: string; version_no: number; status: 'DRAFT' | 'PUBLISHED'; effective_from: string | null;
  created_by: string; created_by_name: string | null; created_at: Date;
  published_by: string | null; published_by_name: string | null; published_at: Date | null;
  rule_count: number; mandatory_count: number; total_weight: number;
}
const SET_SELECT = `SELECT s.id, s.version_no, s.status, s.effective_from::text AS effective_from, s.created_by, cu.display_name AS created_by_name, s.created_at,
    s.published_by, pu.display_name AS published_by_name, s.published_at,
    (SELECT count(*)::int FROM procurement_rules r WHERE r.rule_set_id = s.id) AS rule_count,
    (SELECT count(*)::int FROM procurement_rules r WHERE r.rule_set_id = s.id AND r.mandatory) AS mandatory_count,
    (SELECT coalesce(sum(r.weight), 0)::int FROM procurement_rules r WHERE r.rule_set_id = s.id) AS total_weight
  FROM procurement_rule_sets s LEFT JOIN users cu ON cu.id = s.created_by LEFT JOIN users pu ON pu.id = s.published_by`;

/** Yayımlı setlerden gün için yürürlükteki (domain activeRuleSet; eşit günde büyük sürüm kazanır). */
function pickForDay<T extends { id: string; version_no: number; status: string; effective_from: string | null }>(sets: T[], day: string): T | null {
  const keyed = sets.filter((s) => s.status === 'PUBLISHED' && s.effective_from)
    .map((s) => ({ id: String(s.version_no).padStart(10, '0'), status: s.status, effectiveFrom: s.effective_from!, row: s }));
  return activeRuleSet(keyed, day)?.row ?? null;
}

function phaseOf(s: SetRow, inForceId: string | null, day: string): Phase {
  if (s.status === 'DRAFT') return 'DRAFT';
  if (s.id === inForceId) return 'IN_FORCE';
  return s.effective_from! > day ? 'SCHEDULED' : 'SUPERSEDED';
}

const setView = (s: SetRow, inForceId: string | null, day: string) => {
  const phase = phaseOf(s, inForceId, day);
  return {
    id: s.id, versionNo: s.version_no, status: s.status, statusLabel: STATUS_TR[s.status], phase, phaseLabel: PHASE_TR[phase],
    effectiveFrom: s.effective_from, ruleCount: s.rule_count, mandatoryCount: s.mandatory_count, totalWeight: s.total_weight,
    createdBy: s.created_by, createdByName: s.created_by_name, createdAt: s.created_at,
    publishedBy: s.published_by, publishedByName: s.published_by_name, publishedAt: s.published_at,
  };
};

interface RuleRow {
  id: string; rule_set_id: string; code: string; name: string; description: string | null; check_type: CheckType; check_key: CheckKey | null;
  params: Record<string, number | string>; scope_methods: string[]; min_amount: string | null; min_amount_currency: string | null;
  weight: number; mandatory: boolean; sort_order: number;
}
const RULE_SELECT = `SELECT id, rule_set_id, code, name, description, check_type, check_key, params, scope_methods, min_amount::text AS min_amount,
    min_amount_currency, weight, mandatory, sort_order FROM procurement_rules`;

const ruleView = (r: RuleRow) => ({
  id: r.id, code: r.code, name: r.name, description: r.description,
  checkType: r.check_type, checkTypeLabel: CHECK_TYPE_TR[r.check_type],
  checkKey: r.check_key, checkName: r.check_key && Object.hasOwn(COMPLIANCE_CHECKS, r.check_key) ? COMPLIANCE_CHECKS[r.check_key].name : null,
  params: r.params, paramLabels: Object.fromEntries(Object.keys(r.params).map((k) => [k, PARAM_LABEL_TR[k] ?? k])),
  methods: r.scope_methods, methodLabels: r.scope_methods.map((m) => PROJECT_METHOD_TR[m as ProjectMethod] ?? m),
  amountThreshold: r.min_amount, currency: r.min_amount_currency,
  weight: r.weight, mandatory: r.mandatory, sortOrder: r.sort_order,
});

/** Denetim motoru (Görev 6) için domain biçiminde kural. */
export const toComplianceRule = (r: RuleRow): ComplianceRule & { id: string; sortOrder: number } => ({
  id: r.id, code: r.code, name: r.name, description: r.description, checkType: r.check_type, checkKey: r.check_key, params: r.params,
  methods: r.scope_methods, amountThreshold: r.min_amount, currency: r.min_amount_currency, weight: r.weight, mandatory: r.mandatory, sortOrder: r.sort_order,
});

async function publishedSets(tx: Tx) {
  return (await tx.query<{ id: string; version_no: number; status: string; effective_from: string | null }>(
    `SELECT id, version_no, status, effective_from::text AS effective_from FROM procurement_rule_sets WHERE status = 'PUBLISHED'`)).rows;
}

/**
 * R6: verilen gün (YYYY-MM-DD; ör. projenin `completed_on`) için yürürlükteki yayımlı set ve kuralları; yoksa null (NO_RULESET).
 * Görev 6 denetim motoru bunu kullanır; yeniden koşu aynı günü verdiği için aynı seti alır.
 */
export async function ruleSetForDay(tx: Tx, day: string) {
  const pick = pickForDay(await publishedSets(tx), day);
  if (!pick) return null;
  const rules = (await tx.query<RuleRow>(`${RULE_SELECT} WHERE rule_set_id = $1 ORDER BY sort_order, code`, [pick.id])).rows.map(toComplianceRule);
  return { id: pick.id, versionNo: pick.version_no, effectiveFrom: pick.effective_from!, rules };
}

export async function listRuleSets(tx: Tx) {
  const day = await today(tx);
  const rows = (await tx.query<SetRow>(`${SET_SELECT} ORDER BY s.version_no DESC`)).rows;
  const inForce = pickForDay(rows, day);
  const items = rows.map((s) => setView(s, inForce?.id ?? null, day));
  return {
    today: day, items,
    current: items.find((s) => s.phase === 'IN_FORCE') ?? null,
    draft: items.find((s) => s.status === 'DRAFT') ?? null,
    scheduled: items.filter((s) => s.phase === 'SCHEDULED'),
  };
}

export async function getRuleSet(tx: Tx, id: string) {
  const s = (await tx.query<SetRow>(`${SET_SELECT} WHERE s.id = $1`, [id])).rows[0];
  if (!s) throw notFound();
  const day = await today(tx);
  const inForce = pickForDay(await publishedSets(tx), day);
  const rules = (await tx.query<RuleRow>(`${RULE_SELECT} WHERE rule_set_id = $1 ORDER BY sort_order, code`, [id])).rows;
  return { ...setView(s, inForce?.id ?? null, day), rules: rules.map(ruleView) };
}

/** Kontrol anahtarı kataloğu (DATA ve EVIDENCE_AI kuralları için sabit liste), Türkçe ad ve parametre tanımlarıyla. */
export function complianceChecks() {
  return {
    items: (Object.entries(COMPLIANCE_CHECKS) as [CheckKey, (typeof COMPLIANCE_CHECKS)[CheckKey]][]).map(([key, def]) => ({
      key, name: def.name, checkType: def.type, checkTypeLabel: CHECK_TYPE_TR[def.type],
      params: Object.entries(def.spec as Record<string, { kind: 'int' | 'decimal'; min: number; max: number }>).map(([p, s]) => ({
        key: p, label: PARAM_LABEL_TR[p] ?? p, kind: s.kind, min: s.min, max: s.max,
        default: (def.defaultParams as Record<string, number | string>)[p] ?? null,
      })),
    })),
    checkTypes: (Object.keys(CHECK_TYPE_TR) as CheckType[]).map((k) => ({ key: k, label: CHECK_TYPE_TR[k] })),
    methods: PROJECT_METHODS.map((m) => ({ key: m, label: PROJECT_METHOD_TR[m] })),
  };
}

// ---------- Yazma (rule.manage) ----------

async function lockSet(tx: Tx, id: string) {
  const s = (await tx.query<{ id: string; status: 'DRAFT' | 'PUBLISHED'; version_no: number }>(
    `SELECT id, status, version_no FROM procurement_rule_sets WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!s) throw notFound();
  return s;
}
async function lockDraft(tx: Tx, id: string) {
  const s = await lockSet(tx, id);
  if (s.status !== 'DRAFT') throw conflict('rule_set_published', NOT_DRAFT);
  return s;
}

async function insertRule(tx: Tx, ctx: TenantContext, setId: string, r: ComplianceRule, sortOrder: number): Promise<RuleRow> {
  return (await tx.query<RuleRow>(`INSERT INTO procurement_rules (tenant_id, rule_set_id, code, name, description, check_type, check_key, params,
      scope_methods, min_amount, min_amount_currency, weight, mandatory, sort_order)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING id, rule_set_id, code, name, description, check_type, check_key, params, scope_methods, min_amount::text AS min_amount,
      min_amount_currency, weight, mandatory, sort_order`,
  [ctx.tenantId, setId, r.code, r.name, r.description, r.checkType, r.checkKey, r.params, r.methods, r.amountThreshold, r.currency,
    r.weight, r.mandatory, sortOrder])).rows[0]!;
}

/** POST: `{ from: 'DEFAULT' }` §3.6 varsayılan kataloğundan, `{ from: <setId> }` mevcut bir setin kopyasından taslak (sonraki sürüm). */
export async function createRuleSet(tx: Tx, ctx: TenantContext, body: { from: string }) {
  // Sürüm numarası ve tek taslak için kiracı içi sıralama (eşzamanlı iki "yeni taslak" isteği).
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('procurement_rule_sets:' || $1))`, [ctx.tenantId]);
  const draft = (await tx.query<{ id: string; version_no: number }>(`SELECT id, version_no FROM procurement_rule_sets WHERE status = 'DRAFT'`)).rows[0];
  if (draft) throw conflict('draft_exists', DRAFT_EXISTS, { draftId: draft.id, versionNo: draft.version_no });
  let source: ComplianceRule[];
  let sourceVersion: number | null = null;
  if (body.from === 'DEFAULT') source = DEFAULT_RULESET;
  else {
    const src = (await tx.query<{ id: string; version_no: number }>(`SELECT id, version_no FROM procurement_rule_sets WHERE id = $1`, [body.from])).rows[0];
    if (!src) throw notFound();
    sourceVersion = src.version_no;
    source = (await tx.query<RuleRow>(`${RULE_SELECT} WHERE rule_set_id = $1 ORDER BY sort_order, code`, [src.id])).rows.map(toComplianceRule);
  }
  const versionNo = (await tx.query<{ n: number }>(`SELECT coalesce(max(version_no), 0)::int + 1 AS n FROM procurement_rule_sets`)).rows[0]!.n;
  const set = (await tx.query<{ id: string }>(`INSERT INTO procurement_rule_sets (tenant_id, version_no, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [ctx.tenantId, versionNo, ctx.userId])).rows[0]!;
  let i = 0;
  for (const r of source) {
    i += 1;
    await insertRule(tx, ctx, set.id, { code: r.code, name: r.name, description: r.description, checkType: r.checkType, checkKey: r.checkKey,
      params: { ...r.params }, methods: [...r.methods], amountThreshold: r.amountThreshold, currency: r.currency, weight: r.weight, mandatory: r.mandatory }, i);
  }
  await audit(tx, ctx, 'rule_set.created', 'procurement_rule_set', set.id,
    { versionNo, from: body.from === 'DEFAULT' ? 'DEFAULT' : { setId: body.from, versionNo: sourceVersion }, ruleCount: source.length });
  return getRuleSet(tx, set.id);
}

export interface RuleInput {
  code?: unknown; name?: unknown; description?: unknown; checkType?: unknown; checkKey?: unknown; params?: unknown; methods?: unknown;
  amountThreshold?: unknown; currency?: unknown; weight?: unknown; mandatory?: unknown; sortOrder?: unknown;
}

/** Gövdeyi domain kuralına çevirir ve doğrular; hatalar 422 `invalid_rule` + liste (Türkçe). */
function parseRule(b: RuleInput): ComplianceRule & { sortOrder: number | null } {
  const errors: string[] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const code = str(b.code), name = str(b.name);
  const description = typeof b.description === 'string' && b.description.trim() !== '' ? b.description.trim() : null;
  if (code.length > 40) errors.push('Kural kodu en çok 40 karakter olmalı');
  if (name.length > 200) errors.push('Kural adı en çok 200 karakter olmalı');
  if (description && description.length > 4000) errors.push('Açıklama en çok 4000 karakter olmalı');
  const checkType = b.checkType as CheckType;
  const checkKey = (typeof b.checkKey === 'string' && b.checkKey !== '' ? b.checkKey : null) as CheckKey | null;
  let params: Record<string, number | string>;
  if (b.params === undefined || b.params === null) {
    params = checkType !== 'MANUAL' && checkKey && Object.hasOwn(COMPLIANCE_CHECKS, checkKey) ? { ...COMPLIANCE_CHECKS[checkKey].defaultParams } : {};
  } else if (typeof b.params !== 'object' || Array.isArray(b.params)) {
    errors.push('Parametreler nesne olmalı');
    params = {};
  } else params = b.params as Record<string, number | string>;
  const methods = Array.isArray(b.methods) ? (b.methods as string[]) : [];
  if (new Set(methods).size !== methods.length) errors.push('Yöntem listesinde tekrar var');
  let amountThreshold: string | null = null;
  if (b.amountThreshold !== undefined && b.amountThreshold !== null && b.amountThreshold !== '') {
    amountThreshold = typeof b.amountThreshold === 'string' ? b.amountThreshold.trim() : String(b.amountThreshold);
    if (!/^\d{1,18}(\.\d{1,2})?$/.test(amountThreshold)) errors.push('Tutar eşiği en çok 2 ondalıklı, sıfır ya da pozitif bir sayı olmalı');
  }
  const currency = typeof b.currency === 'string' && b.currency.trim() !== '' ? b.currency.trim().toUpperCase() : null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) errors.push('Para birimi üç harfli kod olmalı (ör. TRY)');
  if (currency && amountThreshold === null) errors.push('Para birimi yalnız tutar eşiğiyle girilir');
  const weight = b.weight as number;
  const mandatory = b.mandatory === true;
  const sortOrder = typeof b.sortOrder === 'number' && Number.isInteger(b.sortOrder) ? b.sortOrder : null;
  const rule: ComplianceRule = { code, name, description, checkType, checkKey, params, methods, amountThreshold, currency, weight, mandatory };
  errors.push(...validateComplianceRule(rule));
  if (errors.length) throw unprocessable('invalid_rule', `Kural geçersiz: ${errors.join('; ')}.`, { errors });
  return { ...rule, sortOrder };
}

async function codeTaken(tx: Tx, setId: string, code: string, exceptId: string | null) {
  return !!(await tx.query(`SELECT 1 FROM procurement_rules WHERE rule_set_id = $1 AND code = $2 AND ($3::uuid IS NULL OR id <> $3)`,
    [setId, code, exceptId])).rowCount;
}
const DUP_CODE = (code: string) => conflict('duplicate_rule_code', `Bu sette "${code}" kodlu bir kural zaten var.`);

export async function addRule(tx: Tx, ctx: TenantContext, setId: string, body: RuleInput) {
  await lockDraft(tx, setId);
  const r = parseRule(body);
  if (await codeTaken(tx, setId, r.code, null)) throw DUP_CODE(r.code);
  const order = r.sortOrder ?? (await tx.query<{ n: number }>(`SELECT coalesce(max(sort_order), 0)::int + 1 AS n FROM procurement_rules WHERE rule_set_id = $1`, [setId])).rows[0]!.n;
  const row = await insertRule(tx, ctx, setId, r, order);
  const after = ruleView(row);
  await audit(tx, ctx, 'rule.changed', 'procurement_rule', row.id, { setId, op: 'CREATE', before: null, after });
  return after;
}

async function ruleOf(tx: Tx, setId: string, ruleId: string) {
  const row = (await tx.query<RuleRow>(`${RULE_SELECT} WHERE id = $1 AND rule_set_id = $2`, [ruleId, setId])).rows[0];
  if (!row) throw notFound();
  return row;
}

/** PUT: tam değiştirme (POST ile aynı gövde); sortOrder verilmezse yerinde kalır. */
export async function updateRule(tx: Tx, ctx: TenantContext, setId: string, ruleId: string, body: RuleInput) {
  await lockDraft(tx, setId);
  const before = ruleView(await ruleOf(tx, setId, ruleId));
  const r = parseRule(body);
  if (await codeTaken(tx, setId, r.code, ruleId)) throw DUP_CODE(r.code);
  const row = (await tx.query<RuleRow>(`UPDATE procurement_rules SET code = $3, name = $4, description = $5, check_type = $6, check_key = $7, params = $8,
      scope_methods = $9, min_amount = $10, min_amount_currency = $11, weight = $12, mandatory = $13, sort_order = coalesce($14, sort_order)
    WHERE id = $1 AND rule_set_id = $2
    RETURNING id, rule_set_id, code, name, description, check_type, check_key, params, scope_methods, min_amount::text AS min_amount,
      min_amount_currency, weight, mandatory, sort_order`,
  [ruleId, setId, r.code, r.name, r.description, r.checkType, r.checkKey, r.params, r.methods, r.amountThreshold, r.currency, r.weight, r.mandatory, r.sortOrder])).rows[0]!;
  const after = ruleView(row);
  await audit(tx, ctx, 'rule.changed', 'procurement_rule', ruleId, { setId, op: 'UPDATE', before, after });
  return after;
}

export async function deleteRule(tx: Tx, ctx: TenantContext, setId: string, ruleId: string) {
  await lockDraft(tx, setId);
  const before = ruleView(await ruleOf(tx, setId, ruleId));
  await tx.query(`DELETE FROM procurement_rules WHERE id = $1 AND rule_set_id = $2`, [ruleId, setId]);
  await audit(tx, ctx, 'rule.changed', 'procurement_rule', ruleId, { setId, op: 'DELETE', before, after: null });
  return { deleted: true, id: ruleId };
}

/**
 * Yayım (R6): effectiveFrom ≥ bugün (Europe/Istanbul); en az bir kural; daha sonraki bir günden yürürlüğe girecek (planlanmış)
 * setten önceki bir güne yayımlanamaz (aksi halde yeni sürüm, eski sürüm tarafından ileride geçersiz kılınırdı).
 * Aynı gün yürürlüğe giren set varsa yeni set o günden geçerlidir (büyük sürüm kazanır).
 */
export async function publishRuleSet(tx: Tx, ctx: TenantContext, setId: string, body: { effectiveFrom: string }) {
  const s = await lockDraft(tx, setId);
  const eff = body.effectiveFrom;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eff ?? '');
  const valid = !!m && new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).toISOString().slice(0, 10) === eff;
  if (!valid) throw unprocessable('invalid_date', 'Yürürlük tarihi geçerli bir tarih olmalı (YYYY-AA-GG).');
  const day = await today(tx);
  if (eff < day) throw unprocessable('effective_in_past', 'Yürürlük tarihi bugünden önce olamaz.', { today: day });
  const rules = (await tx.query<RuleRow>(`${RULE_SELECT} WHERE rule_set_id = $1`, [setId])).rows;
  if (rules.length === 0) throw unprocessable('rules_required', 'Kural seti yayımlanmadan önce en az bir kural içermeli.');
  // Kayıtlı kurallar yeniden doğrulanır (şema sonradan sıkılaşmışsa yayım engellenir).
  const invalid = rules.map((r) => ({ code: r.code, errors: validateComplianceRule(toComplianceRule(r)) })).filter((x) => x.errors.length);
  if (invalid.length) throw unprocessable('invalid_rule', `Geçersiz kurallar var: ${invalid.map((x) => x.code).join(', ')}.`, { rules: invalid });
  const later = (await tx.query<{ version_no: number; effective_from: string }>(`SELECT version_no, effective_from::text AS effective_from FROM procurement_rule_sets
    WHERE status = 'PUBLISHED' AND effective_from > $1 ORDER BY effective_from LIMIT 1`, [eff])).rows[0];
  if (later) {
    throw unprocessable('effective_before_scheduled',
      `Sürüm ${later.version_no} ${later.effective_from} tarihinde yürürlüğe girecek; yeni sürüm o tarihten önce başlayamaz.`, { versionNo: later.version_no, effectiveFrom: later.effective_from });
  }
  const before = pickForDay(await publishedSets(tx), eff);
  await tx.query(`UPDATE procurement_rule_sets SET status = 'PUBLISHED', effective_from = $2::date, published_by = $3, published_at = now() WHERE id = $1`,
    [setId, eff, ctx.userId]);
  await audit(tx, ctx, 'rule_set.published', 'procurement_rule_set', setId,
    { versionNo: s.version_no, effectiveFrom: eff, ruleCount: rules.length, supersedes: before ? { setId: before.id, versionNo: before.version_no } : null });
  return getRuleSet(tx, setId);
}
