import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { conflict, notFound, unprocessable } from '../errors.ts';

/**
 * v2 Faz 6 (R3, R4) Görev 3: risk soru setleri ve kiracı ayarı. Uygulama soru içermeden gelir (kurumun şablonu verilmedi);
 * yönetici sürümlü set tanımlar: yeni sürüm DRAFT doğar, yayımlanınca değişmez, aynı kodun önceki yayımı RETIRED olur.
 * Ağırlık decimal string (2 hane). Ayar: görev son tarihi gün sayısı (7–365, varsayılan 90).
 */

export const DEFAULT_DUE_DAYS = 90;

export interface QuestionInput { code: string; text: string; weight: string | number; riskAnswer?: 'YES' | 'NO'; guidance?: string | null }
export interface QuestionSetInput { code: string; name: string; scopeNote?: string | null; questions: QuestionInput[] }

interface SetRow {
  id: string; code: string; version: number; name: string; scope_note: string | null; status: string;
  created_by: string; created_at: Date; published_by: string | null; published_at: Date | null; question_count: number; total_weight: string;
}
const setView = (r: SetRow) => ({
  id: r.id, code: r.code, version: r.version, name: r.name, scopeNote: r.scope_note, status: r.status,
  questionCount: r.question_count, totalWeight: r.total_weight,
  createdBy: r.created_by, createdAt: r.created_at, publishedBy: r.published_by, publishedAt: r.published_at,
});

const SET_SELECT = `SELECT s.id, s.code, s.version, s.name, s.scope_note, s.status, s.created_by, s.created_at, s.published_by, s.published_at,
    (SELECT count(*)::int FROM risk_questions q WHERE q.set_id = s.id) AS question_count,
    (SELECT to_char(coalesce(sum(q.weight), 0), 'FM999999990.00') FROM risk_questions q WHERE q.set_id = s.id) AS total_weight
  FROM risk_question_sets s`;

export async function listSets(tx: Tx) {
  const rows = (await tx.query<SetRow>(`${SET_SELECT} ORDER BY s.code, s.version DESC`)).rows;
  return { items: rows.map(setView) };
}

export async function getSet(tx: Tx, id: string) {
  const s = (await tx.query<SetRow>(`${SET_SELECT} WHERE s.id = $1`, [id])).rows[0];
  if (!s) throw notFound();
  const qs = (await tx.query<{ id: string; ordinal: number; code: string; text: string; weight: string; risk_answer: 'YES' | 'NO'; guidance: string | null }>(
    `SELECT id, ordinal, code, text, to_char(weight, 'FM999999990.00') AS weight, risk_answer, guidance FROM risk_questions WHERE set_id = $1 ORDER BY ordinal`, [id])).rows;
  return { ...setView(s), questions: qs.map((q) => ({ id: q.id, ordinal: q.ordinal, code: q.code, text: q.text, weight: q.weight, riskAnswer: q.risk_answer, guidance: q.guidance })) };
}

/** "12", "12.5", 12.5 → "12.50"; geçersiz ya da ≤ 0 → null. En çok 2 ondalık, 6 tam hane (numeric(8,2)). */
function weightString(v: unknown): string | null {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const out = `${m[1]}.${(m[2] ?? '').padEnd(2, '0')}`;
  return Number(out) > 0 ? out : null;
}

export async function createSet(tx: Tx, ctx: TenantContext, input: QuestionSetInput) {
  const code = (input.code ?? '').trim(), name = (input.name ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(code)) throw unprocessable('validation_failed', 'Set kodu 2-40 karakter (harf, rakam, _ . -) olmalı.');
  if (name.length < 2 || name.length > 200) throw unprocessable('validation_failed', 'Set adı 2-200 karakter olmalı.');
  const scopeNote = input.scopeNote?.trim() || null;
  if (scopeNote && scopeNote.length > 2000) throw unprocessable('validation_failed', 'Kapsam notu en çok 2000 karakter olmalı.');
  if (!Array.isArray(input.questions) || input.questions.length === 0) throw unprocessable('questions_required', 'Soru seti en az bir soru içermeli.');
  const seen = new Set<string>();
  const qs = input.questions.map((q, i) => {
    const qc = (q.code ?? '').trim(), text = (q.text ?? '').trim();
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(qc)) throw unprocessable('validation_failed', `Soru ${i + 1}: kod 1-40 karakter (harf, rakam, _ . -) olmalı.`);
    if (seen.has(qc)) throw unprocessable('duplicate_question_code', `Soru kodu tekrar ediyor: ${qc}`);
    seen.add(qc);
    if (text.length < 3 || text.length > 2000) throw unprocessable('validation_failed', `Soru ${qc}: metin 3-2000 karakter olmalı.`);
    const weight = weightString(q.weight);
    if (!weight) throw unprocessable('invalid_weight', `Soru ${qc}: ağırlık sıfırdan büyük, en çok 2 ondalıklı bir sayı olmalı.`);
    const ra = q.riskAnswer ?? 'YES';
    if (ra !== 'YES' && ra !== 'NO') throw unprocessable('validation_failed', `Soru ${qc}: riskli cevap YES ya da NO olmalı.`);
    const guidance = q.guidance?.trim() || null;
    if (guidance && guidance.length > 2000) throw unprocessable('validation_failed', `Soru ${qc}: açıklama en çok 2000 karakter olmalı.`);
    return { code: qc, text, weight, riskAnswer: ra, guidance };
  });

  // Aynı koda eşzamanlı sürüm açılışı sıralanır.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`risk_qset:${ctx.tenantId}:${code}`]);
  const version = (await tx.query<{ v: number }>(`SELECT coalesce(max(version), 0) + 1 AS v FROM risk_question_sets WHERE code = $1`, [code])).rows[0]!.v;
  const id = (await tx.query<{ id: string }>(
    `INSERT INTO risk_question_sets (tenant_id, code, version, name, scope_note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, code, version, name, scopeNote, ctx.userId])).rows[0]!.id;
  for (const [i, q] of qs.entries()) {
    await tx.query(`INSERT INTO risk_questions (tenant_id, set_id, ordinal, code, text, weight, risk_answer, guidance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.tenantId, id, i + 1, q.code, q.text, q.weight, q.riskAnswer, q.guidance]);
  }
  await audit(tx, ctx, 'risk.questions.created', 'risk_question_set', id, { code, version, questionCount: qs.length });
  return getSet(tx, id);
}

export async function publishSet(tx: Tx, ctx: TenantContext, id: string) {
  const s = (await tx.query<{ code: string; version: number; status: string }>(`SELECT code, version, status FROM risk_question_sets WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!s) throw notFound();
  if (s.status !== 'DRAFT') throw conflict('not_draft', 'Yalnız taslak set yayımlanır; yayımlanmış ya da emekli set değişmez.');
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`risk_qset:${ctx.tenantId}:${s.code}`]);
  const q = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM risk_questions WHERE set_id = $1`, [id])).rows[0]!.n;
  if (q === 0) throw unprocessable('questions_required', 'Soru seti en az bir soru içermeli.');
  const retired = (await tx.query<{ id: string; version: number }>(
    `UPDATE risk_question_sets SET status = 'RETIRED' WHERE code = $1 AND status = 'PUBLISHED' AND id <> $2 RETURNING id, version`, [s.code, id])).rows;
  await tx.query(`UPDATE risk_question_sets SET status = 'PUBLISHED', published_by = $2, published_at = now() WHERE id = $1`, [id, ctx.userId]);
  await audit(tx, ctx, 'risk.questions.published', 'risk_question_set', id, { code: s.code, version: s.version, retiredVersions: retired.map((r) => r.version) });
  return getSet(tx, id);
}

export async function getRiskSettings(tx: Tx) {
  const r = (await tx.query<{ due_days: number; updated_at: Date; updated_by: string | null }>(`SELECT due_days, updated_at, updated_by FROM risk_settings`)).rows[0];
  return { dueDays: r?.due_days ?? DEFAULT_DUE_DAYS, defaultDueDays: DEFAULT_DUE_DAYS, isDefault: !r, updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
}

export async function putRiskSettings(tx: Tx, ctx: TenantContext, body: { dueDays: unknown }) {
  const d = body.dueDays;
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 7 || d > 365) throw unprocessable('invalid_due_days', 'Son tarih süresi 7–365 gün arasında bir tam sayı olmalı.');
  const before = (await getRiskSettings(tx)).dueDays;
  await tx.query(`INSERT INTO risk_settings (tenant_id, due_days, updated_by, updated_at) VALUES ($1,$2,$3,now())
    ON CONFLICT (tenant_id) DO UPDATE SET due_days = EXCLUDED.due_days, updated_by = EXCLUDED.updated_by, updated_at = now()`, [ctx.tenantId, d, ctx.userId]);
  await audit(tx, ctx, 'risk.settings.updated', 'tenant', ctx.tenantId, { before, after: d });
  return getRiskSettings(tx);
}
