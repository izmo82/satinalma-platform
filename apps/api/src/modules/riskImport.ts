import { createHash } from 'node:crypto';
import {
  completionBlockers, criticality, normalizeSupplierName, RISK_LEVEL_TR, RISK_METHOD_VERSION, riskLevel, riskPeriod,
  type CriteriaValues, type RiskLevelNo,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { conflict, notFound, unprocessable } from '../errors.ts';
import { openTask, RISK_TASKS } from '../tasks.ts';
import { mixedScaleOf, NO_ACTION_RE, parseRiskTable, riskTableWorkbook, rowFromRaw, type ParsedRiskRow, type RawRow, type RiskExportRow } from '../riskExcel.ts';
import { compute, CONTROL_METHOD_TR, istanbulToday, openDueTask, SCORE_SOURCE_TR, type RiskDraft, type ScoreSource } from './riskAssessments.ts';
import { getRiskSettings } from './riskQuestions.ts';

/**
 * v2 Faz 6 (D111) Görev 6: risk Excel içe aktarımı (R11) ve dışa aktarımı (R12).
 * İçe aktarım iki adımlıdır: yükle → önizleme (risk_import_batches PREVIEW + her satırın ham hücreleri risk_import_rows.raw) → uygula
 * (tek işlem). Önizleme hesapları her okumada ham satırdan domain riskV2 ile türetilir (AI yok). Uygulama hiçbir mevcut
 * değerlendirmenin üzerine yazmaz (aynı tedarikçi + yıl "Çakışma — atlanır"); aynı dosya (sha256) ikinci kez uygulanamaz.
 * Tablolar yalnız tüm departmanları gören bağlama açıktır (054: app_department_all); uç `risk.import` (Yönetici, Satınalma).
 */

export type ImportDecision = 'CREATE' | 'SKIP' | 'MERGE' | 'NEW_CANDIDATE';
type Outcome = 'COMPLETED' | 'OPEN' | 'SKIP' | 'MERGE' | 'CONFLICT';

const OUTCOME_TR: Record<Outcome, string> = {
  COMPLETED: 'Tamamlanmış değerlendirme açılacak', OPEN: 'Açık değerlendirme açılacak', SKIP: 'Atlanacak',
  MERGE: 'Birincil satırın hizmetlerine eklenecek', CONFLICT: 'Çakışma — atlanır',
};
const OUTCOME_APPLIED_TR: Record<Outcome, string> = {
  COMPLETED: 'Tamamlandı', OPEN: 'Açıldı', SKIP: 'Atlandı', MERGE: 'Birincil satırın hizmetlerine eklendi', CONFLICT: 'Çakışma — atlandı',
};
const ASSESSMENT_STATUS_TR: Record<string, string> = { OPEN: 'Açık', COMPLETED: 'Tamamlandı', CANCELLED: 'İptal' };
const ACTION_STATUS_TR: Record<string, string> = { OPEN: 'Açık', DONE: 'Tamamlandı', VERIFIED: 'Doğrulandı', CANCELLED: 'İptal' };
const REVIEW_TR: Record<string, string> = { NO_CHANGE: 'Değişiklik yok', UPDATED: 'Güncellendi' };
/** Eşleşmeye kapalı kart durumları; birleşmiş kart hedefine çözülür. */
const UNUSABLE_SUPPLIER = ['REJECTED'];

interface BatchRow {
  id: string; file_sha256: string; file_name: string; period: string | null; year: number; fraction_scale: boolean; status: 'PREVIEW' | 'APPLIED' | 'DISCARDED';
  team_mapping: Record<string, string | null>; summary: Record<string, unknown>; uploaded_by: string; uploaded_by_name: string | null; created_at: Date;
  applied_by: string | null; applied_at: Date | null;
}
const B_SELECT = `SELECT b.id, b.file_sha256, b.file_name, b.period, b.year, b.fraction_scale, b.status, b.team_mapping, b.summary, b.uploaded_by,
    u.display_name AS uploaded_by_name, b.created_at, b.applied_by, b.applied_at FROM risk_import_batches b LEFT JOIN users u ON u.id = b.uploaded_by`;
interface ImportRow {
  id: string; row_no: number; raw: RawRow; supplier_id: string | null; supplier_name: string | null; supplier_status: string | null;
  decision: ImportDecision; primary_row: boolean; issues: string[]; assessment_id: string | null;
}
const ROW_SELECT = `SELECT r.id, r.row_no, r.raw, r.supplier_id, s.legal_name AS supplier_name, s.status AS supplier_status, r.decision, r.primary_row,
    r.issues, r.assessment_id FROM risk_import_rows r LEFT JOIN suppliers s ON s.id = r.supplier_id`;

async function loadBatch(tx: Tx, id: string, lock = false): Promise<BatchRow> {
  const b = (await tx.query<BatchRow>(`${B_SELECT} WHERE b.id = $1${lock ? ' FOR UPDATE OF b' : ''}`, [id])).rows[0];
  if (!b) throw notFound();
  return b;
}
const loadRows = async (tx: Tx, batchId: string) => (await tx.query<ImportRow>(`${ROW_SELECT} WHERE r.batch_id = $1 ORDER BY r.row_no`, [batchId])).rows;

const normTeam = (s: string) => s.toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim();

async function activeDepartments(tx: Tx) {
  return (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM departments WHERE merged_into IS NULL ORDER BY name`)).rows;
}

// ---- satır hesabı -------------------------------------------------------------------------------------------------------------------

interface Calc {
  parsed: ParsedRiskRow;
  criticality: { value: string; display: string; column: number } | null;
  level: { level: RiskLevelNo; band: RiskLevelNo; label: string } | null;
}
function calcRow(r: { row_no: number; raw: RawRow }, fractionScale: boolean, mixed = false): Calc {
  const parsed = rowFromRaw(r.row_no, r.raw, fractionScale, mixed);
  const crit = parsed.criteriaComplete ? criticality(parsed.criteria as CriteriaValues) : null;
  const lv = crit && parsed.riskScore !== null ? riskLevel(parsed.riskScore, crit.column) : null;
  return { parsed, criticality: crit, level: lv ? { ...lv, label: RISK_LEVEL_TR[lv.level] } : null };
}
/** Birincil seçimi: en yüksek seviye, eşitse en yüksek kritiklik, eşitse ilk satır (R11). */
const rank = (c: Calc): [number, number] => [c.level?.level ?? 0, c.criticality ? Number(c.criticality.value) : 0];
function better(a: { c: Calc; rowNo: number }, b: { c: Calc; rowNo: number }) {
  const [la, ca] = rank(a.c), [lb, cb] = rank(b.c);
  return la !== lb ? la > lb : ca !== cb ? ca > cb : a.rowNo < b.rowNo;
}
const willComplete = (c: Calc) => c.parsed.criteriaComplete && c.parsed.riskScore !== null && !!c.level && c.level.level <= 3;

/** Grup anahtarı: eşleşen kart, ya da yeni aday kartta normalize ad. Atlanan satırın grubu yok. */
function groupKey(r: { decision: ImportDecision; supplier_id: string | null }, c: Calc): string | null {
  if (r.decision === 'SKIP') return null;
  if (r.supplier_id) return `s:${r.supplier_id}`;
  return c.parsed.name ? `n:${normalizeSupplierName(c.parsed.name)}` : null;
}

/**
 * Aynı karta (ya da aynı yeni aday ada) düşen satırlardan biri birincildir (CREATE/NEW_CANDIDATE); diğerleri MERGE (hizmet adı
 * birincilin `services`'ine eklenir). Kullanıcının seçtiği birincil korunur; yoksa en yüksek seviye. Veritabanına yazar.
 */
async function normalizeGroups(tx: Tx, batch: BatchRow) {
  const rows = await loadRows(tx, batch.id);
  const mixed = mixedScaleOf(rows.map((r) => r.raw));
  const groups = new Map<string, { r: ImportRow; c: Calc }[]>();
  const updates: { id: string; decision: ImportDecision; primary: boolean }[] = [];
  for (const r of rows) {
    const c = calcRow(r, batch.fraction_scale, mixed);
    const key = groupKey(r, c);
    if (!key) { if (r.primary_row || (r.decision !== 'SKIP')) updates.push({ id: r.id, decision: 'SKIP', primary: false }); continue; }
    groups.set(key, [...(groups.get(key) ?? []), { r, c }]);
  }
  for (const [key, list] of groups) {
    let primary = list.find((x) => x.r.primary_row) ?? null;
    if (!primary) for (const x of list) if (!primary || better({ c: x.c, rowNo: x.r.row_no }, { c: primary.c, rowNo: primary.r.row_no })) primary = x;
    for (const x of list) {
      const isPrimary = x === primary;
      const decision: ImportDecision = !isPrimary ? 'MERGE' : key.startsWith('s:') ? 'CREATE' : 'NEW_CANDIDATE';
      if (x.r.decision !== decision || x.r.primary_row !== isPrimary) updates.push({ id: x.r.id, decision, primary: isPrimary });
    }
  }
  for (const u of updates) await tx.query(`UPDATE risk_import_rows SET decision = $2, primary_row = $3 WHERE id = $1`, [u.id, u.decision, u.primary]);
}

// ---- önizleme görünümü --------------------------------------------------------------------------------------------------------------

async function existingSuppliers(tx: Tx, year: number, supplierIds: string[]) {
  if (!supplierIds.length) return new Set<string>();
  return new Set((await tx.query<{ supplier_id: string }>(
    `SELECT supplier_id FROM risk_assessments WHERE year = $1 AND supplier_id = ANY($2::uuid[])`, [year, supplierIds])).rows.map((r) => r.supplier_id));
}

export async function getImport(tx: Tx, ctx: TenantContext, id: string) {
  const b = await loadBatch(tx, id);
  const rows = await loadRows(tx, id);
  const departments = await activeDepartments(tx);
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  // Uygulanmış partide departman adı birleşmiş olabilir; adı ayrıca okunur.
  const mappedIds = Object.values(b.team_mapping).filter((v): v is string => !!v && !deptName.has(v));
  if (mappedIds.length) for (const d of (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM departments WHERE id = ANY($1::uuid[])`, [mappedIds])).rows) deptName.set(d.id, d.name);
  const existing = await existingSuppliers(tx, b.year, [...new Set(rows.map((r) => r.supplier_id).filter((x): x is string => !!x))]);
  const applied = b.status === 'PREVIEW'
    ? (await tx.query(`SELECT 1 FROM risk_import_batches WHERE file_sha256 = $1 AND status = 'APPLIED'`, [b.file_sha256])).rowCount! > 0 : false;

  const appliedOutcomes = ((b.summary as { rowOutcomes?: Record<string, Outcome> }).rowOutcomes ?? {});
  const teamCounts = new Map<string, number>();
  const mixed = mixedScaleOf(rows.map((r) => r.raw));
  const items = rows.map((r) => {
    const c = calcRow(r, b.fraction_scale, mixed);
    const p = c.parsed;
    if (p.team) teamCounts.set(p.team, (teamCounts.get(p.team) ?? 0) + 1);
    const departmentId = p.team ? (b.team_mapping[p.team] ?? null) : null;
    const issues = [...p.issues];
    const recorded = b.status === 'APPLIED' ? appliedOutcomes[String(r.row_no)] : undefined;
    const conflictRow = b.status === 'PREVIEW' && !!r.supplier_id && r.decision !== 'SKIP' && existing.has(r.supplier_id);
    let outcome: Outcome = r.decision === 'SKIP' ? 'SKIP' : r.decision === 'MERGE' ? 'MERGE' : willComplete(c) ? 'COMPLETED' : 'OPEN';
    if (recorded) outcome = recorded;
    if (recorded === 'CONFLICT') issues.push(`Çakışma — tedarikçinin ${b.year} değerlendirmesi zaten vardı; atlandı, üzerine yazılmadı.`);
    if (conflictRow) { outcome = 'CONFLICT'; issues.push(`Çakışma — tedarikçinin ${b.year} değerlendirmesi zaten var; atlanır, üzerine yazılmaz.`); }
    if (!r.supplier_id && r.decision === 'SKIP') issues.push('Eşleşen tedarikçi kartı yok — atlanır (mevcut kart seçilebilir ya da aday kart açılabilir).');
    if (r.decision !== 'SKIP' && p.team && !departmentId) issues.push(`"${p.team}" ekibi bir departmana eşlenmedi — departman boş açılır.`);
    if (r.decision !== 'SKIP' && !p.team) issues.push('Ekip boş — departman boş açılır.');
    if ((outcome === 'OPEN') && c.level && c.level.level >= 4) issues.push('Seviye 4–5: aksiyon ve kontrol planı girilene dek açık kalır.');
    return {
      rowNo: r.row_no, name: p.name, services: p.services, criteria: p.criteria, criteriaComplete: p.criteriaComplete,
      criticality: c.criticality, excelCriticality: p.excelCriticality, riskScore: p.riskScore, level: c.level,
      actionText: p.actionText, commentNote: p.commentNote, createsAction: !!p.actionText && !NO_ACTION_RE.test(p.actionText) && p.actionText.trim().length >= 2,
      team: p.team, department: departmentId ? { id: departmentId, name: deptName.get(departmentId) ?? null } : null,
      supplier: r.supplier_id ? { id: r.supplier_id, name: r.supplier_name, status: r.supplier_status } : null,
      decision: r.decision, primary: r.primary_row, outcome, outcomeLabel: (b.status === 'APPLIED' ? OUTCOME_APPLIED_TR : OUTCOME_TR)[outcome], issues, assessmentId: r.assessment_id, raw: r.raw,
    };
  });
  const count = (f: (x: (typeof items)[number]) => boolean) => items.filter(f).length;
  const summary = {
    rows: items.length,
    assessments: count((x) => x.outcome === 'COMPLETED' || x.outcome === 'OPEN'),
    completed: count((x) => x.outcome === 'COMPLETED'), open: count((x) => x.outcome === 'OPEN'),
    skipped: count((x) => x.outcome === 'SKIP'), merged: count((x) => x.outcome === 'MERGE'), conflicts: count((x) => x.outcome === 'CONFLICT'),
    newCandidates: count((x) => x.decision === 'NEW_CANDIDATE'), unmatched: count((x) => !x.supplier), withIssues: count((x) => x.issues.length > 0),
  };
  return {
    batch: {
      id: b.id, fileName: b.file_name, sha256: b.file_sha256, period: b.period, year: b.year, fractionScale: b.fraction_scale, status: b.status,
      uploadedBy: { id: b.uploaded_by, displayName: b.uploaded_by_name }, createdAt: b.created_at, appliedAt: b.applied_at, appliedBy: b.applied_by,
      result: b.status === 'APPLIED' ? (({ rowOutcomes: _ro, ...rest }) => rest)(b.summary as Record<string, unknown>) : null,
    },
    scaleNote: b.fraction_scale ? 'Risk skoru dosyada 0–1 kesir olarak girilmiş; 100 ile çarpılarak okunur.' : 'Risk skoru dosyada 0–100 ölçeğinde.',
    teams: [...teamCounts.entries()].sort((a, b2) => a[0].localeCompare(b2[0], 'tr')).map(([team, rowCount]) => {
      const d = b.team_mapping[team] ?? null;
      return { team, rowCount, department: d ? { id: d, name: deptName.get(d) ?? null } : null };
    }),
    departments,
    rows: items,
    summary,
    alreadyApplied: applied,
    can: { edit: b.status === 'PREVIEW', apply: b.status === 'PREVIEW' && !applied, discard: b.status === 'PREVIEW' },
  };
}

// ---- yükleme ------------------------------------------------------------------------------------------------------------------------

export async function createImport(tx: Tx, ctx: TenantContext, file: { fileName: string; body: Buffer }, preParsed?: Awaited<ReturnType<typeof parseRiskTable>>) {
  const fileName = (file.fileName || 'risk.xlsx').slice(0, 255);
  if (!/\.xlsx$/i.test(fileName)) throw unprocessable('risk_import_format', 'Yalnız Excel (.xlsx) dosyası içe aktarılır.');
  const parsed = preParsed ?? await parseRiskTable(file.body);
  if (parsed.rows.length === 0) throw unprocessable('risk_import_format', '"Risk Tablosu" sayfasında 5. satırdan sonra veri yok.');
  const sha = createHash('sha256').update(file.body).digest('hex');
  const year = parsed.period ? Number(parsed.period.slice(0, 4)) : Number(istanbulToday().slice(0, 4));

  // Ekip → departman: ad eşitliğiyle ön eşleme (yalnız öneri; kullanıcı değiştirir).
  const departments = await activeDepartments(tx);
  const byName = new Map(departments.map((d) => [normTeam(d.name), d.id]));
  const teamMapping: Record<string, string | null> = {};
  for (const r of parsed.rows) if (r.team && !(r.team in teamMapping)) teamMapping[r.team] = byName.get(normTeam(r.team)) ?? null;

  const batchId = (await tx.query<{ id: string }>(
    `INSERT INTO risk_import_batches (tenant_id, file_sha256, file_name, period, year, fraction_scale, team_mapping, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.tenantId, sha, fileName, parsed.period, year, parsed.fractionScale, teamMapping, ctx.userId])).rows[0]!.id;

  // Ad eşleşmesi (R11): normalize tam eşitlik; birleşmiş kart hedefine çözülür; birden çok kart eşleşirse otomatik seçilmez.
  const suppliers = (await tx.query<{ id: string; legal_name: string; status: string; merged_into_id: string | null }>(
    `SELECT id, legal_name, status, merged_into_id FROM suppliers`)).rows;
  const byNorm = new Map<string, Set<string>>();
  for (const s of suppliers) {
    if (UNUSABLE_SUPPLIER.includes(s.status)) continue;
    const target = s.status === 'MERGED' ? s.merged_into_id : s.id;
    if (!target) continue;
    const k = normalizeSupplierName(s.legal_name);
    byNorm.set(k, (byNorm.get(k) ?? new Set()).add(target));
  }
  for (const r of parsed.rows) {
    const issues = [...r.issues];
    const ids = r.name ? [...(byNorm.get(normalizeSupplierName(r.name)) ?? [])] : [];
    if (ids.length > 1) issues.push(`Ad birden çok tedarikçi kartıyla eşleşti (${ids.length}); kartı seçin.`);
    const supplierId = ids.length === 1 ? ids[0]! : null;
    await tx.query(`INSERT INTO risk_import_rows (tenant_id, batch_id, row_no, raw, supplier_id, decision, issues) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.tenantId, batchId, r.rowNo, r.raw, supplierId, supplierId ? 'CREATE' : 'SKIP', issues]);
  }
  const batch = await loadBatch(tx, batchId);
  await normalizeGroups(tx, batch);
  const view = await getImport(tx, ctx, batchId);
  await audit(tx, ctx, 'risk.import.previewed', 'risk_import_batch', batchId, {
    fileName, sha256: sha, period: parsed.period, year, fractionScale: parsed.fractionScale, ...view.summary, alreadyApplied: view.alreadyApplied });
  return view;
}

// ---- önizleme düzenleme ------------------------------------------------------------------------------------------------------------

export interface ImportPatch {
  year?: number;
  teamMapping?: Record<string, string | null>;
  rows?: { rowNo: number; decision?: 'CREATE' | 'SKIP' | 'NEW_CANDIDATE'; supplierId?: string | null; primary?: boolean }[];
}

export async function updateImport(tx: Tx, ctx: TenantContext, id: string, body: ImportPatch) {
  const b = await loadBatch(tx, id, true);
  if (b.status !== 'PREVIEW') throw conflict('not_preview', 'Uygulanmış ya da vazgeçilmiş içe aktarım değiştirilemez.');
  if (body.year !== undefined) {
    if (!Number.isInteger(body.year) || body.year < 2000 || body.year > 2100) throw unprocessable('invalid_year', 'Yıl 2000–2100 arasında olmalı.');
    await tx.query(`UPDATE risk_import_batches SET year = $2 WHERE id = $1`, [id, body.year]);
  }
  const rows = await loadRows(tx, id);
  if (body.teamMapping) {
    const teams = new Set(rows.map((r) => calcRow(r, b.fraction_scale).parsed.team).filter((t): t is string => !!t));
    const mapping = { ...b.team_mapping };
    const deps = new Set((await activeDepartments(tx)).map((d) => d.id));
    for (const [team, dep] of Object.entries(body.teamMapping)) {
      if (!teams.has(team)) throw unprocessable('unknown_team', `Dosyada olmayan ekip: ${team}`);
      if (dep !== null && !deps.has(dep)) throw unprocessable('invalid_department', `Departman bulunamadı: ${team}`);
      mapping[team] = dep;
    }
    await tx.query(`UPDATE risk_import_batches SET team_mapping = $2 WHERE id = $1`, [id, mapping]);
  }
  for (const p of body.rows ?? []) {
    const r = rows.find((x) => x.row_no === p.rowNo);
    if (!r) throw unprocessable('unknown_row', `Dosyada olmayan satır: ${p.rowNo}`);
    let supplierId = r.supplier_id;
    if (p.supplierId !== undefined) {
      if (p.supplierId === null) supplierId = null;
      else {
        const s = (await tx.query<{ id: string; status: string; merged_into_id: string | null }>(
          `SELECT id, status, merged_into_id FROM suppliers WHERE id = $1`, [p.supplierId])).rows[0];
        if (!s) throw unprocessable('invalid_supplier', `Tedarikçi kartı bulunamadı (satır ${p.rowNo}).`);
        if (UNUSABLE_SUPPLIER.includes(s.status) || (s.status === 'MERGED' && !s.merged_into_id)) {
          throw unprocessable('invalid_supplier', `Reddedilmiş kart seçilemez (satır ${p.rowNo}).`);
        }
        supplierId = s.status === 'MERGED' ? s.merged_into_id : s.id;
      }
    }
    let decision: ImportDecision = r.decision;
    if (p.decision !== undefined) decision = p.decision;
    else if (p.supplierId !== undefined) decision = supplierId ? 'CREATE' : 'SKIP';
    if (decision === 'NEW_CANDIDATE') {
      if (!calcRow(r, b.fraction_scale).parsed.name) throw unprocessable('name_required', `Adı boş satırdan aday kart açılamaz (satır ${p.rowNo}).`);
      supplierId = null;
    }
    if (decision === 'CREATE' && !supplierId) throw unprocessable('supplier_required', `Değerlendirme için tedarikçi kartı seçin (satır ${p.rowNo}).`);
    if (decision === 'MERGE') decision = supplierId ? 'CREATE' : 'NEW_CANDIDATE';
    const rc = calcRow(r, b.fraction_scale);
    const newKey = groupKey({ decision, supplier_id: supplierId }, rc);
    // Satır başka karta (gruba) taşındıysa eski birincil işareti yeni grubun birincilini çalmaz; açıkça istenmedikçe false.
    const groupChanged = newKey !== groupKey(r, rc);
    const primary = p.primary ?? (decision === 'SKIP' || groupChanged ? false : r.primary_row);
    if (primary) {
      // Aynı gruptaki diğer birincil işaretleri kalkar.
      const key = newKey;
      for (const o of rows) if (o.id !== r.id && o.primary_row && groupKey(o, calcRow(o, b.fraction_scale)) === key) {
        await tx.query(`UPDATE risk_import_rows SET primary_row = false WHERE id = $1`, [o.id]);
        o.primary_row = false;
      }
    }
    await tx.query(`UPDATE risk_import_rows SET supplier_id = $2, decision = $3, primary_row = $4 WHERE id = $1`, [r.id, supplierId, decision, primary && decision !== 'SKIP']);
    Object.assign(r, { supplier_id: supplierId, decision, primary_row: primary && decision !== 'SKIP' });
  }
  await normalizeGroups(tx, await loadBatch(tx, id));
  await audit(tx, ctx, 'risk.import.updated', 'risk_import_batch', id, {
    year: body.year ?? null, teams: Object.keys(body.teamMapping ?? {}).length, rows: (body.rows ?? []).map((r) => r.rowNo) });
  return getImport(tx, ctx, id);
}

export async function discardImport(tx: Tx, ctx: TenantContext, id: string) {
  const b = await loadBatch(tx, id, true);
  if (b.status !== 'PREVIEW') throw conflict('not_preview', 'Yalnız önizlemedeki içe aktarımdan vazgeçilir.');
  await tx.query(`UPDATE risk_import_batches SET status = 'DISCARDED' WHERE id = $1`, [id]);
  await audit(tx, ctx, 'risk.import.discarded', 'risk_import_batch', id, { fileName: b.file_name });
  return getImport(tx, ctx, id);
}

// ---- uygulama (R11; tek işlem) ------------------------------------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export async function applyImport(tx: Tx, ctx: TenantContext, id: string) {
  const b = await loadBatch(tx, id, true);
  if (b.status !== 'PREVIEW') throw conflict('not_preview', b.status === 'APPLIED' ? 'Bu içe aktarım zaten uygulandı.' : 'Vazgeçilmiş içe aktarım uygulanamaz.');
  if ((await tx.query(`SELECT 1 FROM risk_import_batches WHERE file_sha256 = $1 AND status = 'APPLIED'`, [b.file_sha256])).rowCount) {
    throw conflict('already_imported', 'Bu dosya daha önce içe aktarıldı; aynı dosya ikinci kez uygulanamaz.');
  }
  await normalizeGroups(tx, b);
  const rows = await loadRows(tx, id);
  const mixed = mixedScaleOf(rows.map((r) => r.raw));
  const calcs = new Map(rows.map((r) => [r.id, calcRow(r, b.fraction_scale, mixed)]));
  const today = istanbulToday();
  const dueDays = (await getRiskSettings(tx)).dueDays;
  const dueOn = (await tx.query<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [today, dueDays])).rows[0]!.d;
  const res = { created: 0, completed: 0, open: 0, completionBlocked: 0, skipped: 0, merged: 0, conflicts: 0, newCandidates: 0, actions: 0, needsDepartment: 0 };
  const rowResults: { rowNo: number; outcome: string; assessmentId: string | null; blockers?: { code: string; message: string }[] }[] = [];

  const groups = new Map<string, ImportRow[]>();
  for (const r of rows) {
    const key = groupKey(r, calcs.get(r.id)!);
    if (!key) { res.skipped++; rowResults.push({ rowNo: r.row_no, outcome: 'SKIP', assessmentId: null }); continue; }
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const list of groups.values()) {
    const primary = list.find((r) => r.primary_row)!;
    const others = list.filter((r) => r !== primary);
    const c = calcs.get(primary.id)!;
    const p = c.parsed;
    let supplierId = primary.supplier_id;
    let supplierName = primary.supplier_name ?? p.name ?? '';
    if (!supplierId) {
      // R11: VKN'siz aday kart + kimlik incelemesi (yalnız risk.import yetkilisi: Satınalma/Yönetici).
      supplierId = (await tx.query<{ id: string }>(
        `INSERT INTO suppliers (tenant_id, country, legal_name, identity_review_required, created_by) VALUES ($1,'TR',$2,true,$3) RETURNING id`,
        [ctx.tenantId, clip(p.name!, 300), ctx.userId])).rows[0]!.id;
      supplierName = p.name!;
      res.newCandidates++;
      await openTask(tx, ctx, { companyId: null, kind: 'SUPPLIER_IDENTITY_REVIEW', entityType: 'supplier', entityId: supplierId,
        title: 'Tedarikçi kimliği doğrulanmalı', reason: `Risk tablosu içe aktarımında (${b.file_name}, satır ${primary.row_no}) eşleşmeyen ad için aday kart açıldı; VKN yok.`,
        nextAction: 'Vergi kimliğini doğrulayın ya da kartı mevcut kayıtla birleştirin.', assigneeRole: 'PROCUREMENT', dedupeKey: `supplier:${supplierId}:identity` });
      await audit(tx, ctx, 'supplier.candidate.created_from_risk_import', 'supplier', supplierId, { batchId: id, rowNo: primary.row_no });
      for (const r of list) await tx.query(`UPDATE risk_import_rows SET supplier_id = $2 WHERE id = $1`, [r.id, supplierId]);
    }
    const services = [...new Set([primary, ...others].map((r) => calcs.get(r.id)!.parsed.services).filter((s): s is string => !!s))];
    const departmentId = p.team ? (b.team_mapping[p.team] ?? null) : null;
    const complete = willComplete(c);
    // Karar 8: K'de "aksiyon planı yok" sonrası yorum aksiyon üretmez; Excel notu olarak taslakta görünür, tamamlanan revizyonda score_note'a gider.
    const notes = [...new Set(list.map((r) => calcs.get(r.id)!.parsed.commentNote).filter((n): n is string => !!n))];
    const excelNote = notes.length ? `Excel notu: ${notes.join(' | ')}` : null;
    const draft: RiskDraft = { criteria: { ...p.criteria }, importScore: p.riskScore, ...(excelNote ? { importNote: clip(excelNote, 2000) } : {}) };
    const assessmentId = (await tx.query<{ id: string }>(
      `INSERT INTO risk_assessments (tenant_id, supplier_id, year, department_id, responsible_team, services, source, due_on, draft, opened_by)
       VALUES ($1,$2,$3,$4,$5,$6,'IMPORT',$7,$8,$9) ON CONFLICT (tenant_id, supplier_id, year) DO NOTHING RETURNING id`,
      [ctx.tenantId, supplierId, b.year, departmentId, p.team ? clip(p.team, 200) : null, services.length ? clip(services.join('; '), 4000) : null,
        complete ? null : dueOn, draft, ctx.userId])).rows[0]?.id ?? null;
    if (!assessmentId) {
      // Mevcut (tedarikçi, yıl) değerlendirmesinin üzerine yazılmaz.
      res.conflicts += list.length;
      for (const r of list) rowResults.push({ rowNo: r.row_no, outcome: 'CONFLICT', assessmentId: null });
      continue;
    }
    res.created++;
    res.merged += others.length;
    // K metni: "aksiyon planı yok" kalıbı aksiyon üretmez; diğer metin sahipsiz/tarihsiz MITIGATION (birleşen satırlarınki dahil).
    for (const r of list) {
      const text = calcs.get(r.id)!.parsed.actionText;
      if (!text || NO_ACTION_RE.test(text) || text.trim().length < 2) continue;
      await tx.query(`INSERT INTO risk_actions (tenant_id, assessment_id, kind, title, description, source, created_by) VALUES ($1,$2,'MITIGATION',$3,$4,'IMPORT',$5)`,
        [ctx.tenantId, assessmentId, clip(text.trim(), 500), text.length > 500 ? clip(text, 4000) : null, ctx.userId]);
      res.actions++;
    }
    if (complete) {
      const crit = c.criticality!, lv = c.level!;
      await tx.query(
        `INSERT INTO risk_assessment_revisions (tenant_id, assessment_id, revision_no, criteria, criticality, criticality_column, answers, score_source,
           risk_score, score_note, level, method_version, changed_fields, created_by)
         VALUES ($1,$2,1,$3,$4,$5,'{}','IMPORT',$6,$7,$8,$9,'{}',$10)`,
        [ctx.tenantId, assessmentId, p.criteria, crit.value, crit.column, p.riskScore,
          clip(`Excel içe aktarımı: ${clip(b.file_name, 200)}, satır ${primary.row_no}${excelNote ? `. ${excelNote}` : ''}`, 2000),
          lv.level, RISK_METHOD_VERSION, ctx.userId]);
      await tx.query(`UPDATE risk_assessments SET status = 'COMPLETED', completed_at = now(), completed_by = $2 WHERE id = $1`, [assessmentId, ctx.userId]);
      res.completed++;
      rowResults.push({ rowNo: primary.row_no, outcome: 'COMPLETED', assessmentId });
    } else {
      res.open++;
      let blockers: { code: string; message: string }[] | undefined;
      if (c.level && c.level.level >= 4) {
        res.completionBlocked++;
        const actions = (await tx.query<{ kind: 'MITIGATION' | 'CONTROL'; owner_user_id: string | null; due_on: string | null; status: string }>(
          `SELECT kind, owner_user_id, due_on::text AS due_on, status FROM risk_actions WHERE assessment_id = $1`, [assessmentId])).rows;
        blockers = completionBlockers({ criteria: p.criteria, score: p.riskScore, level: c.level.level, today,
          actions: actions.map((x) => ({ kind: x.kind, ownerUserId: x.owner_user_id, dueOn: x.due_on, status: x.status })) });
      }
      if (departmentId) await openDueTask(tx, ctx, { id: assessmentId, supplierName, year: b.year, dueOn });
      rowResults.push({ rowNo: primary.row_no, outcome: blockers ? 'completion_blocked' : 'OPEN', assessmentId, ...(blockers ? { blockers } : {}) });
    }
    // M2: departmansız her değerlendirme (tamamlanmış dahil) Satınalma'ya "Sorumlu departmanı seçin" görevi açar.
    if (!departmentId) {
      res.needsDepartment++;
      await openTask(tx, ctx, { companyId: null, kind: RISK_TASKS.department, entityType: 'risk_assessment', entityId: assessmentId, departmentId: null,
        title: `Sorumlu departmanı seçin: ${supplierName} (${b.year})`,
        reason: 'İçe aktarılan risk tablosu satırının ekibi bir departmana eşlenmedi.',
        nextAction: 'Değerlendirmeyi açıp sorumlu departmanı seçin.', assigneeRole: 'PROCUREMENT', dedupeKey: `risk:${assessmentId}:department` });
    }
    for (const r of others) rowResults.push({ rowNo: r.row_no, outcome: 'MERGE', assessmentId });
    for (const r of list) await tx.query(`UPDATE risk_import_rows SET assessment_id = $2 WHERE id = $1`, [r.id, assessmentId]);
    await audit(tx, ctx, 'risk.assessment.opened', 'risk_assessment', assessmentId, {
      supplierId, year: b.year, departmentId, source: 'IMPORT', batchId: id, rowNos: list.map((r) => r.row_no), status: complete ? 'COMPLETED' : 'OPEN',
      level: c.level?.level ?? null });
  }
  rowResults.sort((a, b2) => a.rowNo - b2.rowNo);
  try {
    await tx.query(`UPDATE risk_import_batches SET status = 'APPLIED', summary = $2, applied_by = $3, applied_at = now() WHERE id = $1`,
      [id, { ...res, rowOutcomes: Object.fromEntries(rowResults.map((x) => [String(x.rowNo), x.outcome === 'completion_blocked' ? 'OPEN' : x.outcome])) }, ctx.userId]);
  } catch (e) {
    // M1: aynı dosyanın eşzamanlı ikinci uygulaması tekillik dizinine çarpar → genel "duplicate" yerine already_imported.
    if ((e as { code?: string; constraint?: string }).code === '23505' && (e as { constraint?: string }).constraint === 'risk_import_batches_applied_once') {
      throw conflict('already_imported', 'Bu dosya daha önce içe aktarıldı; aynı dosya ikinci kez uygulanamaz.');
    }
    throw e;
  }
  await audit(tx, ctx, 'risk.import.applied', 'risk_import_batch', id, { fileName: b.file_name, year: b.year, ...res });
  return { ...(await getImport(tx, ctx, id)), result: res, rowResults };
}

// ---- dışa aktarım (R12) -------------------------------------------------------------------------------------------------------------

export function exportFileName(period: string) {
  return `BT Tedarikçi Risk Değerlendirme Tablosu ${period}.xlsx`;
}

/** Görünen (RLS) iptal edilmemiş değerlendirmeler: tamamlanmışta son revizyon, açıkta taslağın hesabı; boş alan boş hücre. */
export async function exportRisk(tx: Tx, ctx: TenantContext, q: { year?: number; period?: string }) {
  const today = istanbulToday();
  const year = q.year ?? Number(today.slice(0, 4));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw unprocessable('invalid_year', 'Yıl 2000–2100 arasında olmalı.');
  const period = q.period ?? (year === Number(today.slice(0, 4)) ? riskPeriod(today) : `${year}-4`);
  if (!/^\d{4}-[1-4]$/.test(period)) throw unprocessable('invalid_period', 'Dönem YYYY-Ç biçiminde olmalı (ör. 2026-1).');
  const list = (await tx.query<{
    id: string; supplier_name: string; status: string; services: string | null; responsible_team: string | null; department_name: string | null; draft: RiskDraft;
    criteria: Record<string, number> | null; criticality: string | null; criticality_column: number | null; risk_score: string | null; level: number | null;
    score_source: ScoreSource | null; method_version: string | null; review_period: string | null; review_outcome: string | null;
  }>(
    `SELECT a.id, s.legal_name AS supplier_name, a.status, a.services, a.responsible_team, d.name AS department_name, a.draft,
       r.criteria, r.criticality::text AS criticality, r.criticality_column, to_char(r.risk_score, 'FM990.00') AS risk_score, r.level, r.score_source, r.method_version,
       v.period AS review_period, v.outcome AS review_outcome
     FROM risk_assessments a JOIN suppliers s ON s.id = a.supplier_id LEFT JOIN departments d ON d.id = a.department_id
     LEFT JOIN LATERAL (SELECT * FROM risk_assessment_revisions r WHERE r.assessment_id = a.id ORDER BY r.revision_no DESC LIMIT 1) r ON true
     LEFT JOIN LATERAL (SELECT period, outcome FROM risk_reviews v WHERE v.assessment_id = a.id ORDER BY v.period DESC LIMIT 1) v ON true
     WHERE a.year = $1 AND a.status <> 'CANCELLED' ORDER BY s.legal_name, a.id`, [year])).rows;
  const ids = list.map((a) => a.id);
  const actions = ids.length ? (await tx.query<{ assessment_id: string; kind: string; control_method: keyof typeof CONTROL_METHOD_TR | null; title: string;
      owner_name: string | null; owner_text: string | null; due_on: string | null; status: string }>(
    `SELECT x.assessment_id, x.kind, x.control_method, x.title, u.display_name AS owner_name, x.owner_text, x.due_on::text AS due_on, x.status
     FROM risk_actions x LEFT JOIN users u ON u.id = x.owner_user_id
     WHERE x.assessment_id = ANY($1::uuid[]) AND x.status <> 'CANCELLED' ORDER BY x.created_at, x.id`, [ids])).rows : [];

  const rows: RiskExportRow[] = [];
  for (const a of list) {
    let criteria: Record<string, number> | null, crit: string | null, column: number | null, score: string | null, level: number | null, source: ScoreSource | null;
    if (a.status === 'COMPLETED' && a.criteria) {
      criteria = a.criteria; crit = a.criticality; column = a.criticality_column; score = a.risk_score; level = a.level; source = a.score_source;
    } else {
      const c = await compute(tx, a.draft ?? {});
      criteria = (a.draft?.criteria ?? null) as Record<string, number> | null;
      crit = c.criticality?.value ?? null; column = c.criticality?.column ?? null; score = c.score?.value ?? null; level = c.level?.level ?? null;
      source = c.score?.value ? c.score.source : null;
    }
    const acts = actions.filter((x) => x.assessment_id === a.id);
    rows.push({
      name: a.supplier_name, services: a.services, criteria: criteria as RiskExportRow['criteria'], riskScore: score,
      actionTitles: acts.map((x) => x.title), team: a.responsible_team ?? a.department_name,
      detail: {
        year, department: a.department_name, criticality: crit, column, level, levelLabel: level ? RISK_LEVEL_TR[level as RiskLevelNo] : null,
        status: ASSESSMENT_STATUS_TR[a.status] ?? a.status, scoreSource: source ? SCORE_SOURCE_TR[source] : null,
        lastReview: a.review_period ? `${a.review_period} · ${REVIEW_TR[a.review_outcome ?? ''] ?? a.review_outcome}` : null,
        actions: acts.map((x) => ({ kind: x.kind, title: x.title, owner: x.owner_name ?? x.owner_text, dueOn: x.due_on, status: ACTION_STATUS_TR[x.status] ?? x.status,
          method: x.control_method ? CONTROL_METHOD_TR[x.control_method] : null })),
        methodVersion: a.status === 'COMPLETED' ? a.method_version : null,
      },
    });
  }
  const buf = await riskTableWorkbook({ period, year, rows });
  await audit(tx, ctx, 'risk.exported', 'risk_export', null, { year, period, rows: rows.length });
  return { buf, fileName: exportFileName(period), year, period, rows: rows.length };
}
