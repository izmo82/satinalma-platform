import {
  can, completionBlockers, changedFields, criticality, criticalityDisplay, RISK_BAND_LABEL, RISK_CRITERIA, RISK_LEVEL_TR, RISK_MATRIX,
  normalizeRoles, RISK_METHOD_VERSION, riskBand, riskLevel, riskPeriod, riskScore,
  type CriteriaValues, type MatrixColumn, type RiskAnswer, type RiskCriterion, type RiskLevelNo,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { closeTasks, openTask, rederiveTaskDepartments, RISK_TASKS } from '../tasks.ts';
import { getRiskSettings } from './riskQuestions.ts';

/**
 * v2 Faz 6 (D111) Görev 4: yıllık risk değerlendirmesi API'si — taslak (R4/R8), tamamlama (R9, değişmez revizyon), aksiyon/kontrol,
 * görüş (R5 katkıcı), sorumlu departman seçimi, çeyreklik gözden geçirme (R10), matris, liste, tedarikçi geçmişi, portal (R13).
 * Kritiklik/skor/seviye her okumada domain riskV2 ile hesaplanır; AI çağrılmaz. Görünürlük RLS'tedir (054/054a): departman kullanıcısı
 * kendi departmanının ve (yalnız okuma + görüş) katkıcı olduğu değerlendirmeleri görür; tedarikçi oturumu yalnız app_portal_risk() ile okur.
 * Taslak cevapları soru KODU ile tutulur (R8: yıllar arası kod eşleşmesi); revizyon da aynı biçimde saklar.
 */

export type ScoreSource = 'QUESTIONS' | 'MANUAL_RESULT' | 'IMPORT';
export interface RiskDraft {
  criteria?: Partial<Record<RiskCriterion, number>>;
  questionSetId?: string | null;
  answers?: Record<string, RiskAnswer>;
  manualScore?: string | null;
  manualNote?: string | null;
  /** İçe aktarımın (T6) Excel J değeri (0–100); kaynak IMPORT. */
  importScore?: string | null;
  /** R10 "Güncelle" ile yeniden açılan kaydın dönemi; tamamlanınca UPDATED gözden geçirmesi yazılır. */
  reviewPeriod?: string | null;
}
export const SCORE_SOURCE_TR: Record<ScoreSource, string> = { QUESTIONS: 'Soru seti', MANUAL_RESULT: 'Elle girilen şablon sonucu', IMPORT: 'Excel içe aktarımı' };
export const CONTROL_METHOD_TR = { ON_SITE: 'Yerinde', ONLINE: 'Online', DESK: 'Kanıt kontrolü – masabaşı' } as const;

export const istanbulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

interface AssessmentRow {
  id: string; supplier_id: string; supplier_name: string; year: number; department_id: string | null; department_name: string | null;
  responsible_team: string | null; services: string | null; status: 'OPEN' | 'COMPLETED' | 'CANCELLED'; source: string; due_on: string | null;
  draft: RiskDraft; prior_assessment_id: string | null; opened_at: Date; completed_at: Date | null; completed_by: string | null;
}
const A_SELECT = `SELECT a.id, a.supplier_id, s.legal_name AS supplier_name, a.year, a.department_id, d.name AS department_name, a.responsible_team,
    a.services, a.status, a.source, a.due_on::text AS due_on, a.draft, a.prior_assessment_id, a.opened_at, a.completed_at, a.completed_by
  FROM risk_assessments a JOIN suppliers s ON s.id = a.supplier_id LEFT JOIN departments d ON d.id = a.department_id`;

interface RevisionRow {
  id: string; revision_no: number; criteria: Record<string, number>; criticality: string; criticality_column: number; question_set_id: string | null;
  answers: Record<string, RiskAnswer>; score_source: ScoreSource; risk_score: string; score_note: string | null; level: number; method_version: string;
  changed_fields: string[]; created_by: string; created_by_name: string | null; created_at: Date;
}
const R_SELECT = `SELECT r.id, r.revision_no, r.criteria, r.criticality::text AS criticality, r.criticality_column, r.question_set_id, r.answers, r.score_source,
    to_char(r.risk_score, 'FM990.00') AS risk_score, r.score_note, r.level, r.method_version, r.changed_fields, r.created_by, u.display_name AS created_by_name, r.created_at
  FROM risk_assessment_revisions r LEFT JOIN users u ON u.id = r.created_by`;
const revisionView = (r: RevisionRow) => ({
  id: r.id, revisionNo: r.revision_no, criteria: r.criteria, criticality: r.criticality, criticalityDisplay: criticalityDisplay(r.criticality),
  column: r.criticality_column, questionSetId: r.question_set_id, answers: r.answers, scoreSource: r.score_source, scoreSourceLabel: SCORE_SOURCE_TR[r.score_source],
  riskScore: r.risk_score, scoreNote: r.score_note, level: r.level, levelLabel: RISK_LEVEL_TR[r.level as RiskLevelNo], band: riskBand(r.risk_score),
  methodVersion: r.method_version, changedFields: r.changed_fields, createdBy: { id: r.created_by, displayName: r.created_by_name }, createdAt: r.created_at,
});

interface ActionRow {
  id: string; assessment_id: string; kind: 'MITIGATION' | 'CONTROL'; control_method: keyof typeof CONTROL_METHOD_TR | null; title: string; description: string | null;
  owner_user_id: string | null; owner_name: string | null; owner_text: string | null; due_on: string | null; supplier_visible: boolean; status: string;
  completed_at: Date | null; completed_by: string | null; completion_note: string | null; source: string; created_at: Date;
}
const X_SELECT = `SELECT x.id, x.assessment_id, x.kind, x.control_method, x.title, x.description, x.owner_user_id, u.display_name AS owner_name, x.owner_text,
    x.due_on::text AS due_on, x.supplier_visible, x.status, x.completed_at, x.completed_by, x.completion_note, x.source, x.created_at
  FROM risk_actions x LEFT JOIN users u ON u.id = x.owner_user_id`;
const actionView = (x: ActionRow) => ({
  id: x.id, assessmentId: x.assessment_id, kind: x.kind, controlMethod: x.control_method, controlMethodLabel: x.control_method ? CONTROL_METHOD_TR[x.control_method] : null,
  title: x.title, description: x.description, owner: x.owner_user_id ? { id: x.owner_user_id, displayName: x.owner_name } : null, ownerText: x.owner_text,
  dueOn: x.due_on, supplierVisible: x.supplier_visible, status: x.status, completedAt: x.completed_at, completedBy: x.completed_by,
  completionNote: x.completion_note, source: x.source, createdAt: x.created_at,
});

const isProcurement = (ctx: TenantContext) => ctx.roles.includes('PROCUREMENT');
/** Sorumlu: kaydın departmanı kullanıcının departmanlarından biri ya da Satınalma (tüm departmanlar). */
const isResponsible = (ctx: TenantContext, a: { department_id: string | null }) =>
  isProcurement(ctx) || (a.department_id !== null && ctx.departmentIds.includes(a.department_id));
const canEdit = (ctx: TenantContext, a: { department_id: string | null }) => can(ctx.roles, 'risk.assess') && isResponsible(ctx, a);

async function loadAssessment(tx: Tx, id: string, lock = false): Promise<AssessmentRow> {
  const a = (await tx.query<AssessmentRow>(`${A_SELECT} WHERE a.id = $1${lock ? ' FOR UPDATE OF a' : ''}`, [id])).rows[0];
  if (!a) throw notFound();
  return a;
}
/** Yazma: önce görünürlük (404), sonra yetki (katkıcı ya da denetçi 403), sonra satır kilidi. */
async function loadForEdit(tx: Tx, ctx: TenantContext, id: string): Promise<AssessmentRow> {
  const a = await loadAssessment(tx, id);
  if (!canEdit(ctx, a)) throw new ApiError(403, 'not_responsible', 'Bu değerlendirmeyi yalnız sorumlu departman ya da Satınalma düzenler; görüş ekleyebilirsiniz.');
  return loadAssessment(tx, id, true);
}

// ---- hesap ----------------------------------------------------------------------------------------------------------------------

const isCriterion = (k: string): k is RiskCriterion => (RISK_CRITERIA as readonly string[]).includes(k);
const fullCriteria = (c: RiskDraft['criteria']): CriteriaValues | null =>
  c && RISK_CRITERIA.every((k) => c[k] === 1 || c[k] === 3 || c[k] === 5) ? (c as CriteriaValues) : null;

interface SetQuestion { id: string; code: string; text: string; weight: string; riskAnswer: RiskAnswer; guidance: string | null; ordinal: number }
interface SetInfo { id: string; code: string; version: number; name: string; scopeNote: string | null; status: string; questions: SetQuestion[] }
async function loadSet(tx: Tx, id: string): Promise<SetInfo | null> {
  const s = (await tx.query<{ id: string; code: string; version: number; name: string; scope_note: string | null; status: string }>(
    `SELECT id, code, version, name, scope_note, status FROM risk_question_sets WHERE id = $1`, [id])).rows[0];
  if (!s) return null;
  const qs = (await tx.query<{ id: string; code: string; text: string; weight: string; risk_answer: RiskAnswer; guidance: string | null; ordinal: number }>(
    `SELECT id, code, text, to_char(weight, 'FM999999990.00') AS weight, risk_answer, guidance, ordinal FROM risk_questions WHERE set_id = $1 ORDER BY ordinal`, [id])).rows;
  return { id: s.id, code: s.code, version: s.version, name: s.name, scopeNote: s.scope_note, status: s.status,
    questions: qs.map((q) => ({ id: q.id, code: q.code, text: q.text, weight: q.weight, riskAnswer: q.risk_answer, guidance: q.guidance, ordinal: q.ordinal })) };
}
async function publishedSets(tx: Tx) {
  return (await tx.query<{ id: string; code: string; version: number; name: string; scope_note: string | null; question_count: number }>(
    `SELECT s.id, s.code, s.version, s.name, s.scope_note, (SELECT count(*)::int FROM risk_questions q WHERE q.set_id = s.id) AS question_count
     FROM risk_question_sets s WHERE s.status = 'PUBLISHED' ORDER BY s.code`)).rows
    .map((s) => ({ id: s.id, code: s.code, version: s.version, name: s.name, scopeNote: s.scope_note, questionCount: s.question_count }));
}

export interface Computed {
  criticality: { value: string; display: string; column: MatrixColumn } | null;
  score: { value: string | null; source: ScoreSource; missing: string[] } | null;
  level: { level: RiskLevelNo; band: RiskLevelNo; bandLabel: string; label: string } | null;
}
async function compute(tx: Tx, draft: RiskDraft, set?: SetInfo | null): Promise<Computed & { set: SetInfo | null }> {
  const full = fullCriteria(draft.criteria);
  const crit = full ? criticality(full) : null;
  let score: Computed['score'] = null;
  const s = draft.questionSetId ? (set !== undefined ? set : await loadSet(tx, draft.questionSetId)) : null;
  if (s) {
    const r = riskScore(s.questions.map((q) => ({ id: q.code, code: q.code, weight: q.weight, riskAnswer: q.riskAnswer })), draft.answers ?? {});
    score = { value: r.score, source: 'QUESTIONS', missing: r.missing };
  } else if (draft.manualScore != null) score = { value: draft.manualScore, source: 'MANUAL_RESULT', missing: [] };
  else if (draft.importScore != null) score = { value: draft.importScore, source: 'IMPORT', missing: [] };
  const lv = crit && score?.value ? riskLevel(score.value, crit.column) : null;
  return { criticality: crit, score, set: s,
    level: lv ? { level: lv.level, band: lv.band, bandLabel: RISK_BAND_LABEL[lv.band], label: RISK_LEVEL_TR[lv.level] } : null };
}

const flat = (criteria: Record<string, unknown> | undefined, answers: Record<string, unknown> | undefined, score: string | null | undefined) => {
  const o: Record<string, unknown> = {};
  for (const k of RISK_CRITERIA) o[`criteria.${k}`] = criteria?.[k] ?? null;
  for (const [k, v] of Object.entries(answers ?? {})) o[`answers.${k}`] = v;
  o.riskScore = score ?? null;
  return o;
};

async function actionsOf(tx: Tx, assessmentId: string) {
  return (await tx.query<ActionRow>(`${X_SELECT} WHERE x.assessment_id = $1 ORDER BY x.created_at, x.id`, [assessmentId])).rows;
}
async function latestRevision(tx: Tx, assessmentId: string) {
  return (await tx.query<RevisionRow>(`${R_SELECT} WHERE r.assessment_id = $1 ORDER BY r.revision_no DESC LIMIT 1`, [assessmentId])).rows[0] ?? null;
}
/** R8: önceki yılın son revizyonu (prior_assessment_id; yoksa aynı tedarikçinin daha eski en yeni revizyonlu yılı). */
async function priorOf(tx: Tx, a: AssessmentRow) {
  const p = (await tx.query<{ id: string; year: number }>(
    a.prior_assessment_id
      ? `SELECT id, year FROM risk_assessments WHERE id = $1`
      : `SELECT a.id, a.year FROM risk_assessments a WHERE a.supplier_id = $1 AND a.year < $2
           AND EXISTS (SELECT 1 FROM risk_assessment_revisions r WHERE r.assessment_id = a.id) ORDER BY a.year DESC LIMIT 1`,
    a.prior_assessment_id ? [a.prior_assessment_id] : [a.supplier_id, a.year])).rows[0];
  if (!p) return null;
  const rev = await latestRevision(tx, p.id);
  return rev ? { year: p.year, assessmentId: p.id, revision: rev } : null;
}

function blockersFor(c: Computed, draft: RiskDraft, actions: ActionRow[], today: string, publishedCount: number) {
  const out = completionBlockers({
    criteria: (draft.criteria ?? {}) as Partial<CriteriaValues>, score: c.score?.value ?? null, level: c.level?.level ?? null, today,
    actions: actions.map((x) => ({ kind: x.kind, ownerUserId: x.owner_user_id, dueOn: x.due_on, status: x.status })),
  });
  if (c.score?.source === 'MANUAL_RESULT') {
    if (publishedCount > 0) out.push({ code: 'questions_available', message: 'Yayımlanmış soru seti var; elle sonuç yerine soruları cevaplayın.' });
    if (!draft.manualNote?.trim()) out.push({ code: 'manual_note_required', message: 'Elle girilen sonuç için dayanak notu zorunludur.' });
  }
  return out;
}

// ---- okuma ----------------------------------------------------------------------------------------------------------------------

export async function getAssessment(tx: Tx, ctx: TenantContext, id: string) {
  const a = await loadAssessment(tx, id);
  const draft = a.draft ?? {};
  const today = istanbulToday();
  // pg istemcisi tek bağlantıda sorguları sıralar; paralel çağrı yerine sırayla.
  const c = await compute(tx, draft);
  const actions = await actionsOf(tx, id);
  const revisions = (await tx.query<RevisionRow>(`${R_SELECT} WHERE r.assessment_id = $1 ORDER BY r.revision_no DESC`, [id])).rows;
  const opinions = (await tx.query<{ id: string; department_id: string | null; department_name: string | null; author_id: string; author_name: string | null; body: string; created_at: Date }>(
      `SELECT o.id, o.department_id, d.name AS department_name, o.author_id, u.display_name AS author_name, o.body, o.created_at
       FROM risk_opinions o LEFT JOIN departments d ON d.id = o.department_id LEFT JOIN users u ON u.id = o.author_id
       WHERE o.assessment_id = $1 ORDER BY o.created_at, o.id`, [id])).rows;
  const reviews = (await tx.query<{ id: string; period: string; outcome: string; revision_id: string | null; decided_by: string; decided_by_name: string | null; decided_at: Date }>(
      `SELECT v.id, v.period, v.outcome, v.revision_id, v.decided_by, u.display_name AS decided_by_name, v.decided_at
       FROM risk_reviews v LEFT JOIN users u ON u.id = v.decided_by WHERE v.assessment_id = $1 ORDER BY v.period DESC`, [id])).rows;
  const prior = await priorOf(tx, a);
  const sets = await publishedSets(tx);
  const responsible = isResponsible(ctx, a);
  const contributor = !responsible && !ctx.allDepartments;
  const editable = canEdit(ctx, a);
  const changed = prior
    ? changedFields(flat(prior.revision.criteria, prior.revision.answers, prior.revision.risk_score), flat(draft.criteria, draft.answers, c.score?.value))
    : [];
  return {
    assessment: {
      id: a.id, supplier: { id: a.supplier_id, name: a.supplier_name }, year: a.year,
      department: a.department_id ? { id: a.department_id, name: a.department_name } : null, responsibleTeam: a.responsible_team, services: a.services,
      status: a.status, source: a.source, dueOn: a.due_on, overdue: a.status === 'OPEN' && !!a.due_on && a.due_on < today,
      openedAt: a.opened_at, completedAt: a.completed_at, completedBy: a.completed_by, priorAssessmentId: a.prior_assessment_id,
      pendingReviewPeriod: draft.reviewPeriod ?? null, access: responsible ? 'RESPONSIBLE' : contributor ? 'CONTRIBUTOR' : 'READ',
    },
    draft: {
      criteria: draft.criteria ?? {}, questionSetId: draft.questionSetId ?? null, answers: draft.answers ?? {},
      manualScore: draft.manualScore ?? null, manualNote: draft.manualNote ?? null, importScore: draft.importScore ?? null,
    },
    computed: {
      criticality: c.criticality, score: c.score && { ...c.score, sourceLabel: SCORE_SOURCE_TR[c.score.source] }, level: c.level,
      blockers: a.status === 'OPEN' ? blockersFor(c, draft, actions, today, sets.length) : [],
    },
    prior: prior && { year: prior.year, assessmentId: prior.assessmentId, revision: revisionView(prior.revision) },
    changed,
    questionSet: c.set,
    publishedQuestionSets: sets,
    manualResultAllowed: sets.length === 0,
    revisions: revisions.map(revisionView),
    actions: actions.map(actionView),
    opinions: opinions.map((o) => ({ id: o.id, department: o.department_id ? { id: o.department_id, name: o.department_name } : null,
      author: { id: o.author_id, displayName: o.author_name }, body: o.body, createdAt: o.created_at })),
    reviews: reviews.map((v) => ({ id: v.id, period: v.period, outcome: v.outcome, revisionId: v.revision_id,
      decidedBy: { id: v.decided_by, displayName: v.decided_by_name }, decidedAt: v.decided_at })),
    can: {
      edit: editable && a.status === 'OPEN', complete: editable && a.status === 'OPEN',
      opine: can(ctx.roles, 'risk.opinion') && (responsible || contributor || ctx.allDepartments),
      review: editable && a.status === 'COMPLETED', manageActions: editable && a.status !== 'CANCELLED',
      setDepartment: can(ctx.roles, 'risk.cycle.manage'),
    },
  };
}

interface ListFilters { year?: number; status?: string; level?: number; departmentId?: string; overdue?: boolean; supplierId?: string }
interface ListRow {
  id: string; supplier_id: string; supplier_name: string; year: number; department_id: string | null; department_name: string | null; status: string; source: string;
  due_on: string | null; revision_no: number | null; criticality: string | null; criticality_column: number | null; risk_score: string | null; level: number | null;
  score_source: ScoreSource | null; last_review_period: string | null; last_review_outcome: string | null; open_actions: number; revision_count: number;
}
async function listRows(tx: Tx, f: ListFilters): Promise<ListRow[]> {
  const where: string[] = [];
  const p: unknown[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
  if (f.year !== undefined) add('a.year = ?', f.year);
  if (f.status) add('a.status = ?', f.status);
  if (f.departmentId) add('a.department_id = ?', f.departmentId);
  if (f.supplierId) add('a.supplier_id = ?', f.supplierId);
  if (f.level !== undefined) add('r.level = ?', f.level);
  if (f.overdue) add(`a.status = 'OPEN' AND a.due_on < ?::date`, istanbulToday());
  return (await tx.query<ListRow>(
    `SELECT a.id, a.supplier_id, s.legal_name AS supplier_name, a.year, a.department_id, d.name AS department_name, a.status, a.source, a.due_on::text AS due_on,
       r.revision_no, r.criticality::text AS criticality, r.criticality_column, to_char(r.risk_score, 'FM990.00') AS risk_score, r.level, r.score_source,
       v.period AS last_review_period, v.outcome AS last_review_outcome,
       (SELECT count(*)::int FROM risk_actions x WHERE x.assessment_id = a.id AND x.status = 'OPEN') AS open_actions,
       (SELECT count(*)::int FROM risk_assessment_revisions rr WHERE rr.assessment_id = a.id) AS revision_count
     FROM risk_assessments a JOIN suppliers s ON s.id = a.supplier_id LEFT JOIN departments d ON d.id = a.department_id
     LEFT JOIN LATERAL (SELECT * FROM risk_assessment_revisions r WHERE r.assessment_id = a.id ORDER BY r.revision_no DESC LIMIT 1) r ON true
     LEFT JOIN LATERAL (SELECT period, outcome FROM risk_reviews v WHERE v.assessment_id = a.id ORDER BY v.period DESC LIMIT 1) v ON true
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.year DESC, s.legal_name, a.id`, p)).rows;
}

export async function listAssessments(tx: Tx, ctx: TenantContext, f: ListFilters) {
  const today = istanbulToday();
  const rows = await listRows(tx, f);
  return {
    items: rows.map((r) => ({
      id: r.id, supplier: { id: r.supplier_id, name: r.supplier_name }, year: r.year,
      department: r.department_id ? { id: r.department_id, name: r.department_name } : null, status: r.status, source: r.source,
      dueOn: r.due_on, overdue: r.status === 'OPEN' && !!r.due_on && r.due_on < today,
      criticality: r.criticality, criticalityDisplay: r.criticality ? criticalityDisplay(r.criticality) : null, column: r.criticality_column,
      riskScore: r.risk_score, level: r.level, levelLabel: r.level ? RISK_LEVEL_TR[r.level as RiskLevelNo] : null, scoreSource: r.score_source,
      revisionNo: r.revision_no, lastReview: r.last_review_period ? { period: r.last_review_period, outcome: r.last_review_outcome } : null,
      openActions: r.open_actions,
      contributor: !ctx.allDepartments && !(r.department_id && ctx.departmentIds.includes(r.department_id)),
    })),
  };
}

/** Matris: görünen kayıtların son revizyonu (iptal hariç). Hücre bant 1..5 (0–20 … 80–100) × sütun 1..5. */
export async function matrix(tx: Tx, year: number) {
  const all = await listRows(tx, { year });
  const rows = all.filter((r) => r.status !== 'CANCELLED');
  const cells: { band: number; bandLabel: string; column: number; level: number; count: number; supplierIds: string[]; assessmentIds: string[] }[] = [];
  for (let band = 1; band <= 5; band++) for (let column = 1; column <= 5; column++) {
    cells.push({ band, bandLabel: RISK_BAND_LABEL[band as RiskLevelNo], column, level: RISK_MATRIX[band - 1]![column - 1]!, count: 0, supplierIds: [], assessmentIds: [] });
  }
  let unscored = 0;
  const today = istanbulToday();
  const byStatus = { OPEN: 0, COMPLETED: 0, CANCELLED: 0, overdue: 0 };
  for (const r of all) {
    byStatus[r.status as 'OPEN' | 'COMPLETED' | 'CANCELLED']++;
    if (r.status === 'OPEN' && r.due_on && r.due_on < today) byStatus.overdue++;
  }
  for (const r of rows) {
    if (r.risk_score === null || r.criticality_column === null) { unscored++; continue; }
    const cell = cells[(riskBand(r.risk_score) - 1) * 5 + (r.criticality_column - 1)]!;
    cell.count++;
    if (!cell.supplierIds.includes(r.supplier_id)) cell.supplierIds.push(r.supplier_id);
    cell.assessmentIds.push(r.id);
  }
  return { year, cells, unscored, byStatus };
}

// ---- taslak ---------------------------------------------------------------------------------------------------------------------

const SCORE_RE = /^(\d{1,3})(?:\.(\d{1,2}))?$/;
function scoreString(v: unknown): string | null {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'string' ? v.trim().replace(',', '.') : '';
  const m = SCORE_RE.exec(s);
  if (!m) return null;
  const out = `${Number(m[1])}.${(m[2] ?? '').padEnd(2, '0')}`;
  return Number(out) <= 100 ? out : null;
}

export interface DraftInput {
  criteria?: Record<string, number | null>; questionSetId?: string | null; answers?: Record<string, RiskAnswer | null>;
  manualScore?: string | number | null; manualNote?: string | null;
}

export async function saveDraft(tx: Tx, ctx: TenantContext, id: string, input: DraftInput) {
  const a = await loadForEdit(tx, ctx, id);
  if (a.status !== 'OPEN') throw conflict('not_open', 'Yalnız açık değerlendirmenin taslağı değişir; tamamlanmışı "Güncelle" ile yeniden açın.');
  const before = a.draft ?? {};
  const d: RiskDraft = { ...before, criteria: { ...(before.criteria ?? {}) }, answers: { ...(before.answers ?? {}) } };

  if (input.criteria !== undefined) {
    for (const [k, v] of Object.entries(input.criteria)) {
      if (!isCriterion(k)) throw unprocessable('invalid_criterion', `Bilinmeyen ölçüt: ${k}`);
      if (v === null) delete d.criteria![k];
      else if (v === 1 || v === 3 || v === 5) d.criteria![k] = v;
      else throw unprocessable('invalid_criterion_value', `Ölçüt değeri 1, 3 ya da 5 olmalı: ${k}`);
    }
  }
  const sets = await publishedSets(tx);
  if (input.questionSetId !== undefined) {
    if (input.questionSetId === null) d.questionSetId = null;
    else if (input.questionSetId !== before.questionSetId) {
      // Seçim listesinde yalnız yayımlanmış setler (taslak set seçilemez; emekli set yalnız önceden seçiliyse kalır).
      if (!sets.some((s) => s.id === input.questionSetId)) throw unprocessable('question_set_not_published', 'Yalnız yayımlanmış soru seti seçilebilir.');
      d.questionSetId = input.questionSetId;
    }
    if (d.questionSetId) { d.manualScore = null; d.manualNote = null; }
  }
  const set = d.questionSetId ? await loadSet(tx, d.questionSetId) : null;
  if (set) {
    // Set değişince başka setin kodları düşer (R8: aynı kod eşleşir).
    const codes = new Set(set.questions.map((q) => q.code));
    for (const k of Object.keys(d.answers!)) if (!codes.has(k)) delete d.answers![k];
  } else if (input.questionSetId !== undefined) d.answers = {};
  if (input.answers !== undefined) {
    if (!set) throw unprocessable('question_set_required', 'Cevap için önce soru seti seçin.');
    const codes = new Set(set.questions.map((q) => q.code));
    for (const [k, v] of Object.entries(input.answers)) {
      if (!codes.has(k)) throw unprocessable('invalid_question', `Seçili sette olmayan soru: ${k}`);
      if (v === null) delete d.answers![k];
      else if (v === 'YES' || v === 'NO') d.answers![k] = v;
      else throw unprocessable('invalid_answer', `Cevap YES ya da NO olmalı: ${k}`);
    }
  }
  if (input.manualScore !== undefined) {
    if (input.manualScore === null) d.manualScore = null;
    else {
      // R4: yayımlanmış set varken şablon dışı elle sonuç kabul edilmez.
      if (sets.length > 0) throw unprocessable('questions_available', 'Yayımlanmış soru seti var; risk skoru sorular cevaplanarak hesaplanır.');
      const sc = scoreString(input.manualScore);
      if (sc === null) throw unprocessable('invalid_score', 'Elle sonuç 0–100 arasında, en çok 2 ondalıklı olmalı.');
      d.manualScore = sc;
      d.questionSetId = null;
      d.answers = {};
    }
  }
  if (input.manualNote !== undefined) {
    const n = input.manualNote?.trim() || null;
    if (n && n.length > 2000) throw unprocessable('validation_failed', 'Dayanak notu en çok 2000 karakter olmalı.');
    d.manualNote = n;
  }
  if (d.manualScore != null && !d.manualNote) throw unprocessable('manual_note_required', 'Elle girilen sonuç için dayanak notu zorunludur.');

  await tx.query(`UPDATE risk_assessments SET draft = $2 WHERE id = $1`, [id, d]);
  const changed = changedFields(flat(before.criteria, before.answers, before.manualScore), flat(d.criteria, d.answers, d.manualScore));
  await audit(tx, ctx, 'risk.draft_saved', 'risk_assessment', id, { changed, questionSetId: d.questionSetId ?? null, manual: d.manualScore != null });
  return getAssessment(tx, ctx, id);
}

// ---- tamamlama ------------------------------------------------------------------------------------------------------------------

export async function complete(tx: Tx, ctx: TenantContext, id: string) {
  const a = await loadForEdit(tx, ctx, id);
  if (a.status !== 'OPEN') throw conflict('not_open', 'Yalnız açık değerlendirme tamamlanır.');
  const draft = a.draft ?? {};
  const today = istanbulToday();
  const c = await compute(tx, draft);
  const actions = await actionsOf(tx, id);
  const sets = await publishedSets(tx);
  const blockers = blockersFor(c, draft, actions, today, sets.length);
  if (c.score?.source === 'QUESTIONS' && c.set && c.set.status === 'DRAFT') blockers.push({ code: 'question_set_not_published', message: 'Soru seti yayımlanmamış.' });
  if (blockers.length > 0) throw unprocessable('completion_blocked', 'Değerlendirme tamamlanamaz; eksikleri giderin.', { blockers });
  const crit = c.criticality!, score = c.score!, level = c.level!;

  const prev = await latestRevision(tx, id);
  const base = prev ? prev : (await priorOf(tx, a))?.revision ?? null;
  const answers = score.source === 'QUESTIONS' ? (draft.answers ?? {}) : {};
  const changed = base ? changedFields(flat(base.criteria, base.answers, base.risk_score), flat(draft.criteria, answers, score.value)) : [];
  const revisionNo = (prev?.revision_no ?? 0) + 1;
  const rev = (await tx.query<{ id: string }>(
    `INSERT INTO risk_assessment_revisions (tenant_id, assessment_id, revision_no, criteria, criticality, criticality_column, question_set_id, answers,
       score_source, risk_score, score_note, level, method_version, changed_fields, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [ctx.tenantId, id, revisionNo, fullCriteria(draft.criteria), crit.value, crit.column, score.source === 'QUESTIONS' ? draft.questionSetId : null, answers,
      score.source, score.value, score.source === 'MANUAL_RESULT' ? draft.manualNote : null, level.level, RISK_METHOD_VERSION, changed, ctx.userId])).rows[0]!.id;

  const period = draft.reviewPeriod ?? null;
  const nextDraft: RiskDraft = { ...draft };
  delete nextDraft.reviewPeriod;
  await tx.query(`UPDATE risk_assessments SET status = 'COMPLETED', completed_at = now(), completed_by = $2, draft = $3 WHERE id = $1`, [id, ctx.userId, nextDraft]);
  if (period) {
    await tx.query(`INSERT INTO risk_reviews (tenant_id, assessment_id, period, outcome, revision_id, decided_by) VALUES ($1,$2,$3,'UPDATED',$4,$5)`,
      [ctx.tenantId, id, period, rev, ctx.userId]);
    await audit(tx, ctx, 'risk.review.updated', 'risk_assessment', id, { period, revisionNo });
  }
  await closeTasks(tx, `risk:${id}:due`);
  await closeTasks(tx, `risk:${id}:escalated`);
  await closeTasks(tx, `risk:${id}:review:`);
  if (level.level >= 4) {
    await openTask(tx, ctx, { companyId: null, kind: RISK_TASKS.highLevel, entityType: 'risk_assessment', entityId: id,
      title: `Yüksek risk: ${a.supplier_name} (${a.year}) ${RISK_LEVEL_TR[level.level]}`,
      reason: `Yıllık risk değerlendirmesi seviye ${level.level} ile tamamlandı; aksiyon ve kontrol planı kayıtlı.`,
      nextAction: 'Aksiyon ve kontrol planını inceleyin.', assigneeRole: 'PROCUREMENT', severity: level.level === 5 ? 'CRITICAL' : 'HIGH',
      dedupeKey: `risk:${id}:high:${revisionNo}` });
  }
  await audit(tx, ctx, 'risk.completed', 'risk_assessment', id, {
    revisionNo, criticality: crit.value, column: crit.column, riskScore: score.value, scoreSource: score.source, level: level.level,
    questionSetId: score.source === 'QUESTIONS' ? draft.questionSetId : null, methodVersion: RISK_METHOD_VERSION, changed,
  });
  return getAssessment(tx, ctx, id);
}

// ---- aksiyonlar -----------------------------------------------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dateOrNull(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw unprocessable('validation_failed', `${field}: tarih YYYY-AA-GG olmalı.`);
  return v;
}
/** Sahip: kurumun etkin iç kullanıcısı ve risk değerlendirme ya da görüş yetkisi olan (yalnız Denetçi/Yönetici sahip olamaz). */
async function assertOwner(tx: Tx, userId: string) {
  const rows = (await tx.query<{ roles: string[] }>(`SELECT m.roles FROM memberships m WHERE m.user_id = $1 AND m.tenant_id = app_tenant_id() AND m.status = 'ACTIVE' AND m.supplier_id IS NULL`, [userId])).rows;
  const ok = rows.some((r) => { const roles = normalizeRoles(r.roles); return can(roles, 'risk.assess') || can(roles, 'risk.opinion'); });
  if (!ok) throw unprocessable('invalid_owner', 'Sorumlu kişi kurumun etkin, risk değerlendirme ya da görüş yetkisi olan bir iç kullanıcısı olmalı.');
}

export interface ActionInput {
  kind: 'MITIGATION' | 'CONTROL'; title: string; description?: string | null; ownerUserId?: string | null; ownerText?: string | null;
  dueOn?: string | null; controlMethod?: 'ON_SITE' | 'ONLINE' | 'DESK' | null; supplierVisible?: boolean;
}
export async function addAction(tx: Tx, ctx: TenantContext, assessmentId: string, b: ActionInput) {
  const a = await loadForEdit(tx, ctx, assessmentId);
  if (a.status === 'CANCELLED') throw conflict('cancelled', 'İptal edilmiş değerlendirmeye aksiyon eklenmez.');
  const title = (b.title ?? '').trim();
  if (title.length < 2 || title.length > 500) throw unprocessable('validation_failed', 'Başlık 2-500 karakter olmalı.');
  if (b.kind === 'CONTROL' && !b.controlMethod) throw unprocessable('control_method_required', 'Denetim/kontrol satırında yöntem seçilmeli.');
  if (b.kind === 'MITIGATION' && b.controlMethod) throw unprocessable('validation_failed', 'Aksiyon satırında kontrol yöntemi olmaz.');
  if (b.ownerUserId) await assertOwner(tx, b.ownerUserId);
  const dueOn = dateOrNull(b.dueOn, 'Tarih');
  const x = (await tx.query<{ id: string }>(
    `INSERT INTO risk_actions (tenant_id, assessment_id, kind, control_method, title, description, owner_user_id, owner_text, due_on, supplier_visible, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ctx.tenantId, assessmentId, b.kind, b.kind === 'CONTROL' ? b.controlMethod : null, title, b.description?.trim() || null, b.ownerUserId ?? null,
      b.ownerText?.trim() || null, dueOn, b.supplierVisible ?? false, ctx.userId])).rows[0]!.id;
  await audit(tx, ctx, 'risk.action.created', 'risk_action', x, { assessmentId, kind: b.kind, ownerUserId: b.ownerUserId ?? null, dueOn, supplierVisible: b.supplierVisible ?? false });
  return actionView((await tx.query<ActionRow>(`${X_SELECT} WHERE x.id = $1`, [x])).rows[0]!);
}

export interface ActionPatch {
  title?: string; description?: string | null; ownerUserId?: string | null; ownerText?: string | null; dueOn?: string | null;
  controlMethod?: 'ON_SITE' | 'ONLINE' | 'DESK'; supplierVisible?: boolean; status?: 'DONE' | 'VERIFIED' | 'CANCELLED'; completionNote?: string | null;
}
const OWNER_FIELDS = new Set(['status', 'completionNote']);

/**
 * Aksiyon güncelleme. Sorumlu departman ya da Satınalma bütün alanları değiştirir; sahibi (başka departmanda olsa da, 054a) yalnız
 * durumunu "Tamamlandı" yapar ve not yazar (Ruling 6). Kapalı satır değişmez (tetikleyici); seviye 4–5 tamamlanmış kayıtta son
 * aksiyon/kontrol satırı iptal edilemez.
 */
export async function patchAction(tx: Tx, ctx: TenantContext, actionId: string, b: ActionPatch) {
  const x = (await tx.query<ActionRow>(`${X_SELECT} WHERE x.id = $1`, [actionId])).rows[0];
  if (!x) throw notFound();
  const a = (await tx.query<AssessmentRow>(`${A_SELECT} WHERE a.id = $1`, [x.assessment_id])).rows[0] ?? null;
  const manager = !!a && canEdit(ctx, a);
  const owner = x.owner_user_id === ctx.userId;
  const fields = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (!manager) {
    if (!owner) throw a ? forbidden('risk.assess') : notFound();
    if (!can(ctx.roles, 'risk.assess') && !can(ctx.roles, 'risk.opinion')) throw forbidden('risk.assess');
    const extra = fields.filter((k) => !OWNER_FIELDS.has(k));
    if (extra.length > 0) throw new ApiError(403, 'owner_fields_only', 'Aksiyon sahibi yalnız durumu ve tamamlama notunu güncelleyebilir.', { fields: extra });
    if (b.status && b.status !== 'DONE') throw new ApiError(403, 'owner_fields_only', 'Aksiyon sahibi yalnız "Tamamlandı" işaretleyebilir.');
  }
  if (x.status === 'VERIFIED' || x.status === 'CANCELLED') throw conflict('action_closed', 'Kapanmış aksiyon değişmez.');
  if (x.status === 'DONE' && !(b.status === 'VERIFIED' && fields.every((k) => k === 'status'))) {
    throw conflict('action_closed', 'Tamamlanmış aksiyon yalnız doğrulanabilir.');
  }
  const locked = (await tx.query<{ id: string }>(`SELECT id FROM risk_actions WHERE id = $1 FOR UPDATE`, [actionId])).rows[0];
  if (!locked) throw notFound();

  const set: string[] = [];
  const p: unknown[] = [actionId];
  const put = (col: string, v: unknown) => { p.push(v); set.push(`${col} = $${p.length}`); };
  if (b.title !== undefined) {
    const t = b.title.trim();
    if (t.length < 2 || t.length > 500) throw unprocessable('validation_failed', 'Başlık 2-500 karakter olmalı.');
    put('title', t);
  }
  if (b.description !== undefined) put('description', b.description?.trim() || null);
  if (b.ownerUserId !== undefined) { if (b.ownerUserId) await assertOwner(tx, b.ownerUserId); put('owner_user_id', b.ownerUserId); }
  if (b.ownerText !== undefined) put('owner_text', b.ownerText?.trim() || null);
  if (b.dueOn !== undefined) put('due_on', dateOrNull(b.dueOn, 'Tarih'));
  if (b.controlMethod !== undefined) {
    if (x.kind !== 'CONTROL') throw unprocessable('validation_failed', 'Aksiyon satırında kontrol yöntemi olmaz.');
    put('control_method', b.controlMethod);
  }
  if (b.supplierVisible !== undefined) put('supplier_visible', b.supplierVisible);
  const note = b.completionNote !== undefined ? (b.completionNote?.trim() || null) : undefined;
  if (note && note.length > 2000) throw unprocessable('validation_failed', 'Not en çok 2000 karakter olmalı.');
  if (b.status !== undefined) {
    if (b.status === 'DONE') {
      if (x.status !== 'OPEN') throw conflict('action_closed', 'Yalnız açık aksiyon tamamlanır.');
      if (!note) throw unprocessable('completion_note_required', '"Tamamlandı" için not zorunludur.');
      put('status', 'DONE'); put('completed_at', new Date()); put('completed_by', ctx.userId); put('completion_note', note);
    } else if (b.status === 'VERIFIED') {
      if (x.status !== 'DONE') throw conflict('action_not_done', 'Yalnız tamamlanmış aksiyon doğrulanır.');
      put('status', 'VERIFIED');
    } else if (b.status === 'CANCELLED') {
      if (a && a.status === 'COMPLETED') {
        const rev = await latestRevision(tx, a.id);
        const others = (await actionsOf(tx, a.id)).filter((o) => o.id !== x.id && o.kind === x.kind && o.status !== 'CANCELLED');
        if (rev && rev.level >= 4 && others.length === 0) {
          throw unprocessable('action_plan_required', 'Seviye 4–5 tamamlanmış değerlendirmede son aksiyon/kontrol satırı iptal edilemez.');
        }
      }
      put('status', 'CANCELLED');
      if (note) put('completion_note', note);
    }
  } else if (note !== undefined) {
    if (!manager) throw new ApiError(403, 'owner_fields_only', 'Not yalnız "Tamamlandı" ile birlikte yazılır.');
    put('completion_note', note);
  }
  if (set.length === 0) throw unprocessable('validation_failed', 'Değişecek alan yok.');
  // Tamamlanmış seviye 4–5 kayıtta açık plan satırı sahipsiz ya da geçmiş tarihli bırakılamaz (R9 kuralı tamamlandıktan sonra da geçerli).
  if (a && a.status === 'COMPLETED' && x.status === 'OPEN' && (b.status === undefined) && (b.ownerUserId !== undefined || b.dueOn !== undefined)) {
    const rev = await latestRevision(tx, a.id);
    if (rev && rev.level >= 4) {
      const ownerAfter = b.ownerUserId !== undefined ? b.ownerUserId : x.owner_user_id;
      const dueAfter = b.dueOn !== undefined ? (b.dueOn || null) : x.due_on;
      if (!ownerAfter || !dueAfter || dueAfter <= istanbulToday()) {
        throw unprocessable('action_plan_required', 'Seviye 4–5 tamamlanmış değerlendirmede aksiyon/kontrol satırı sahipli ve gelecek tarihli kalmalı.');
      }
    }
  }
  await tx.query(`UPDATE risk_actions SET ${set.join(', ')} WHERE id = $1`, p);
  const action = b.status === 'DONE' ? 'risk.action.done' : b.status === 'VERIFIED' ? 'risk.action.verified' : b.status === 'CANCELLED' ? 'risk.action.cancelled' : 'risk.action.updated';
  await audit(tx, ctx, action, 'risk_action', actionId, { assessmentId: x.assessment_id, fields, byOwner: !manager });
  return actionView((await tx.query<ActionRow>(`${X_SELECT} WHERE x.id = $1`, [actionId])).rows[0]!);
}

// ---- görüş ----------------------------------------------------------------------------------------------------------------------

export async function addOpinion(tx: Tx, ctx: TenantContext, assessmentId: string, body: string) {
  const a = await loadAssessment(tx, assessmentId);
  if (a.status === 'CANCELLED') throw conflict('cancelled', 'İptal edilmiş değerlendirmeye görüş eklenmez.');
  const text = (body ?? '').trim();
  if (text.length < 3 || text.length > 4000) throw unprocessable('validation_failed', 'Görüş 3-4000 karakter olmalı.');
  let departmentId: string | null = null;
  if (a.department_id && ctx.departmentIds.includes(a.department_id)) departmentId = a.department_id;
  else if (!ctx.allDepartments) {
    // Katkıcı: tedarikçiyle yürürlükte sözleşmesi olan kendi departmanı (054a app_contract_in_force).
    departmentId = (await tx.query<{ department_id: string }>(
      `SELECT f.department_id FROM contract_families f WHERE f.supplier_id = $1 AND f.department_id = ANY($2::uuid[]) AND app_contract_in_force(f.id)
       ORDER BY f.department_id LIMIT 1`, [a.supplier_id, ctx.departmentIds])).rows[0]?.department_id ?? null;
    if (!departmentId) throw new ApiError(403, 'not_contributor', 'Görüşü yalnız sorumlu ya da tedarikçiyle yürürlükte sözleşmesi olan departman ekler.');
  }
  const id = (await tx.query<{ id: string }>(`INSERT INTO risk_opinions (tenant_id, assessment_id, department_id, author_id, body) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.tenantId, assessmentId, departmentId, ctx.userId, text])).rows[0]!.id;
  await audit(tx, ctx, 'risk.opinion.added', 'risk_assessment', assessmentId, { opinionId: id, departmentId });
  const o = (await tx.query<{ created_at: Date; department_name: string | null; author_name: string | null }>(
    `SELECT o.created_at, d.name AS department_name, u.display_name AS author_name FROM risk_opinions o LEFT JOIN departments d ON d.id = o.department_id
     LEFT JOIN users u ON u.id = o.author_id WHERE o.id = $1`, [id])).rows[0]!;
  return { id, department: departmentId ? { id: departmentId, name: o.department_name } : null, author: { id: ctx.userId, displayName: o.author_name }, body: text, createdAt: o.created_at };
}

// ---- sorumlu departman (R5) -------------------------------------------------------------------------------------------------------

/** Değerlendirmenin departman görevi (son tarihli). Tekil `risk:{id}:due`; departman kayıttan türetilir. T5 (yıllık döngü) de kullanır. */
export async function openDueTask(tx: Tx, ctx: TenantContext, a: { id: string; supplierName: string; year: number; dueOn: string | null }) {
  return openTask(tx, ctx, { companyId: null, kind: RISK_TASKS.due, entityType: 'risk_assessment', entityId: a.id,
    title: `Yıllık risk değerlendirmesi: ${a.supplierName} (${a.year})`, reason: 'Tedarikçinin yıllık risk değerlendirmesi bekleniyor.',
    nextAction: 'Kritiklik ölçütlerini ve risk skorunu girip değerlendirmeyi tamamlayın.', assigneeRole: 'DEPARTMENT_USER',
    dueAt: a.dueOn ? new Date(`${a.dueOn}T23:59:59+03:00`) : null, dedupeKey: `risk:${a.id}:due` });
}

export async function setDepartment(tx: Tx, ctx: TenantContext, id: string, departmentId: string) {
  const a = await loadAssessment(tx, id, true);
  if (a.status === 'CANCELLED') throw conflict('cancelled', 'İptal edilmiş değerlendirme değişmez.');
  const d = (await tx.query<{ id: string }>(`SELECT id FROM departments WHERE id = $1`, [departmentId])).rows[0];
  if (!d) throw unprocessable('invalid_department', 'Departman bulunamadı.');
  await tx.query(`UPDATE risk_assessments SET department_id = $2 WHERE id = $1`, [id, departmentId]);
  await rederiveTaskDepartments(tx, `t.entity_type = 'risk_assessment' AND t.entity_id = $1`, [id]);
  await closeTasks(tx, `risk:${id}:department`);
  if (a.status === 'OPEN') await openDueTask(tx, ctx, { id, supplierName: a.supplier_name, year: a.year, dueOn: a.due_on });
  await audit(tx, ctx, 'risk.department_set', 'risk_assessment', id, { before: a.department_id, after: departmentId });
  return getAssessment(tx, ctx, id);
}

// ---- çeyreklik gözden geçirme (R10) ----------------------------------------------------------------------------------------------

export async function review(tx: Tx, ctx: TenantContext, id: string, b: { period: string; outcome: 'NO_CHANGE' | 'UPDATE' }) {
  const a = await loadForEdit(tx, ctx, id);
  const m = /^(\d{4})-([1-4])$/.exec(b.period ?? '');
  if (!m) throw unprocessable('invalid_period', 'Dönem YYYY-Ç biçiminde olmalı (ör. 2026-2).');
  if (Number(m[1]) !== a.year) throw unprocessable('invalid_period', 'Dönem değerlendirmenin yılına ait olmalı.');
  if (b.period > riskPeriod(istanbulToday())) throw unprocessable('invalid_period', 'Gelecek dönem için gözden geçirme yapılamaz.');
  if (a.status !== 'COMPLETED') throw conflict('not_completed', 'Gözden geçirme yalnız tamamlanmış değerlendirmede yapılır.');
  const exists = (await tx.query(`SELECT 1 FROM risk_reviews WHERE assessment_id = $1 AND period = $2`, [id, b.period])).rowCount;
  if (exists) throw conflict('review_exists', 'Bu dönemin gözden geçirmesi zaten yapıldı.');
  const rev = await latestRevision(tx, id);
  if (!rev) throw conflict('not_completed', 'Değerlendirmenin revizyonu yok.');
  if (b.outcome === 'NO_CHANGE') {
    const actions = await actionsOf(tx, id);
    const blockers = completionBlockers({ criteria: rev.criteria as Partial<CriteriaValues>, score: rev.risk_score, level: rev.level, today: istanbulToday(),
      actions: actions.map((x) => ({ kind: x.kind, ownerUserId: x.owner_user_id, dueOn: x.due_on, status: x.status })) });
    if (blockers.length > 0) throw unprocessable('completion_blocked', '"Değişiklik yok" için açık eksik olmamalı; "Güncelle" ile düzeltin.', { blockers });
    await tx.query(`INSERT INTO risk_reviews (tenant_id, assessment_id, period, outcome, revision_id, decided_by) VALUES ($1,$2,$3,'NO_CHANGE',$4,$5)`,
      [ctx.tenantId, id, b.period, rev.id, ctx.userId]);
    await closeTasks(tx, `risk:${id}:review:${b.period}`);
    await audit(tx, ctx, 'risk.review.no_change', 'risk_assessment', id, { period: b.period, revisionNo: rev.revision_no });
  } else {
    // Güncelle: taslak = son revizyon; tamamlanınca yeni revizyon + UPDATED gözden geçirmesi (complete()).
    const draft: RiskDraft = {
      criteria: rev.criteria, questionSetId: rev.question_set_id, answers: rev.answers,
      manualScore: rev.score_source === 'MANUAL_RESULT' ? rev.risk_score : null, manualNote: rev.score_source === 'MANUAL_RESULT' ? rev.score_note : null,
      importScore: rev.score_source === 'IMPORT' ? rev.risk_score : null, reviewPeriod: b.period,
    };
    // Yeniden açılan kayda yeni son tarih: bugün (İstanbul) + kiracı ayarı (varsayılan 90 gün); eski son tarih gecikme saydırmaz.
    const dueDays = (await getRiskSettings(tx)).dueDays;
    const dueOn = (await tx.query<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [istanbulToday(), dueDays])).rows[0]!.d;
    await tx.query(`UPDATE risk_assessments SET status = 'OPEN', draft = $2, due_on = $3 WHERE id = $1`, [id, draft, dueOn]);
    await audit(tx, ctx, 'risk.review.update_started', 'risk_assessment', id, { period: b.period, fromRevision: rev.revision_no, dueOn, beforeDueOn: a.due_on });
  }
  return getAssessment(tx, ctx, id);
}

// ---- tedarikçi geçmişi, güncel risk, portal ---------------------------------------------------------------------------------------

export async function supplierHistory(tx: Tx, ctx: TenantContext, supplierId: string) {
  const s = (await tx.query(`SELECT 1 FROM suppliers WHERE id = $1`, [supplierId])).rowCount;
  if (!s) throw notFound();
  const rows = await listRows(tx, { supplierId });
  const ids = rows.map((r) => r.id);
  const actions = ids.length
    ? (await tx.query<ActionRow>(`${X_SELECT} WHERE x.assessment_id = ANY($1::uuid[]) AND x.status = 'OPEN' ORDER BY x.due_on NULLS LAST, x.created_at`, [ids])).rows
    : [];
  return {
    supplierId,
    items: rows.map((r) => ({
      id: r.id, year: r.year, status: r.status, department: r.department_id ? { id: r.department_id, name: r.department_name } : null,
      level: r.level, levelLabel: r.level ? RISK_LEVEL_TR[r.level as RiskLevelNo] : null, riskScore: r.risk_score, scoreSource: r.score_source,
      criticality: r.criticality, criticalityDisplay: r.criticality ? criticalityDisplay(r.criticality) : null, column: r.criticality_column,
      band: r.risk_score ? riskBand(r.risk_score) : null, revisionCount: r.revision_count, lastReview: r.last_review_period ? { period: r.last_review_period, outcome: r.last_review_outcome } : null,
      openActions: actions.filter((x) => x.assessment_id === r.id).map(actionView),
      contributor: !ctx.allDepartments && !(r.department_id && ctx.departmentIds.includes(r.department_id)),
    })),
  };
}

/**
 * Faz 7 uyum denetimi için: `asOf` (YYYY-AA-GG) gününün sonunda geçerli olan, tamamlanmış en yeni yılın o ana kadarki son revizyonu.
 * Çağıranın RLS kapsamıyla okur (sistem işi tüm departman bağlamıyla çağırır). Yoksa null.
 */
export async function currentRisk(tx: Tx, supplierId: string, asOf: string) {
  if (!DATE_RE.test(asOf)) throw new Error(`invalid_date:${asOf}`);
  const r = (await tx.query<{ assessment_id: string; year: number; status: string; revision_no: number; criticality: string; criticality_column: number;
    risk_score: string; level: number; score_source: ScoreSource; created_at: Date }>(
    `SELECT a.id AS assessment_id, a.year, a.status, r.revision_no, r.criticality::text AS criticality, r.criticality_column,
       to_char(r.risk_score, 'FM990.00') AS risk_score, r.level, r.score_source, r.created_at
     FROM risk_assessments a
     JOIN LATERAL (SELECT * FROM risk_assessment_revisions r WHERE r.assessment_id = a.id
                     AND r.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'Europe/Istanbul') ORDER BY r.revision_no DESC LIMIT 1) r ON true
     WHERE a.supplier_id = $1 AND a.year <= $2 AND a.status <> 'CANCELLED'
     ORDER BY a.year DESC LIMIT 1`, [supplierId, Number(asOf.slice(0, 4)), asOf])).rows[0];
  if (!r) return null;
  return { assessmentId: r.assessment_id, year: r.year, status: r.status, revisionNo: r.revision_no, criticality: r.criticality,
    criticalityDisplay: criticalityDisplay(r.criticality), column: r.criticality_column, riskScore: r.risk_score, level: r.level as RiskLevelNo,
    scoreSource: r.score_source, revisedAt: r.created_at };
}

/** R13: tedarikçi oturumu yalnız app_portal_risk() ile (ham tablolara erişimi yok; 054a). */
export async function portalRisk(tx: Tx, ctx: TenantContext) {
  if (!ctx.supplierId) throw notFound();
  const v = (await tx.query<{ v: { year: number | null; level: number | null; riskScore: string | null; actions: { title: string; dueOn: string | null; status: string }[] } }>(
    `SELECT app_portal_risk() AS v`)).rows[0]!.v;
  return { year: v.year, level: v.level, levelLabel: v.level ? RISK_LEVEL_TR[v.level as RiskLevelNo] : null, riskScore: v.riskScore,
    actions: v.actions.map((x) => ({ title: x.title, dueOn: x.dueOn, status: x.status })) };
}
