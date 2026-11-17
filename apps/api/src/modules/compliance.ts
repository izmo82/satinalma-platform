import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  can, CHECK_TYPE_TR, COMPLIANCE_CHECKS, complianceScore, PROJECT_METHOD_TR, RESULT_TR, ruleApplies, VERDICT_TR,
  type ComplianceRule, type RuleResult, type Verdict,
} from '@sp/domain';
import { withTenant, type TenantContext, type Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { conflict, notFound, unprocessable } from '../errors.ts';
import { DEFAULT_AI_MODEL_ID } from '../config.ts';
import { hasAiProviders } from '../ai/provider.ts';
import { isTestProvider, TEST_PROVIDER_LABEL } from '../ai/testProvider.ts';
import type { ObjectStore } from '../storage.ts';
import { processAiRun, PROVIDER_LABELS } from './ai.ts';
import { requestEvidenceReading } from './contractAi.ts';
import { AUDIT_JOB, enqueueAudit } from './projectCompletion.ts';
import { ruleSetById, ruleSetForDay } from './procurementRules.ts';
import {
  evidenceCacheKey, evidenceDocs, evidencePurpose, EVIDENCE_QUESTIONS, isEvidenceKey, latestMarks, loadAuditProject, runDataCheck, runEvidenceCheck,
  type EvidenceContext,
} from './complianceChecks.ts';

/**
 * v2 Faz 7 (D112) Görev 6: uyum denetimi motoru (R6–R10). Tamamlanan proje, tamamlandığı gün (Europe/Istanbul) yürürlükte olan yayımlı
 * kural setiyle denetlenir (`ruleSetForDay`; yeniden koşu önceki koşunun setini kullanır). Puan ve hüküm kodda (`complianceScore`); yapay zekâ
 * yalnız kanıt belgesini okur (Faz 4 AI15 yolu, defter `ai_runs`), sonucu önbellekte (`compliance_ai_cache`, API'den hiç verilmez).
 * Koşu değişmez kayıttır (`run_no` artar). Özet kodla yazılır ("Otomatik özet"); test sağlayıcısının katkısı her yerde etiketlidir.
 */

export const TRIGGER_TR = { COMPLETED: 'Proje tamamlanınca', RERUN: 'Yeniden koşu' } as const;
export const AUDIT_STATUS_TR = { DONE: 'Tamamlandı', NO_RULESET: 'Kural seti yok', FAILED: 'Denetim yapılamadı' } as const;
export const METHOD_TR = { DATA: 'Otomatik (veri)', AI: 'Yapay zekâ', MANUAL: 'Elle' } as const;
export const SUMMARY_SOURCE_TR = { AUTO: 'Otomatik özet', AI: 'Yapay zekâ özeti' } as const;
export const NO_AI_LABEL = 'Yapay zekâ kullanılmadı';
export const NO_RULESET_MESSAGE = 'Projenin tamamlandığı gün yürürlükte yayımlı satınalma kuralları seti yok; denetim puansız kaldı.';
export const NOT_COMPLETED_MESSAGE = 'Uyum denetimi yalnız tamamlanmış projede koşar.';
type Trigger = keyof typeof TRIGGER_TR;

export interface AuditOptions { aiAvailable?: boolean; modelId?: string }

/** Raporun sağlayıcı etiketi: test → "Test sağlayıcısı — gerçek değil"; gerçek → kurum dışı; kullanılmadıysa belirtilir. */
export const providerLabel = (provider: string | null, isTest: boolean) =>
  isTest || isTestProvider(provider) ? TEST_PROVIDER_LABEL : provider ? PROVIDER_LABELS.anthropic : NO_AI_LABEL;

const advice: Partial<Record<RuleResult, string>> = {
  FAIL: 'bulguyu inceleyin; kural ihlali için düzeltici işlem ve gerekçe kaydedin.',
  NO_DATA: 'eksik kaydı ya da kanıtı tamamlayıp denetimi yeniden koşun.',
  PENDING: 'kanıt belgesine bakarak kuralı elle işaretleyin.',
};
const trDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

interface ResultRow { rule: ComplianceRule & { id: string; sortOrder: number }; result: RuleResult; method: 'DATA' | 'AI' | 'MANUAL' | null; finding: string; evidence: Record<string, unknown>[] }

/** Kodla yazılan özet (R8): hüküm, puan, karşılanmayan kurallar, öneriler. Aynı sonuçlar → aynı metin. */
export function autoSummary(i: { verdict: Verdict; score: number | null; set: { versionNo: number; effectiveFrom: string }; results: ResultRow[]; aiLabel: string | null;
  fallback?: boolean }): string {
  const lines = [`${SUMMARY_SOURCE_TR.AUTO} (kodla yazıldı; yapay zekâ özeti değildir).`,
    `Hüküm: ${VERDICT_TR[i.verdict]}. Puan: ${i.score === null ? 'yok' : `${i.score}/100`}. Kural seti: sürüm ${i.set.versionNo} (yürürlük ${trDate(i.set.effectiveFrom)}).`];
  if (i.fallback) lines.push(fallbackNote(i.set.versionNo));
  const open = i.results.filter((r) => r.result !== 'PASS' && r.result !== 'NOT_APPLICABLE');
  const mandatory = open.filter((r) => r.rule.mandatory);
  if (mandatory.length) lines.push(`Uyumsuzluk nedeni (zorunlu kurallar): ${mandatory.map((r) => `${r.rule.code} ${r.rule.name} — ${RESULT_TR[r.result]}`).join('; ')}.`);
  if (open.length) {
    lines.push('Karşılanmayan ya da sonuçlanmayan kurallar:');
    for (const r of open) lines.push(`- ${r.rule.code} ${r.rule.name} (${RESULT_TR[r.result]}${r.rule.mandatory ? ', zorunlu' : ''}): ${r.finding}`);
    lines.push('Öneriler:');
    for (const r of open) lines.push(`- ${r.rule.code}: ${advice[r.result] ?? ''}`);
  } else lines.push('Uygulanan bütün kurallar karşılandı.');
  if (i.aiLabel) lines.push(`Kanıt kurallarında yapay zekâ önerisi kullanıldı: ${i.aiLabel}. Puanı ve hükmü kod hesapladı.`);
  return lines.join('\n');
}

/**
 * R6–R10 denetim koşusu (tek işlem). Proje başına danışma kilidiyle sıralı; `run_no` = son + 1. Yürürlükte set yoksa NO_RULESET (puansız)
 * + Yöneticiye görev. Uyumsuz → Satınalma görevi; uyumlu koşu açık görevi kapatır.
 */
export async function runComplianceAudit(tx: Tx, ctx: TenantContext, projectId: string, trigger: Trigger, opts: AuditOptions = {}):
  Promise<{ auditId: string; runNo: number; status: 'DONE' | 'NO_RULESET'; score: number | null; verdict: Verdict | null }> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`compliance-audit:${projectId}`]);
  const st = (await tx.query<{ status: string }>(`SELECT status FROM projects WHERE id = $1`, [projectId])).rows[0];
  if (!st) throw notFound();
  if (st.status !== 'COMPLETED') throw conflict('invalid_state', NOT_COMPLETED_MESSAGE);
  const project = (await loadAuditProject(tx, projectId))!;
  const runNo = (await tx.query<{ n: number }>(`SELECT coalesce(max(run_no), 0)::int + 1 AS n FROM compliance_audits WHERE project_id = $1`, [projectId])).rows[0]!.n;
  const chosen = await chooseSet(tx, projectId, project.completedOn);
  if (!chosen) {
    const a = (await tx.query<{ id: string }>(`INSERT INTO compliance_audits (tenant_id, company_id, project_id, run_no, trigger, status, summary, summary_source, run_by)
      VALUES ($1,$2,$3,$4,$5,'NO_RULESET',$6,'AUTO',$7) RETURNING id`,
      [ctx.tenantId, project.companyId, projectId, runNo, trigger, `${SUMMARY_SOURCE_TR.AUTO}: ${NO_RULESET_MESSAGE}`, runBy(ctx)])).rows[0]!;
    await openTask(tx, ctx, { companyId: project.companyId, kind: 'compliance_no_ruleset', entityType: 'project', entityId: projectId,
      title: `Kural seti yok: ${project.code} ${project.title}`, reason: NO_RULESET_MESSAGE,
      nextAction: 'Satınalma kuralları setini yayımlayın; ardından Satınalma denetimi yeniden koşar.', assigneeRole: 'ADMIN', dedupeKey: `compliance-no-ruleset:${projectId}` });
    await audit(tx, ctx, 'compliance.audited', 'project', projectId, { auditId: a.id, runNo, trigger, status: 'NO_RULESET' });
    return { auditId: a.id, runNo, status: 'NO_RULESET', score: null, verdict: null };
  }
  const { set, fallback } = chosen;
  const ec: EvidenceContext = { aiAvailable: opts.aiAvailable ?? hasAiProviders(), modelId: opts.modelId ?? DEFAULT_AI_MODEL_ID, marks: await latestMarks(tx, projectId) };
  const scope = { method: project.method, amount: project.amount, currency: project.currency };
  const results: ResultRow[] = [];
  let ai = null as { provider: string | null; isTest: boolean } | null;
  for (const rule of set.rules) {
    if (!ruleApplies(rule, scope)) {
      results.push({ rule, result: 'NOT_APPLICABLE', method: null, evidence: [],
        finding: `Kapsam dışı (proje yöntemi ${PROJECT_METHOD_TR[project.method]}${project.amount ? `, tutar ${project.amount} ${project.currency}` : ''}).` });
      continue;
    }
    if (rule.checkType === 'DATA' && rule.checkKey) {
      const o = await runDataCheck(tx, rule.checkKey, rule.params, project, ctx);
      results.push({ rule, ...o, method: 'DATA' });
    } else if (rule.checkType === 'EVIDENCE_AI') {
      const o = await runEvidenceCheck(tx, ctx, rule, project, ec);
      if (o.method === 'AI' && o.provider) ai = { provider: ai?.provider ?? o.provider, isTest: (ai?.isTest ?? false) || o.isTest };
      results.push({ rule, result: o.result, method: o.method, finding: o.finding, evidence: o.evidence });
    } else {
      const m = ec.marks.get(rule.code);
      results.push(m
        ? { rule, result: m.result, method: 'MANUAL', finding: `Elle işaretlendi (${m.markedByName ?? 'Satınalma'}): ${m.note}`,
            evidence: [{ type: 'manualMark', markId: m.id, documentVersionId: m.documentVersionId, markedBy: m.markedBy, markedAt: m.markedAt }] }
        : { rule, result: 'PENDING', method: null, finding: 'Elle işaret bekliyor: Satınalma kanıt belgesiyle işaretler.', evidence: [] });
    }
  }
  const score = complianceScore(results.map((r) => ({ weight: r.rule.weight, mandatory: r.rule.mandatory, result: r.result })));
  const aiLabel = ai ? providerLabel(ai.provider, ai.isTest) : null;
  const summary = autoSummary({ verdict: score.verdict, score: score.score, set, results, aiLabel, fallback });
  const a = (await tx.query<{ id: string }>(`INSERT INTO compliance_audits (tenant_id, company_id, project_id, run_no, rule_set_id, trigger, status, score, verdict,
      summary, summary_source, ai_provider, ai_provider_is_test, run_by) VALUES ($1,$2,$3,$4,$5,$6,'DONE',$7,$8,$9,'AUTO',$10,$11,$12) RETURNING id`,
    [ctx.tenantId, project.companyId, projectId, runNo, set.id, trigger, score.score, score.verdict, summary.slice(0, 20000), ai?.provider ?? null, ai?.isTest ?? false, runBy(ctx)])).rows[0]!;
  for (const r of results) {
    await tx.query(`INSERT INTO compliance_rule_results (tenant_id, audit_id, rule_id, result, method, finding, evidence, weight, mandatory) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.tenantId, a.id, r.rule.id, r.result, r.method, r.finding.slice(0, 8000), JSON.stringify(r.evidence), r.rule.weight, r.rule.mandatory]);
  }
  await closeTasks(tx, `compliance-no-ruleset:${projectId}`);
  if (score.verdict === 'NONCOMPLIANT') {
    const reasons = score.failedMandatory.map((i) => `${results[i]!.rule.code} ${results[i]!.rule.name} (${RESULT_TR[results[i]!.result]})`);
    const reason = `Zorunlu kural karşılanmadı: ${reasons.join('; ')}.`.slice(0, 2000);
    // Sonraki koşuda neden değiştiyse açık görev kapatılıp güncel nedenle yeniden açılır (görev metni güncellenemez; tek açık görev kalır).
    const openReason = (await tx.query<{ reason: string }>(`SELECT reason FROM tasks WHERE dedupe_key = $1 AND status = 'OPEN'`,
      [`compliance-noncompliant:${projectId}`])).rows[0]?.reason;
    if (openReason !== undefined && openReason !== reason) await closeTasks(tx, `compliance-noncompliant:${projectId}`);
    await openTask(tx, ctx, { companyId: project.companyId, kind: 'compliance_noncompliant', entityType: 'project', entityId: projectId,
      title: `Uyumsuz proje: ${project.code} ${project.title}`, reason,
      nextAction: 'Uyum denetimi raporundaki bulguları inceleyin; eksikleri tamamlayıp denetimi yeniden koşun.', assigneeRole: 'PROCUREMENT', severity: 'HIGH',
      dedupeKey: `compliance-noncompliant:${projectId}` });
  } else await closeTasks(tx, `compliance-noncompliant:${projectId}`);
  await audit(tx, ctx, 'compliance.audited', 'project', projectId, { auditId: a.id, runNo, trigger, status: 'DONE', ruleSetId: set.id, versionNo: set.versionNo,
    score: score.score, verdict: score.verdict, aiProvider: ai?.provider ?? null, aiProviderIsTest: ai?.isTest ?? false });
  return { auditId: a.id, runNo, status: 'DONE', score: score.score, verdict: score.verdict };
}
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

export const fallbackNote = (versionNo: number | null) => `Tamamlanma gününde yürürlükte set yoktu; ilk yayımlanan set (sürüm ${versionNo}) kullanıldı.`;
/**
 * Koşunun seti (R6 + Ruling 14): önceki koşunun seti; yoksa `day` gününde yürürlükteki set; o da yoksa (set geriye tarihlenemez) en erken
 * yürürlüğe giren yayımlı set (`fallback`). Hiç yayımlı set yoksa null (NO_RULESET).
 */
export async function chooseSet(tx: Tx, projectId: string, day: string) {
  const prev = (await tx.query<{ rule_set_id: string }>(
    `SELECT rule_set_id FROM compliance_audits WHERE project_id = $1 AND rule_set_id IS NOT NULL ORDER BY run_no DESC LIMIT 1`, [projectId])).rows[0]?.rule_set_id;
  const set = (prev ? await ruleSetById(tx, prev) : null) ?? await ruleSetForDay(tx, day);
  if (set) return { set, fallback: set.effectiveFrom > day };
  const first = (await tx.query<{ id: string }>(`SELECT id FROM procurement_rule_sets WHERE status = 'PUBLISHED' AND effective_from IS NOT NULL
    ORDER BY effective_from, version_no LIMIT 1`)).rows[0];
  const f = first ? await ruleSetById(tx, first.id) : null;
  return f ? { set: f, fallback: true } : null;
}
const runBy = (ctx: TenantContext) => (ctx.userId && ctx.userId !== SYSTEM_USER ? ctx.userId : null);

/**
 * İşçi: kanıt kuralları için okuma ister ve kuyruktaki okuma işlerini burada işler (Faz 4 `processAiRun`: ücretli çağrı işlem dışında,
 * en fazla bir kez; iş önce bu denetim tarafından alınır, başka işçi aynı işi işlemez). Önbellekte sonucu olan, elle işaretli ya da
 * sağlayıcısız kurallar için istek yapılmaz.
 */
export async function prefetchEvidenceReadings(pool: pg.Pool, ctx: TenantContext, store: ObjectStore, projectId: string, opts: AuditOptions = {}) {
  if (!(opts.aiAvailable ?? hasAiProviders())) return;
  const modelId = opts.modelId ?? DEFAULT_AI_MODEL_ID;
  const runIds = await withTenant(pool, ctx, async (tx) => {
    const project = await loadAuditProject(tx, projectId);
    if (!project) return [];
    const set = (await chooseSet(tx, projectId, project.completedOn))?.set;
    if (!set) return [];
    const marks = await latestMarks(tx, projectId);
    const out: string[] = [];
    for (const rule of set.rules) {
      if (rule.checkType !== 'EVIDENCE_AI' || !isEvidenceKey(rule.checkKey) || marks.has(rule.code)) continue;
      if (!ruleApplies(rule, { method: project.method, amount: project.amount, currency: project.currency })) continue;
      const pdfs = (await evidenceDocs(tx, projectId, rule)).filter((d) => d.mimeType === 'application/pdf');
      if (!pdfs.length) continue;
      const key = evidenceCacheKey(rule, pdfs.map((d) => d.sha256), modelId);
      if ((await tx.query(`SELECT 1 FROM compliance_ai_cache WHERE cache_key = $1`, [key])).rowCount) continue;
      for (const d of pdfs) {
        const r = await requestEvidenceReading(tx, ctx, { documentVersionId: d.documentVersionId, purpose: evidencePurpose(rule.checkKey),
          questions: EVIDENCE_QUESTIONS[rule.checkKey] }, { modelId });
        if (r.status === 'QUEUED') out.push(r.runId);
      }
    }
    return [...new Set(out)];
  });
  for (const runId of runIds) {
    const jobId = await withTenant(pool, ctx, async (tx) => (await tx.query<{ id: string }>(
      `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, updated_at = now() WHERE kind = 'ai.run' AND idempotency_key = $1 AND status = 'QUEUED' RETURNING id`,
      [`ai-run-${runId}`])).rows[0]?.id ?? null);
    if (jobId) await processAiRun(pool, ctx, store, jobId);
  }
}

/** `compliance.audit` işi (yükü `{ projectId, trigger }`; Görev 4'ten önce kuyruğa girmiş işler dahil). Son denemede hata → FAILED koşu kaydı. */
export async function processComplianceAudit(pool: pg.Pool, ctx: TenantContext, store: ObjectStore, jobId: string, opts: AuditOptions = {}) {
  const job = await withTenant(pool, ctx, async (tx) => (await tx.query<{ payload: { projectId?: unknown; trigger?: unknown }; attempts: number; max_attempts: number }>(
    `SELECT payload, attempts, max_attempts FROM jobs WHERE id = $1`, [jobId])).rows[0]);
  const finish = (tx: Tx, status: string, result: unknown, code: string | null = null) =>
    tx.query(`UPDATE jobs SET status = $2, result = $3, error_code = $4, updated_at = now() WHERE id = $1`, [jobId, status, result, code]);
  const projectId = typeof job?.payload?.projectId === 'string' ? job.payload.projectId : null;
  const trigger: Trigger = job?.payload?.trigger === 'RERUN' ? 'RERUN' : 'COMPLETED';
  if (!projectId) { await withTenant(pool, ctx, (tx) => finish(tx, 'FAILED', { reason: 'INVALID_PAYLOAD' }, 'INVALID_PAYLOAD')); return; }
  const visible = await withTenant(pool, ctx, async (tx) => (await tx.query<{ status: string }>(`SELECT status FROM projects WHERE id = $1`, [projectId])).rows[0]?.status ?? null);
  if (visible !== 'COMPLETED') {
    await withTenant(pool, ctx, (tx) => finish(tx, 'FAILED', { reason: visible ? 'PROJECT_NOT_COMPLETED' : 'PROJECT_NOT_VISIBLE' }, visible ? 'PROJECT_NOT_COMPLETED' : 'PROJECT_NOT_VISIBLE'));
    return;
  }
  // Okuma hatası denetimi durdurmaz: okunamayan kanıt kuralı NO_DATA olur (önbelleğe yazılmaz; yeniden koşu yeniden dener).
  await prefetchEvidenceReadings(pool, ctx, store, projectId, opts).catch((e) => console.error('compliance evidence prefetch failed', jobId, (e as Error).name));
  try {
    await withTenant(pool, ctx, async (tx) => {
      const r = await runComplianceAudit(tx, ctx, projectId, trigger, opts);
      await finish(tx, 'SUCCEEDED', r);
    });
  } catch (e) {
    if (job && job.attempts < job.max_attempts) throw e;
    await withTenant(pool, ctx, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`compliance-audit:${projectId}`]);
      const p = (await tx.query<{ company_id: string }>(`SELECT company_id FROM projects WHERE id = $1`, [projectId])).rows[0]!;
      const runNo = (await tx.query<{ n: number }>(`SELECT coalesce(max(run_no), 0)::int + 1 AS n FROM compliance_audits WHERE project_id = $1`, [projectId])).rows[0]!.n;
      const a = (await tx.query<{ id: string }>(`INSERT INTO compliance_audits (tenant_id, company_id, project_id, run_no, trigger, status, summary, summary_source, run_by)
        VALUES ($1,$2,$3,$4,$5,'FAILED',$6,'AUTO',$7) RETURNING id`,
        [ctx.tenantId, p.company_id, projectId, runNo, trigger, `${SUMMARY_SOURCE_TR.AUTO}: denetim teknik hata nedeniyle tamamlanamadı; yeniden koşun.`, runBy(ctx)])).rows[0]!;
      await audit(tx, ctx, 'compliance.audited', 'project', projectId, { auditId: a.id, runNo, trigger, status: 'FAILED' });
      await finish(tx, 'FAILED', { auditId: a.id, reason: 'AUDIT_ERROR' }, 'AUDIT_ERROR');
    });
  }
}

// --- Rapor görünümü ---------------------------------------------------------------------------------------------------------

interface AuditRow {
  id: string; project_id: string; run_no: number; rule_set_id: string | null; version_no: number | null; effective_from: string | null; trigger: Trigger;
  status: keyof typeof AUDIT_STATUS_TR; score: number | null; verdict: Verdict | null; summary: string | null; summary_source: 'AUTO' | 'AI' | null;
  ai_provider: string | null; ai_provider_is_test: boolean; run_by: string | null; run_by_name: string | null; created_at: Date; completed_on: string | null;
}
const AUDIT_SELECT = `SELECT a.id, a.project_id, a.run_no, a.rule_set_id, s.version_no, s.effective_from::text AS effective_from, a.trigger, a.status, a.score, a.verdict,
    a.summary, a.summary_source, a.ai_provider, a.ai_provider_is_test, a.run_by, u.display_name AS run_by_name, a.created_at, pp.completed_on::text AS completed_on
  FROM compliance_audits a LEFT JOIN procurement_rule_sets s ON s.id = a.rule_set_id LEFT JOIN users u ON u.id = a.run_by LEFT JOIN projects pp ON pp.id = a.project_id`;

const summaryView = (a: AuditRow) => ({
  id: a.id, runNo: a.run_no, trigger: a.trigger, triggerLabel: TRIGGER_TR[a.trigger], status: a.status, statusLabel: AUDIT_STATUS_TR[a.status],
  ruleSet: a.rule_set_id ? { id: a.rule_set_id, versionNo: a.version_no, effectiveFrom: a.effective_from } : null,
  // Ruling 14: set tamamlanma gününden sonra yürürlüğe girdiyse (ilk yayımlanan set kullanıldı) görünür not.
  ruleSetFallback: !!(a.rule_set_id && a.effective_from && a.completed_on && a.effective_from > a.completed_on),
  ruleSetNote: a.rule_set_id && a.effective_from && a.completed_on && a.effective_from > a.completed_on ? fallbackNote(a.version_no) : null,
  score: a.score, verdict: a.verdict, verdictLabel: a.verdict ? VERDICT_TR[a.verdict] : AUDIT_STATUS_TR[a.status],
  aiProvider: a.ai_provider, aiProviderIsTest: a.ai_provider_is_test, providerLabel: providerLabel(a.ai_provider, a.ai_provider_is_test),
  runBy: a.run_by_name ?? (a.run_by ? null : 'Sistem'), createdAt: a.created_at, pdfUrl: `/api/v1/compliance-audits/${a.id}/pdf`,
});

/** Koşunun tam görünümü (rapor ekranı ve PDF): kural sonuçları Türkçe etiketli; önbellek içeriği yok. */
export async function auditDetail(tx: Tx, auditId: string) {
  const a = (await tx.query<AuditRow>(`${AUDIT_SELECT} WHERE a.id = $1`, [auditId])).rows[0];
  if (!a) throw notFound();
  const results = (await tx.query<{ rule_id: string; code: string; name: string; description: string | null; check_type: keyof typeof CHECK_TYPE_TR; check_key: string | null;
      sort_order: number; result: RuleResult; method: keyof typeof METHOD_TR | null; finding: string | null; evidence: unknown; weight: number; mandatory: boolean }>(
    `SELECT r.rule_id, p.code, p.name, p.description, p.check_type, p.check_key, p.sort_order, r.result, r.method, r.finding, r.evidence, r.weight, r.mandatory
     FROM compliance_rule_results r JOIN procurement_rules p ON p.id = r.rule_id WHERE r.audit_id = $1 ORDER BY p.sort_order, p.code`, [auditId])).rows;
  const failedMandatory = results.filter((r) => r.mandatory && r.result !== 'PASS' && r.result !== 'NOT_APPLICABLE')
    .map((r) => ({ code: r.code, name: r.name, result: r.result, resultLabel: RESULT_TR[r.result] }));
  return {
    ...summaryView(a), projectId: a.project_id, failedMandatory,
    summary: a.summary, summarySource: a.summary_source, summarySourceLabel: a.summary_source ? SUMMARY_SOURCE_TR[a.summary_source] : null,
    results: results.map((r) => ({
      ruleId: r.rule_id, code: r.code, name: r.name, description: r.description, checkType: r.check_type, checkTypeLabel: CHECK_TYPE_TR[r.check_type],
      checkKey: r.check_key, checkName: r.check_key && Object.hasOwn(COMPLIANCE_CHECKS, r.check_key) ? COMPLIANCE_CHECKS[r.check_key as keyof typeof COMPLIANCE_CHECKS].name : null,
      weight: r.weight, mandatory: r.mandatory, result: r.result, resultLabel: RESULT_TR[r.result], method: r.method, methodLabel: r.method ? METHOD_TR[r.method] : null,
      finding: r.finding, evidence: r.evidence,
    })),
  };
}

async function projectHead(tx: Tx, projectId: string) {
  const p = (await tx.query<{ id: string; code: string; title: string; status: string; completed_on: string | null; department_id: string | null; department_name: string | null;
      company_id: string }>(
    `SELECT p.id, p.code, p.title, p.status, p.completed_on::text AS completed_on, p.department_id, d.name AS department_name, p.company_id
     FROM projects p LEFT JOIN departments d ON d.id = p.department_id WHERE p.id = $1`, [projectId])).rows[0];
  if (!p) throw notFound();
  return p;
}

/** Elle işaretlenebilir kurallar: projenin setindeki (koşulmuş set, yoksa tamamlanma günü ya da bugün) kanıt ve elle kuralları. */
async function markableRules(tx: Tx, projectId: string, completedOn: string | null) {
  const day = completedOn ?? (await tx.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Istanbul')::date::text AS d`)).rows[0]!.d;
  const set = (await chooseSet(tx, projectId, day))?.set;
  return (set?.rules ?? []).filter((r) => r.checkType === 'EVIDENCE_AI' || r.checkType === 'MANUAL')
    .map((r) => ({ code: r.code, name: r.name, checkType: r.checkType, checkTypeLabel: CHECK_TYPE_TR[r.checkType], checkKey: r.checkKey }));
}

/** GET /projects/:id/compliance (R10): son koşu, geçmiş, bekleyen iş, elle işaretler, yetkiler. Departman kapsamı RLS (görünmeyen proje 404). */
export async function projectCompliance(tx: Tx, ctx: TenantContext, projectId: string) {
  const p = await projectHead(tx, projectId);
  const runs = (await tx.query<AuditRow>(`${AUDIT_SELECT} WHERE a.project_id = $1 ORDER BY a.run_no DESC`, [projectId])).rows;
  const pending = (await tx.query<{ id: string; status: string; trigger: string }>(
    `SELECT id, status, payload->>'trigger' AS trigger FROM jobs WHERE kind = $1 AND payload->>'projectId' = $2 AND status IN ('QUEUED','RUNNING')
     ORDER BY created_at DESC LIMIT 1`, [AUDIT_JOB, projectId])).rows[0] ?? null;
  const marks = [...(await latestMarks(tx, projectId)).values()].sort((a, b) => a.ruleCode.localeCompare(b.ruleCode))
    .map((m) => ({ id: m.id, ruleCode: m.ruleCode, result: m.result, resultLabel: RESULT_TR[m.result], note: m.note, documentVersionId: m.documentVersionId,
      markedBy: m.markedByName, markedAt: m.markedAt }));
  const completed = p.status === 'COMPLETED';
  return {
    project: { id: p.id, code: p.code, title: p.title, status: p.status, completedOn: p.completed_on, departmentId: p.department_id, departmentName: p.department_name },
    latest: runs[0] ? await auditDetail(tx, runs[0].id) : null,
    runs: runs.map(summaryView),
    pendingJob: pending ? { id: pending.id, status: pending.status, statusLabel: pending.status === 'RUNNING' ? 'Denetim sürüyor' : 'Denetim sırada',
      trigger: pending.trigger, triggerLabel: TRIGGER_TR[pending.trigger as Trigger] ?? null } : null,
    marks, markableRules: await markableRules(tx, projectId, p.completed_on),
    aiConnected: hasAiProviders(),
    notice: completed ? null : 'Uyum denetimi proje tamamlanınca koşar.',
    can: { rerun: completed && can(ctx.roles, 'compliance.run'), mark: can(ctx.roles, 'compliance.mark') },
  };
}

/** POST /projects/:id/compliance-audits (R10): yeniden koşu işi (ayrı tekil anahtar). Sırada/çalışan iş varsa o döner. */
export async function requestRerun(tx: Tx, ctx: TenantContext, projectId: string) {
  const p = await projectHead(tx, projectId);
  if (!ctx.companyIds.includes(p.company_id)) throw notFound();
  if (p.status !== 'COMPLETED') throw conflict('invalid_state', NOT_COMPLETED_MESSAGE);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`compliance-rerun:${projectId}`]);
  // Yalnız sıradaki (QUEUED) iş yeniden kullanılır: çalışan iş yeni işareti/veriyi görmeyebilir, bu yüzden yeni iş açılır.
  const open = (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM jobs WHERE kind = $1 AND payload->>'projectId' = $2 AND status = 'QUEUED'
    ORDER BY created_at DESC LIMIT 1`, [AUDIT_JOB, projectId])).rows[0];
  if (open) return { jobId: open.id, status: open.status, duplicate: true };
  const jobId = await enqueueAudit(tx, ctx, p.company_id, projectId, 'RERUN', `audit:${projectId}:rerun:${randomUUID()}`);
  await audit(tx, ctx, 'compliance.rerun_requested', 'project', projectId, { jobId });
  return { jobId, status: 'QUEUED', duplicate: false };
}

/** POST /projects/:id/compliance-marks (R8): Satınalma, not ≥ 10 + projenin kanıt belgesi; kanıt ya da elle kuralı. Tamamlanmış projede yeniden koşu kuyruğa girer. */
export async function addMark(tx: Tx, ctx: TenantContext, projectId: string, b: { ruleCode: string; result: 'PASS' | 'FAIL'; note: string; documentVersionId: string }) {
  const p = await projectHead(tx, projectId);
  if (!ctx.companyIds.includes(p.company_id)) throw notFound();
  if (b.result !== 'PASS' && b.result !== 'FAIL') throw unprocessable('invalid_result', 'Sonuç "Karşılandı" ya da "Karşılanmadı" olmalı.');
  const note = (b.note ?? '').trim();
  if (note.length < 10) throw unprocessable('note_required', 'Elle işaret için en az 10 karakterlik not yazın.');
  if (note.length > 4000) throw unprocessable('note_too_long', 'Not en fazla 4000 karakter olabilir.');
  const rule = (await markableRules(tx, projectId, p.completed_on)).find((r) => r.code === b.ruleCode);
  if (!rule) throw unprocessable('invalid_rule', 'Bu kural elle işaretlenemez: yalnız projenin kural setindeki kanıt ve elle kuralları işaretlenir.');
  // Kanıt belgesi bu kural için (kuralın kontrol anahtarı ya da koduyla) yüklenmiş olmalı.
  const ev = (await tx.query(`SELECT 1 FROM compliance_evidence WHERE project_id = $1 AND document_version_id = $2 AND check_key = ANY($3::text[]) LIMIT 1`,
    [projectId, b.documentVersionId, [rule.checkKey, rule.code].filter(Boolean)])).rowCount;
  if (!ev) throw unprocessable('invalid_evidence', 'Kanıt belgesi bu projede bu kural için yüklenmiş uyum kanıtlarından seçilmeli.');
  const m = (await tx.query<{ id: string; marked_at: Date }>(`INSERT INTO compliance_manual_marks (tenant_id, company_id, project_id, rule_code, result, note, document_version_id, marked_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, marked_at`, [ctx.tenantId, p.company_id, projectId, rule.code, b.result, note, b.documentVersionId, ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'compliance.marked', 'project', projectId, { markId: m.id, ruleCode: rule.code, result: b.result, documentVersionId: b.documentVersionId });
  const rerun = p.status === 'COMPLETED' && can(ctx.roles, 'compliance.run') ? await requestRerun(tx, ctx, projectId) : null;
  return { mark: { id: m.id, ruleCode: rule.code, result: b.result, resultLabel: RESULT_TR[b.result], note, documentVersionId: b.documentVersionId, markedAt: m.marked_at },
    auditJobId: rerun?.jobId ?? null };
}

/** GET /compliance-audits (Denetçi ekranı): proje başına son koşu; süzgeç hüküm (ya da NO_RULESET/FAILED) ve departman. RLS departman kapsamı. */
export async function listAudits(tx: Tx, f: { verdict?: string; departmentId?: string }) {
  const rows = (await tx.query<AuditRow & { project_code: string; project_title: string; department_id: string | null; department_name: string | null; completed_on: string | null }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (a.project_id) a.id, a.project_id, a.run_no, a.rule_set_id, s.version_no, s.effective_from::text AS effective_from, a.trigger, a.status, a.score, a.verdict,
         a.summary, a.summary_source, a.ai_provider, a.ai_provider_is_test, a.run_by, u.display_name AS run_by_name, a.created_at,
         p.code AS project_code, p.title AS project_title, p.department_id, d.name AS department_name, p.completed_on::text AS completed_on
       FROM compliance_audits a JOIN projects p ON p.id = a.project_id LEFT JOIN departments d ON d.id = p.department_id
         LEFT JOIN procurement_rule_sets s ON s.id = a.rule_set_id LEFT JOIN users u ON u.id = a.run_by
       ORDER BY a.project_id, a.run_no DESC) x
     WHERE ($1::text IS NULL OR x.verdict = $1 OR x.status = $1) AND ($2::uuid IS NULL OR x.department_id = $2)
     ORDER BY x.completed_on DESC NULLS LAST, x.project_code`, [f.verdict ?? null, f.departmentId ?? null])).rows;
  return {
    items: rows.map((r) => ({ ...summaryView(r), auditId: r.id, projectId: r.project_id, projectCode: r.project_code, projectTitle: r.project_title,
      departmentId: r.department_id, departmentName: r.department_name, completedOn: r.completed_on, ruleSetVersion: r.version_no })),
    verdicts: [...(['COMPLIANT', 'NONCOMPLIANT', 'NO_RULES'] as const).map((k) => ({ key: k, label: VERDICT_TR[k] })),
      { key: 'NO_RULESET', label: AUDIT_STATUS_TR.NO_RULESET }, { key: 'FAILED', label: AUDIT_STATUS_TR.FAILED }],
  };
}

/** PDF verisi: koşu + proje başlığı. Görünmeyen koşu 404 (RLS). */
export async function auditForPdf(tx: Tx, auditId: string) {
  const d = await auditDetail(tx, auditId);
  const p = await projectHead(tx, d.projectId);
  return { ...d, project: { code: p.code, title: p.title, completedOn: p.completed_on, departmentName: p.department_name } };
}
export type AuditForPdf = Awaited<ReturnType<typeof auditForPdf>>;

export const pdfFilename = (code: string, runNo: number) => `${code}-uyum-denetimi-koşu-${runNo}.pdf`;
export const asciiFilename = (name: string) => name.replace(/[çÇ]/g, (c) => (c === 'ç' ? 'c' : 'C')).replace(/[ğĞ]/g, (c) => (c === 'ğ' ? 'g' : 'G'))
  .replace(/ı/g, 'i').replace(/İ/g, 'I').replace(/[öÖ]/g, (c) => (c === 'ö' ? 'o' : 'O')).replace(/[şŞ]/g, (c) => (c === 'ş' ? 's' : 'S'))
  .replace(/[üÜ]/g, (c) => (c === 'ü' ? 'u' : 'U')).replace(/[^\w.\-]/g, '_');
