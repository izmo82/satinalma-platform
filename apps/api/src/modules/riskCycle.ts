import type pg from 'pg';
import { normalizeRoles, quarterStart, riskPeriod } from '@sp/domain';
import { withoutTenant, withTenant, type TenantContext, type Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { unprocessable } from '../errors.ts';
import { queueEmail } from '../mail/index.ts';
import { openTask, RISK_TASKS } from '../tasks.ts';
import { currentApprovers } from './approvers.ts';
import { withTenantWideScope } from './contractChain.ts';
import { istanbulDay, SYSTEM_USER, systemContext } from './contractReminders.ts';
import { openDueTask, type RiskDraft } from './riskAssessments.ts';
import { getRiskSettings } from './riskQuestions.ts';

/**
 * v2 Faz 6 (D111) Görev 5: yıllık risk döngüsü (R5, R6, R8), gecikme yükseltmesi (R7), çeyreklik gözden geçirme görevleri (R10)
 * ve işçi zamanlayıcısı. Yürürlükte sözleşme tanımı Faz 3 ile ortak SQL `app_contract_in_force` (054a, Ruling 5).
 * Sistem işleri `contract.end_reminder` gibi kuranın üyeliğine bağlı değildir (systemContext: tüm şirketler, tüm departmanlar).
 */

export const RISK_JOBS = { annual: 'risk.annual_open', quarterly: 'risk.quarterly', escalate: 'risk.escalate' } as const;
export const RISK_JOB_KINDS: string[] = Object.values(RISK_JOBS);

/** Pasif (Faz 5 pasife alma: SUSPENDED), arşiv, ret ve birleşmiş tedarikçiye değerlendirme açılmaz (R6). */
const INACTIVE_SUPPLIER = ['SUSPENDED', 'ARCHIVED', 'REJECTED', 'MERGED'];

const trDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const addDays = async (tx: Tx, day: string, n: number) =>
  (await tx.query<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [day, n])).rows[0]!.d;

// ---- R8: önceki yılın son revizyonundan taslak -----------------------------------------------------------------------------

interface PriorRevision { assessmentId: string; criteria: Record<string, number>; questionSetId: string | null; answers: Record<string, 'YES' | 'NO'> }

/** Aynı tedarikçinin `year` öncesi, revizyonu olan en yeni yılının son revizyonu. */
async function priorRevision(tx: Tx, supplierId: string, year: number): Promise<PriorRevision | null> {
  const r = (await tx.query<{ assessment_id: string; criteria: Record<string, number>; question_set_id: string | null; answers: Record<string, 'YES' | 'NO'> }>(
    `SELECT a.id AS assessment_id, r.criteria, r.question_set_id, r.answers
     FROM risk_assessments a
     JOIN LATERAL (SELECT * FROM risk_assessment_revisions r WHERE r.assessment_id = a.id ORDER BY r.revision_no DESC LIMIT 1) r ON true
     WHERE a.supplier_id = $1 AND a.year < $2 AND a.status <> 'CANCELLED'
     ORDER BY a.year DESC LIMIT 1`, [supplierId, year])).rows[0];
  return r ? { assessmentId: r.assessment_id, criteria: r.criteria, questionSetId: r.question_set_id, answers: r.answers ?? {} } : null;
}

/**
 * Taslak: ölçütler aynen; soru setinin bugün yayımlı sürümü (aynı set kodu) seçilir ve cevaplar soru KODU eşleşenler için taşınır
 * (yeni soru boş kalır). Set kodunun yayımlı sürümü yoksa set ve cevap taşınmaz. Skor kaynağı elle/içe aktarım ise skor taşınmaz
 * (yeni yılın skoru yeniden girilir; R4 elle sonuç dayanak notu ister).
 */
async function draftFromPrior(tx: Tx, p: PriorRevision): Promise<RiskDraft> {
  const draft: RiskDraft = { criteria: { ...p.criteria } };
  if (!p.questionSetId) return draft;
  const cur = (await tx.query<{ id: string }>(
    `SELECT s.id FROM risk_question_sets s WHERE s.status = 'PUBLISHED' AND s.code = (SELECT code FROM risk_question_sets WHERE id = $1)
     ORDER BY s.version DESC LIMIT 1`, [p.questionSetId])).rows[0];
  if (!cur) return draft;
  const codes = new Set((await tx.query<{ code: string }>(`SELECT code FROM risk_questions WHERE set_id = $1`, [cur.id])).rows.map((q) => q.code));
  draft.questionSetId = cur.id;
  draft.answers = Object.fromEntries(Object.entries(p.answers).filter(([k, v]) => codes.has(k) && (v === 'YES' || v === 'NO')));
  return draft;
}

// ---- R5/R6: yılı açma ------------------------------------------------------------------------------------------------------------

export interface OpenYearResult { year: number; opened: number; skippedExisting: number; needsDepartment: number; skippedInactive: number; dueOn: string }

/**
 * R6: yürürlükte sözleşmesi olan, pasif/arşiv/ret/birleşmiş olmayan her tedarikçiye `year` için OPEN değerlendirme (kaynak CYCLE).
 * İdempotent: (tedarikçi, yıl) tekil, var olan atlanır. Sorumlu departman (R5): önceki yılın değerlendirmesinin departmanı; yoksa
 * yürürlükteki sözleşmelerin tek departmanı; birden çoksa ya da yoksa boş + Satınalma'ya "Sorumlu departmanı seçin" görevi.
 * Departmanlıya `risk:{id}:due` görevi (son tarih bugün + due_days). Bağlamın gördüğü sözleşmeler sayılır: işçi ve API ucu
 * kiracının bütün şirketleriyle çağırır (`openRiskYearTenantWide`).
 */
export async function openRiskYear(tx: Tx, ctx: TenantContext, year: number, today: string): Promise<OpenYearResult> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw unprocessable('invalid_year', 'Yıl 2000–2100 arasında olmalı.');
  // Gelecek yıl en erken bir yıl önceden açılır (yanlış yazılan yılın kiracı geneli kayıt açmasını önler).
  if (year > Number(today.slice(0, 4)) + 1) throw unprocessable('invalid_year', 'En çok gelecek yıl açılabilir.');
  const dueDays = (await getRiskSettings(tx)).dueDays;
  const dueOn = await addDays(tx, today, dueDays);
  const candidates = (await tx.query<{ id: string; legal_name: string; status: string; departments: string[] }>(
    `SELECT s.id, s.legal_name, s.status, array_remove(array_agg(DISTINCT f.department_id), NULL) AS departments
     FROM contract_families f JOIN suppliers s ON s.id = f.supplier_id
     WHERE app_contract_in_force(f.id)
     GROUP BY s.id, s.legal_name, s.status ORDER BY s.legal_name, s.id`)).rows;
  const res: OpenYearResult = { year, opened: 0, skippedExisting: 0, needsDepartment: 0, skippedInactive: 0, dueOn };
  const openedBy = ctx.userId === SYSTEM_USER ? null : ctx.userId;
  for (const s of candidates) {
    if (INACTIVE_SUPPLIER.includes(s.status)) { res.skippedInactive++; continue; }
    if ((await tx.query(`SELECT 1 FROM risk_assessments WHERE supplier_id = $1 AND year = $2`, [s.id, year])).rowCount) { res.skippedExisting++; continue; }
    // R5: yalnız en yeni önceki yıl değerlendirmesinin departmanı. Boşsa sözleşme kuralına düşülür; birleşmişse birleştiği departman
    // (o da birleşmişse sözleşme kuralı); daha eski yılların departmanına bakılmaz.
    const pd = (await tx.query<{ department_id: string | null; merged_into: string | null; target_merged: string | null }>(
      `SELECT a.department_id, d.merged_into, m.merged_into AS target_merged
       FROM risk_assessments a LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN departments m ON m.id = d.merged_into
       WHERE a.supplier_id = $1 AND a.year < $2 AND a.status <> 'CANCELLED' ORDER BY a.year DESC LIMIT 1`, [s.id, year])).rows[0];
    const priorDept = !pd?.department_id ? null : !pd.merged_into ? pd.department_id : !pd.target_merged ? pd.merged_into : null;
    const departmentId = priorDept ?? (s.departments.length === 1 ? s.departments[0]! : null);
    const prior = await priorRevision(tx, s.id, year);
    const draft = prior ? await draftFromPrior(tx, prior) : {};
    const id = (await tx.query<{ id: string }>(
      `INSERT INTO risk_assessments (tenant_id, supplier_id, year, department_id, source, due_on, draft, prior_assessment_id, opened_by)
       VALUES ($1,$2,$3,$4,'CYCLE',$5,$6,$7,$8) ON CONFLICT (tenant_id, supplier_id, year) DO NOTHING RETURNING id`,
      [ctx.tenantId, s.id, year, departmentId, dueOn, draft, prior?.assessmentId ?? null, openedBy])).rows[0]?.id;
    if (!id) { res.skippedExisting++; continue; }
    res.opened++;
    if (departmentId) {
      await openDueTask(tx, ctx, { id, supplierName: s.legal_name, year, dueOn });
    } else {
      res.needsDepartment++;
      await openTask(tx, ctx, { companyId: null, kind: RISK_TASKS.department, entityType: 'risk_assessment', entityId: id, departmentId: null,
        title: `Sorumlu departmanı seçin: ${s.legal_name} (${year})`,
        reason: s.departments.length > 1
          ? 'Tedarikçiyle birden çok departmanın yürürlükte sözleşmesi var; yıllık risk değerlendirmesini yapacak departman seçilmeli.'
          : 'Yıllık risk değerlendirmesini yapacak departman belirlenemedi.',
        nextAction: 'Değerlendirmeyi açıp sorumlu departmanı seçin.', assigneeRole: 'PROCUREMENT', dedupeKey: `risk:${id}:department` });
    }
    await audit(tx, ctx, 'risk.assessment.opened', 'risk_assessment', id, {
      supplierId: s.id, year, departmentId, dueOn, priorAssessmentId: prior?.assessmentId ?? null, contractDepartments: s.departments });
  }
  await audit(tx, ctx, 'risk.cycle.opened', 'risk_cycle', null, { ...res });
  return res;
}

/**
 * API ucu: döngü kiracı düzeyindedir (değerlendirmenin şirketi yok); Yönetici'nin şirket kapsamı boştur. Sayım ve açılış, mevcut
 * `withTenantWideScope` (contractChain.ts) içinde kiracının bütün şirketleri ve tüm departmanlarıyla yapılır, sonra kapsam geri alınır.
 * Ucu yalnız `risk.cycle.manage` çağırır; yanıt yalnız sayılardır.
 */
export function openRiskYearTenantWide(tx: Tx, ctx: TenantContext, year: number, today: string): Promise<OpenYearResult> {
  return withTenantWideScope(tx, () => openRiskYear(tx, ctx, year, today));
}

// ---- R7: gecikme yükseltmesi -------------------------------------------------------------------------------------------------

export interface EscalateResult { escalated: number; toPerson: number; toQueue: number; emails: number; emailStatus: string[] }

/**
 * Son tarihi geçmiş OPEN değerlendirme: departman sorumlusuna (yoksa vekiline) kişiye atanmış görev + e-posta; ikisi de yoksa
 * (ya da departman boşsa) Satınalma rol kuyruğuna görev ve satınalma sorumlusuna (yoksa vekiline) e-posta. Asıl görev açık kalır.
 * Tekil anahtar son tarih döngüsüne bağlıdır: `risk:{id}:escalated:{due_on}` (herhangi bir durumda varsa yeniden kurulmaz; "Güncelle"
 * ile yeni son tarih alan kayıt yeniden gecikirse yeni anahtar). Tamamlama `risk:{id}:escalated` önekini kapatır.
 */
export async function escalateOverdueRisk(tx: Tx, ctx: TenantContext, today: string): Promise<EscalateResult> {
  const rows = (await tx.query<{ id: string; year: number; department_id: string | null; due_on: string; supplier_name: string }>(
    `SELECT a.id, a.year, a.department_id, a.due_on::text AS due_on, s.legal_name AS supplier_name
     FROM risk_assessments a JOIN suppliers s ON s.id = a.supplier_id
     WHERE a.status = 'OPEN' AND a.due_on IS NOT NULL AND a.due_on < $1::date ORDER BY a.due_on, a.id`, [today])).rows;
  const res: EscalateResult = { escalated: 0, toPerson: 0, toQueue: 0, emails: 0, emailStatus: [] };
  for (const a of rows) {
    const key = `risk:${a.id}:escalated:${a.due_on}`;
    if ((await tx.query(`SELECT 1 FROM tasks WHERE dedupe_key = $1`, [key])).rowCount) continue;
    const ap = await currentApprovers(tx, a.department_id ?? '');
    const person = a.department_id ? (ap.head ?? ap.deputy) : null;
    let role = 'PROCUREMENT';
    if (person) {
      const roles = normalizeRoles((await tx.query<{ roles: string[] }>(
        `SELECT roles FROM memberships WHERE user_id = $1 AND tenant_id = app_tenant_id() AND status = 'ACTIVE' AND supplier_id IS NULL`, [person.userId])).rows[0]?.roles ?? []);
      role = roles.includes('DEPARTMENT_USER') || !roles.includes('PROCUREMENT') ? 'DEPARTMENT_USER' : 'PROCUREMENT';
    }
    const title = `Gecikmiş risk değerlendirmesi: ${a.supplier_name} (${a.year})`;
    const reason = `Son tarih ${trDate(a.due_on)} geçti; yıllık risk değerlendirmesi tamamlanmadı.`;
    const nextAction = person ? 'Departmanınızın değerlendirmeyi tamamlamasını sağlayın.' : 'Sorumlu departmanı belirleyip değerlendirmenin tamamlanmasını sağlayın.';
    await openTask(tx, ctx, { companyId: null, kind: RISK_TASKS.escalated, entityType: 'risk_assessment', entityId: a.id,
      title, reason, nextAction, assigneeRole: role, assigneeUserId: person?.userId ?? null, severity: 'HIGH', dedupeKey: key });
    res.escalated++;
    if (person) res.toPerson++; else res.toQueue++;
    const mailTo = person ?? ap.lead ?? ap.leadDeputy;
    let emailStatus: string | null = null;
    if (mailTo) {
      const m = await queueEmail(tx, ctx, { toUserId: mailTo.userId, toEmail: mailTo.email, subject: title,
        body: `Sayın ${mailTo.displayName},\n\n${reason}\n\n${nextAction}\n\nBu ileti Satınalma Platformu tarafından hazırlanmıştır.`,
        relatedType: 'risk_assessment', relatedId: a.id });
      emailStatus = m.status;
      res.emails++;
      if (!res.emailStatus.includes(m.status)) res.emailStatus.push(m.status);
    }
    await audit(tx, ctx, 'risk.escalated', 'risk_assessment', a.id, {
      dueOn: a.due_on, assigneeUserId: person?.userId ?? null, procurementQueue: !person, emailTo: mailTo?.userId ?? null, emailStatus });
  }
  return res;
}

// ---- R10: çeyreklik gözden geçirme görevleri -----------------------------------------------------------------------------------

/**
 * `period` (YYYY-Ç) yılının COMPLETED değerlendirmelerine, o dönem gözden geçirmesi yoksa görev (`risk:{id}:review:{period}`,
 * son tarih çeyrek sonu). "Değişiklik yok" ya da "Güncelle" → tamamlama görevi kapatır (riskAssessments.review/complete).
 */
export async function openQuarterlyReviews(tx: Tx, ctx: TenantContext, period: string): Promise<{ period: string; opened: number; existing: number }> {
  const m = /^(\d{4})-([1-4])$/.exec(period);
  if (!m) throw unprocessable('invalid_period', 'Dönem YYYY-Ç biçiminde olmalı.');
  const start = quarterStart(period);
  const end = (await tx.query<{ d: string }>(`SELECT (($1::date + interval '3 months') - interval '1 day')::date::text AS d`, [start])).rows[0]!.d;
  const rows = (await tx.query<{ id: string; year: number; supplier_name: string }>(
    `SELECT a.id, a.year, s.legal_name AS supplier_name FROM risk_assessments a JOIN suppliers s ON s.id = a.supplier_id
     WHERE a.status = 'COMPLETED' AND a.year = $1 AND NOT EXISTS (SELECT 1 FROM risk_reviews v WHERE v.assessment_id = a.id AND v.period = $2)
     ORDER BY s.legal_name, a.id`, [Number(m[1]), period])).rows;
  let opened = 0, existing = 0;
  for (const a of rows) {
    const t = await openTask(tx, ctx, { companyId: null, kind: RISK_TASKS.review, entityType: 'risk_assessment', entityId: a.id,
      title: `Çeyreklik risk gözden geçirmesi ${period}: ${a.supplier_name}`,
      reason: `${a.year} yıllık risk değerlendirmesinin ${period} dönemi gözden geçirmesi bekleniyor.`,
      nextAction: 'Değişiklik yoksa "Değişiklik yok"u seçin; değişiklik varsa "Güncelle" ile değerlendirmeyi yeniden açın.',
      assigneeRole: 'DEPARTMENT_USER', dueAt: new Date(`${end}T23:59:59+03:00`), dedupeKey: `risk:${a.id}:review:${period}` });
    if (t.created) opened++; else existing++;
  }
  await audit(tx, ctx, 'risk.quarterly.opened', 'risk_cycle', null, { period, opened, existing });
  return { period, opened, existing };
}

// ---- işçi zamanlayıcısı ---------------------------------------------------------------------------------------------------------

/** Dönem başından bu yana geçen gün (0 = ilk gün). Kaçırılan gün (işçi kapalı) için ilk 7 gün içinde yetişilir; anahtar yıl/dönem başına tekildir. */
const CATCH_UP_DAYS = 7;

export type TenantLister = (pool: pg.Pool) => Promise<string[] | null>;

/**
 * Döngü kiracıları: SECURITY DEFINER kapısı `risk_cycle_tenants()` (054b; sp_app kiracı bağlamı olmadan kiracıları listeleyemez).
 * Kapı yoksa (migration uygulanmamış ortam) null döner: zamanlayıcı iş kurmaz, uyarı yazar.
 */
export const riskCycleTenants: TenantLister = (pool) => withoutTenant(pool, async (c) => {
  const ok = (await c.query<{ ok: boolean }>(`SELECT to_regprocedure('risk_cycle_tenants()') IS NOT NULL AS ok`)).rows[0]!.ok;
  if (!ok) return null;
  return (await c.query<{ t: string }>(`SELECT t FROM risk_cycle_tenants() t`)).rows.map((r) => r.t);
});

/** Bugün (İstanbul) için kurulacak işler: her gün yükseltme; 1–7 Ocak yıllık açılış; 1–7 Nisan/Temmuz/Ekim çeyreklik görevler. */
export function riskSchedule(day: string): { kind: string; key: string; payload: Record<string, unknown> }[] {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const dom = Number(day.slice(8, 10));
  const out: { kind: string; key: string; payload: Record<string, unknown> }[] = [{ kind: RISK_JOBS.escalate, key: `risk-escalate:${day}`, payload: { day } }];
  const quarterFirstMonth = month % 3 === 1;
  if (quarterFirstMonth && dom - 1 < CATCH_UP_DAYS) {
    if (month === 1) out.push({ kind: RISK_JOBS.annual, key: `risk-annual:${year}`, payload: { year, day } });
    else { const period = riskPeriod(day); out.push({ kind: RISK_JOBS.quarterly, key: `risk-quarterly:${period}`, payload: { period, day } }); }
  }
  return out;
}

/** Kiracı başına günün işleri (tekil iş anahtarı: aynı gün/yıl/dönem ikinci kez kurulmaz). Dönüş: yeni kurulan iş sayısı; kapı yoksa null. */
export async function enqueueRiskSchedules(pool: pg.Pool, now: Date, listTenants: TenantLister = riskCycleTenants): Promise<number | null> {
  const day = istanbulDay(now);
  const tenants = await listTenants(pool);
  if (tenants === null) return null;
  const jobs = riskSchedule(day);
  let n = 0;
  for (const tenantId of tenants) {
    const ctx = systemContext(tenantId, [], `risk-schedule-${day}`);
    n += await withTenant(pool, ctx, async (tx) => {
      let k = 0;
      for (const j of jobs) {
        k += (await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by) VALUES ($1,$2,$3,$4,NULL)
          ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING`, [tenantId, j.kind, j.key, j.payload])).rowCount ?? 0;
      }
      return k;
    });
  }
  return n;
}

/**
 * İşçi kapısı (`dailyReminderBackfill` deseni): İstanbul gününde bir kez taranır; hata verirse gün işaretlenmez, en erken bir dakika
 * sonra yeniden denenir. Kiracı kapısı (migration) yoksa gün işaretlenir ve günde bir uyarı yazılır.
 */
export function dailyRiskSchedules(enqueue: (pool: pg.Pool, now: Date) => Promise<number | null> = enqueueRiskSchedules) {
  let lastDay = '';
  let lastTry = Number.NEGATIVE_INFINITY;
  return async (pool: pg.Pool, now: Date): Promise<number | null> => {
    const day = istanbulDay(now);
    if (day === lastDay || now.getTime() - lastTry < 60_000) return null;
    lastTry = now.getTime();
    const n = await enqueue(pool, now);
    lastDay = day;
    if (n === null) console.warn('risk schedules: risk_cycle_tenants() yok; yıllık/çeyreklik/yükseltme işleri kurulmadı');
    return n;
  };
}

/** `risk.*` sistem işi: kiracının bütün şirketleri ve departmanlarıyla çalışır, sonucu iş satırına yazar. */
export async function processRiskJob(pool: pg.Pool, kind: string, tenantId: string, jobId: string) {
  const base = systemContext(tenantId, [], jobId);
  const { companyIds, payload } = await withTenant(pool, base, async (tx) => ({
    companyIds: (await tx.query<{ id: string }>(`SELECT id FROM legal_entities ORDER BY id`)).rows.map((r) => r.id),
    payload: ((await tx.query<{ payload: Record<string, unknown> | null }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0]?.payload ?? {}),
  }));
  const ctx = systemContext(tenantId, companyIds, jobId);
  const day = typeof payload.day === 'string' ? payload.day : istanbulDay(new Date());
  return withTenant(pool, ctx, async (tx) => {
    let result: unknown;
    if (kind === RISK_JOBS.annual) result = await openRiskYear(tx, ctx, Number(payload.year ?? day.slice(0, 4)), day);
    else if (kind === RISK_JOBS.quarterly) result = await openQuarterlyReviews(tx, ctx, typeof payload.period === 'string' ? payload.period : riskPeriod(day));
    else if (kind === RISK_JOBS.escalate) result = await escalateOverdueRisk(tx, ctx, day);
    else throw new Error(`unknown_risk_job:${kind}`);
    await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, result]);
    return result;
  });
}
