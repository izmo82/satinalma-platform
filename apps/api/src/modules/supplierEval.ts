import { createHash } from 'node:crypto';
import {
  assessmentOutcome, criticalBlock, DEFAULT_INCIDENT_POLICY, DEFAULT_WEIGHTS, DIMENSION_TR, incidentImpact, inherentRisk, LEVEL_TR, MIN_SAMPLE,
  PERFORMANCE_DIMENSIONS, performanceScore, validateResidual, validateWeights,
  type AnswerState, type Dimension, type IncidentState, type InherentFactors, type Level, type QuestionDef,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';

/**
 * Faz 5: tedarikçi değerlendirmesi (02 §8–9, UX12, T19–T20). Sonuçlar saklanmaz; yanıt, bulgu ve olaylardan her okumada
 * domain kurallarıyla türetilir. Kalan risk ve olay doğrulaması insan kararıdır; AI kullanılmaz.
 */

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;

// --- Anket şablonu ------------------------------------------------------------------------------

export interface TemplateInput { code: string; name: string; category: string;
  questions: { controlId: string; reference: string; text: string; critical: boolean; evidenceRequired: boolean }[] }

/** Yeni sürüm taslağı: aynı kodla önceki sürümler değişmez; değişiklik yeni sürümdür. */
export async function createTemplate(tx: Tx, ctx: TenantContext, b: TemplateInput) {
  if (!b.questions.length) throw unprocessable('questions_required', 'Şablonda en az bir soru olmalı.');
  const ids = b.questions.map((q) => q.controlId.trim());
  if (new Set(ids).size !== ids.length) throw unprocessable('duplicate_control', 'Kontrol kimlikleri tekil olmalı.');
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`qtemplate:${ctx.tenantId}:${b.code}`]);
  const version = (await tx.query<{ v: number }>(`SELECT coalesce(max(version), 0) + 1 AS v FROM questionnaire_templates WHERE code = $1`, [b.code.trim()])).rows[0]!.v;
  const t = (await tx.query<{ id: string }>(`INSERT INTO questionnaire_templates (tenant_id, code, version, name, category, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, b.code.trim(), version, b.name.trim(), b.category.trim(), ctx.userId])).rows[0]!;
  let n = 0;
  for (const q of b.questions) {
    await tx.query(`INSERT INTO questionnaire_questions (tenant_id, template_id, ordinal, control_id, reference, text, critical, evidence_required) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.tenantId, t.id, ++n, q.controlId.trim(), q.reference.trim(), q.text.trim(), q.critical, q.evidenceRequired]);
  }
  await audit(tx, ctx, 'questionnaire.created', 'questionnaire_template', t.id, { code: b.code, version, questions: n });
  return { id: t.id, version };
}

export async function publishTemplate(tx: Tx, ctx: TenantContext, id: string) {
  const t = (await tx.query<{ code: string; status: string; created_by: string }>(`SELECT code, status, created_by FROM questionnaire_templates WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!t) throw notFound();
  if (t.status !== 'DRAFT') throw conflict('not_draft', 'Yalnız taslak şablon yayımlanır.');
  await tx.query(`UPDATE questionnaire_templates SET status = 'RETIRED' WHERE code = $1 AND status = 'PUBLISHED'`, [t.code]);
  await tx.query(`UPDATE questionnaire_templates SET status = 'PUBLISHED', published_by = $2, published_at = now() WHERE id = $1`, [id, ctx.userId]);
  await audit(tx, ctx, 'questionnaire.published', 'questionnaire_template', id, { code: t.code });
  return { status: 'PUBLISHED' };
}

export async function listTemplates(tx: Tx) {
  return (await tx.query(`SELECT t.id, t.code, t.version, t.name, t.category, t.status, t.created_at AS "createdAt", t.published_at AS "publishedAt",
      (SELECT count(*)::int FROM questionnaire_questions q WHERE q.template_id = t.id) AS questions,
      (SELECT count(*)::int FROM questionnaire_questions q WHERE q.template_id = t.id AND q.critical) AS critical
    FROM questionnaire_templates t ORDER BY t.code, t.version DESC`)).rows;
}

async function questionsOf(tx: Tx, templateId: string) {
  return (await tx.query<QuestionDef & { ordinal: number; reference: string }>(`SELECT id, ordinal, control_id AS "controlId", reference, text, critical, evidence_required AS "evidenceRequired"
    FROM questionnaire_questions WHERE template_id = $1 ORDER BY ordinal`, [templateId])).rows;
}

export async function getTemplate(tx: Tx, id: string) {
  const t = (await tx.query(`SELECT id, code, version, name, category, status FROM questionnaire_templates WHERE id = $1`, [id])).rows[0];
  if (!t) throw notFound();
  return { template: t, questions: await questionsOf(tx, id) };
}

// --- Değerlendirme -------------------------------------------------------------------------------

export async function createAssessment(tx: Tx, ctx: TenantContext, b: { supplierId: string; templateId: string; scope: string; inherentFactors: InherentFactors; reviewDue?: string | null }) {
  const t = (await tx.query<{ status: string; code: string }>(`SELECT status, code FROM questionnaire_templates WHERE id = $1`, [b.templateId])).rows[0];
  if (!t) throw notFound();
  if (t.status !== 'PUBLISHED') throw conflict('template_not_published', 'Değerlendirme yalnız yayımlanmış şablonla başlatılır.');
  if (!(await tx.query(`SELECT 1 FROM suppliers WHERE id = $1`, [b.supplierId])).rowCount) throw notFound();
  for (const k of Object.keys(b.inherentFactors) as (keyof InherentFactors)[]) if (!LEVELS.includes(b.inherentFactors[k])) throw unprocessable('invalid_factor', 'Risk faktörü LOW/MEDIUM/HIGH olmalı.');
  const a = (await tx.query<{ id: string }>(`INSERT INTO supplier_assessments (tenant_id, supplier_id, template_id, scope, inherent_factors, review_due, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.tenantId, b.supplierId, b.templateId, b.scope.trim(), b.inherentFactors, b.reviewDue ?? null, ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'assessment.created', 'supplier_assessment', a.id, { supplierId: b.supplierId, templateId: b.templateId, inherent: inherentRisk(b.inherentFactors).level });
  return { id: a.id };
}

async function loadAssessment(tx: Tx, id: string) {
  const a = (await tx.query<{ id: string; supplier_id: string; supplier_name: string; template_id: string; scope: string; status: string; inherent_factors: InherentFactors;
    residual_level: Level | null; residual_reason: string | null; residual_accepted_at: Date | null; accepted_by_name: string | null; review_due: string | null;
    created_by: string; created_by_name: string; created_at: Date; reviewed_by_name: string | null; reviewed_at: Date | null }>(
    `SELECT a.id, a.supplier_id, s.legal_name AS supplier_name, a.template_id, a.scope, a.status, a.inherent_factors, a.residual_level, a.residual_reason, a.residual_accepted_at,
      ua.display_name AS accepted_by_name, a.review_due::text, a.created_by, uc.display_name AS created_by_name, a.created_at, ur.display_name AS reviewed_by_name, a.reviewed_at
     FROM supplier_assessments a JOIN suppliers s ON s.id = a.supplier_id JOIN users uc ON uc.id = a.created_by
     LEFT JOIN users ua ON ua.id = a.residual_accepted_by LEFT JOIN users ur ON ur.id = a.reviewed_by WHERE a.id = $1`, [id])).rows[0];
  if (!a) throw notFound();
  return a;
}

async function evaluateAssessment(tx: Tx, id: string) {
  const a = await loadAssessment(tx, id);
  const questions = await questionsOf(tx, a.template_id);
  const answers = (await tx.query<AnswerState & { note: string | null; evidenceDate: string | null; evidenceTitle: string | null; answeredBy: string; answeredById: string; answeredAt: Date;
    findingNote: string | null; reviewedBy: string | null }>(
    `SELECT x.question_id AS "questionId", x.response, x.na_reason AS "naReason", x.note, x.evidence_document_version_id AS "evidenceDocumentVersionId",
      x.evidence_date::text AS "evidenceDate", x.evidence_expires::text AS "evidenceExpires", d.title AS "evidenceTitle", ua.display_name AS "answeredBy", x.answered_by AS "answeredById",
      x.answered_at AS "answeredAt", x.review, x.finding_severity AS "findingSeverity", x.finding_note AS "findingNote", ur.display_name AS "reviewedBy"
     FROM assessment_answers x JOIN users ua ON ua.id = x.answered_by LEFT JOIN users ur ON ur.id = x.reviewed_by
     LEFT JOIN document_versions dv ON dv.id = x.evidence_document_version_id LEFT JOIN documents d ON d.id = dv.document_id WHERE x.assessment_id = $1`, [id])).rows;
  const result = assessmentOutcome(questions, answers, today());
  return { a, questions, answers, result, inherent: inherentRisk(a.inherent_factors) };
}

export async function getAssessment(tx: Tx, ctx: TenantContext, id: string) {
  const { a, questions, answers, result, inherent } = await evaluateAssessment(tx, id);
  return {
    assessment: { id: a.id, supplierId: a.supplier_id, supplierName: a.supplier_name, scope: a.scope, status: a.status, inherentFactors: a.inherent_factors, reviewDue: a.review_due,
      createdBy: a.created_by_name, createdByMe: a.created_by === ctx.userId, createdAt: a.created_at, reviewedBy: a.reviewed_by_name, reviewedAt: a.reviewed_at,
      residual: a.residual_level ? { level: a.residual_level, reason: a.residual_reason, acceptedBy: a.accepted_by_name, acceptedAt: a.residual_accepted_at } : null },
    template: (await tx.query(`SELECT id, code, version, name, category FROM questionnaire_templates WHERE id = $1`, [a.template_id])).rows[0],
    questions, answers: answers.map(({ answeredById, ...x }) => ({ ...x, answeredByMe: answeredById === ctx.userId })), inherent, ...result,
  };
}

export interface AnswerInput { response: AnswerState['response']; naReason?: string | null; note?: string | null; evidenceDocumentVersionId?: string | null; evidenceDate?: string | null; evidenceExpires?: string | null }

/** Yanıt kaydı (tedarikçinin beyanı, kurum kullanıcısı girer). Yanıt değişirse önceki inceleme geçersizleşir. */
export async function saveAnswer(tx: Tx, ctx: TenantContext, assessmentId: string, questionId: string, b: AnswerInput) {
  const a = await loadAssessment(tx, assessmentId);
  if (a.status !== 'OPEN') throw conflict('assessment_closed', 'İncelemesi tamamlanmış değerlendirme değişmez; yeni değerlendirme başlatın.');
  if (!(await tx.query(`SELECT 1 FROM questionnaire_questions WHERE id = $1 AND template_id = $2`, [questionId, a.template_id])).rowCount) throw unprocessable('question_not_in_template', 'Soru bu şablona ait değil.');
  if (b.response === 'NOT_APPLICABLE' && (b.naReason ?? '').trim().length < 10) throw unprocessable('na_reason_required', '"Uygulanamaz" yanıtı gerekçe ister (en az 10 karakter).');
  if (b.evidenceDocumentVersionId && !(await tx.query(`SELECT 1 FROM document_versions WHERE id = $1 AND basic_check_status = 'PASSED'`, [b.evidenceDocumentVersionId])).rowCount) {
    throw unprocessable('evidence_not_found', 'Kanıt belgesi bulunamadı veya güvenlik kontrolünden geçmedi.');
  }
  await tx.query(`INSERT INTO assessment_answers (tenant_id, assessment_id, question_id, response, na_reason, note, evidence_document_version_id, evidence_date, evidence_expires, answered_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (tenant_id, assessment_id, question_id) DO UPDATE SET response = EXCLUDED.response, na_reason = EXCLUDED.na_reason, note = EXCLUDED.note,
      evidence_document_version_id = EXCLUDED.evidence_document_version_id, evidence_date = EXCLUDED.evidence_date, evidence_expires = EXCLUDED.evidence_expires,
      answered_by = EXCLUDED.answered_by, answered_at = now(), review = NULL, finding_severity = NULL, finding_note = NULL, reviewed_by = NULL, reviewed_at = NULL`,
    [ctx.tenantId, assessmentId, questionId, b.response, b.naReason?.trim() || null, b.note?.trim() || null, b.evidenceDocumentVersionId ?? null, b.evidenceDate ?? null, b.evidenceExpires ?? null, ctx.userId]);
  await audit(tx, ctx, 'assessment.answered', 'supplier_assessment', assessmentId, { questionId, response: b.response, evidence: !!b.evidenceDocumentVersionId });
  return { ok: true };
}

/** Değerlendirici incelemesi: yanıtı giren kişi kendi yanıtını onaylayamaz (görev ayrılığı). */
export async function reviewAnswer(tx: Tx, ctx: TenantContext, assessmentId: string, questionId: string, b: { review: 'ACCEPTED' | 'FINDING'; findingSeverity?: Level | null; findingNote?: string | null }) {
  const a = await loadAssessment(tx, assessmentId);
  if (a.status !== 'OPEN') throw conflict('assessment_closed', 'İncelemesi tamamlanmış değerlendirme değişmez.');
  const ans = (await tx.query<{ answered_by: string }>(`SELECT answered_by FROM assessment_answers WHERE assessment_id = $1 AND question_id = $2`, [assessmentId, questionId])).rows[0];
  if (!ans) throw unprocessable('answer_required', 'Önce yanıt girilmeli.');
  if (ans.answered_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Yanıtı giren kişi kendi yanıtını inceleyemez.');
  if (b.review === 'FINDING' && (!b.findingSeverity || (b.findingNote ?? '').trim().length < 10)) throw unprocessable('finding_details', 'Bulgu için şiddet ve açıklama (en az 10 karakter) gerekli.');
  await tx.query(`UPDATE assessment_answers SET review = $3, finding_severity = $4, finding_note = $5, reviewed_by = $6, reviewed_at = now() WHERE assessment_id = $1 AND question_id = $2`,
    [assessmentId, questionId, b.review, b.review === 'FINDING' ? b.findingSeverity : null, b.review === 'FINDING' ? b.findingNote!.trim() : null, ctx.userId]);
  await audit(tx, ctx, 'assessment.reviewed_answer', 'supplier_assessment', assessmentId, { questionId, review: b.review, severity: b.findingSeverity ?? null });
  return { ok: true };
}

/** İnceleme tamamlanır: her soru yanıtlanmış ve incelenmiş olmalı. Kritik engel varsa sorumlulara görev düşer. */
export async function completeReview(tx: Tx, ctx: TenantContext, id: string) {
  const { a, result } = await evaluateAssessment(tx, id);
  if (a.status !== 'OPEN') throw conflict('assessment_closed', 'Değerlendirme zaten tamamlandı.');
  if (!result.reviewedAll) throw unprocessable('review_incomplete', 'Tüm sorular yanıtlanmadan ve incelenmeden değerlendirme tamamlanamaz.');
  await tx.query(`UPDATE supplier_assessments SET status = 'REVIEWED', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [id, ctx.userId]);
  // Önceki değerlendirmenin yerini yalnız bağımsız incelemesi tamamlanan yeni değerlendirme alır; boş bir taslak engeli kaldıramaz (T20).
  await tx.query(`UPDATE supplier_assessments a SET status = 'SUPERSEDED' FROM questionnaire_templates t, questionnaire_templates mine
    WHERE t.id = a.template_id AND mine.id = $3 AND t.code = mine.code AND a.supplier_id = $2 AND a.id <> $1 AND a.status <> 'SUPERSEDED'`, [id, a.supplier_id, a.template_id]);
  if (result.outcome === 'BLOCKED') {
    for (const role of ['PROCUREMENT_MANAGER', 'SECURITY']) {
      await openTask(tx, ctx, { companyId: null, kind: 'assessment_blocker', entityType: 'supplier', entityId: a.supplier_id, title: `Kritik engel: ${a.supplier_name}`,
        reason: result.items.filter((x) => x.kind === 'BLOCKER').map((x) => x.message).join(' '), nextAction: 'Düzeltici faaliyet isteyin veya tedarikçiyle yeni işlem yapılmamasına karar verin.',
        assigneeRole: role, severity: 'HIGH', dedupeKey: `assessment-blocker:${id}:${role}` });
    }
  }
  await audit(tx, ctx, 'assessment.completed', 'supplier_assessment', id, { outcome: result.outcome, compliance: result.complianceRate });
  return { outcome: result.outcome };
}

/** Kalan risk kabulü: risk sahibi (değerlendirmeyi açan kişi değil) gerekçeyle; belgesiz otomatik indirim yok. */
export async function acceptResidual(tx: Tx, ctx: TenantContext, id: string, b: { level: Level; reason: string }) {
  const { a, answers, result, inherent } = await evaluateAssessment(tx, id);
  if (a.status !== 'REVIEWED') throw conflict('review_required', 'Kalan risk, inceleme tamamlandıktan sonra kabul edilir.');
  if (a.created_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Değerlendirmeyi açan kişi kalan riski kabul edemez.');
  if (result.outcome === 'BLOCKED' && b.level !== 'CRITICAL') throw unprocessable('blocked_assessment', 'Kritik engel varken kalan risk düşük kabul edilemez; önce engel giderilmeli.');
  // Kontrol kanıtı: değerlendiricinin kabul ettiği, kanıt belgesi eklenmiş ve süresi dolmamış yanıt. Yalnız beyan kanıt sayılmaz.
  const accepted = answers.filter((x) => x.review === 'ACCEPTED' && (x.response === 'YES' || x.response === 'PARTIAL') && x.evidenceDocumentVersionId
    && (!x.evidenceExpires || x.evidenceExpires >= today())).length;
  const err = validateResidual(inherent.level, b.level, b.reason, accepted);
  if (err) throw unprocessable('invalid_residual', err);
  await tx.query(`UPDATE supplier_assessments SET residual_level = $2, residual_reason = $3, residual_accepted_by = $4, residual_accepted_at = now() WHERE id = $1`, [id, b.level, b.reason.trim(), ctx.userId]);
  await audit(tx, ctx, 'assessment.residual_accepted', 'supplier_assessment', id, { inherent: inherent.level, residual: b.level }, b.reason);
  return { residual: b.level };
}

/** Tedarikçinin güncel (yerini başkası almamış) değerlendirmeleri ve türetilmiş sonuçları. */
export async function supplierAssessments(tx: Tx, ctx: TenantContext, supplierId: string) {
  const ids = (await tx.query<{ id: string }>(`SELECT id FROM supplier_assessments WHERE supplier_id = $1 ORDER BY created_at DESC LIMIT 50`, [supplierId])).rows;
  const out = [];
  for (const { id } of ids) {
    const r = await evaluateAssessment(tx, id);
    const t = (await tx.query<{ name: string; version: number; category: string }>(`SELECT name, version, category FROM questionnaire_templates WHERE id = $1`, [r.a.template_id])).rows[0]!;
    out.push({ id, scope: r.a.scope, status: r.a.status, template: `${t.name} v${t.version}`, category: t.category, outcome: r.result.outcome, complianceRate: r.result.complianceRate,
      blockers: r.result.items.filter((x) => x.kind === 'BLOCKER').length, findings: r.result.items.filter((x) => x.kind === 'FINDING').length,
      inherent: r.inherent.level, residual: r.a.residual_level, createdAt: r.a.created_at, reviewDue: r.a.review_due });
  }
  void ctx;
  return out;
}

/** T20: güncel değerlendirmesinde kritik engel olan tedarikçiler (seçim, onay ve sipariş bu engeli aşamaz). */
export async function criticalBlocks(tx: Tx, supplierIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!supplierIds.length) return out;
  const rows = (await tx.query<{ id: string; supplier_id: string; scope: string }>(`SELECT id, supplier_id, scope FROM supplier_assessments WHERE supplier_id = ANY($1::uuid[]) AND status = 'REVIEWED'`, [supplierIds])).rows;
  for (const r of rows) {
    if (out.has(r.supplier_id)) continue;
    const { result } = await evaluateAssessment(tx, r.id);
    const msg = criticalBlock({ outcome: result.outcome, scope: r.scope });
    if (msg) out.set(r.supplier_id, msg);
  }
  return out;
}

// --- Olay ve düzeltici faaliyet --------------------------------------------------------------------

export interface IncidentInput {
  supplierId: string; contractVersionId?: string | null; poId?: string | null; category: string; severity: Level; title: string; description: string;
  impact?: string | null; location?: string | null; occurredOn: string;
}

export async function reportIncident(tx: Tx, ctx: TenantContext, b: IncidentInput, idempotencyKey?: string) {
  const bodyHash = idempotencyKey ? createHash('sha256').update(JSON.stringify([b.supplierId, b.contractVersionId ?? null, b.poId ?? null, b.category, b.severity, b.title.trim(),
    b.description.trim(), b.impact?.trim() || null, b.location?.trim() || null, b.occurredOn])).digest('hex') : null;
  if (idempotencyKey) {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`incident-idem:${ctx.tenantId}:${idempotencyKey}`]);
    const prev = (await tx.query<{ id: string; code: string; idempotency_hash: string | null }>(`SELECT id, code, idempotency_hash FROM supplier_incidents WHERE idempotency_key = $1`, [idempotencyKey])).rows[0];
    if (prev) {
      // Aynı anahtar farklı içerikle (ör. düzeltilmiş tedarikçi/şiddet) gelirse eski olay "bildirildi" diye dönmez.
      if (prev.idempotency_hash !== bodyHash) throw conflict('idempotency_mismatch', 'Aynı istek anahtarı farklı bir olay bildirimi için kullanıldı; ekranı yenileyip yeni bildirim açın.');
      return { id: prev.id, code: prev.code, possibleDuplicates: [], duplicate: true };
    }
  }
  if (!(await tx.query(`SELECT 1 FROM suppliers WHERE id = $1`, [b.supplierId])).rowCount) throw notFound();
  if (b.occurredOn > today()) throw unprocessable('future_date', 'Olay tarihi gelecekte olamaz.');
  // Bağlı sipariş/sözleşme aynı tedarikçiye ait ve bildirenin erişebildiği kayıt olmalı (RLS görünürlüğü).
  if (b.poId && !(await tx.query(`SELECT 1 FROM purchase_orders WHERE id = $1 AND supplier_id = $2`, [b.poId, b.supplierId])).rowCount) throw unprocessable('invalid_reference', 'Sipariş bu tedarikçiye ait değil veya erişiminiz yok.');
  if (b.contractVersionId && !(await tx.query(`SELECT 1 FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id WHERE cv.id = $1 AND (f.supplier_id IS NULL OR f.supplier_id = $2)`, [b.contractVersionId, b.supplierId])).rowCount) throw unprocessable('invalid_reference', 'Sözleşme bu tedarikçiye ait değil veya erişiminiz yok.');
  const n = (await tx.query<{ value: string }>(`INSERT INTO tenant_counters (tenant_id, name, value) VALUES ($1, 'incident', 1)
    ON CONFLICT (tenant_id, name) DO UPDATE SET value = tenant_counters.value + 1 RETURNING value`, [ctx.tenantId])).rows[0]!.value;
  const code = `OLY-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
  const i = (await tx.query<{ id: string }>(`INSERT INTO supplier_incidents (tenant_id, code, supplier_id, contract_version_id, po_id, category, severity, title, description, impact, location, occurred_on, reported_by, idempotency_key, idempotency_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [ctx.tenantId, code, b.supplierId, b.contractVersionId ?? null, b.poId ?? null, b.category, b.severity,
      b.title.trim(), b.description.trim(), b.impact?.trim() || null, b.location?.trim() || null, b.occurredOn, ctx.userId, idempotencyKey ?? null, bodyHash])).rows[0]!;
  await tx.query(`INSERT INTO incident_events (tenant_id, incident_id, kind, to_status, note, actor) VALUES ($1,$2,'REPORTED','REPORTED',$3,$4)`, [ctx.tenantId, i.id, b.description.trim(), ctx.userId]);
  // Mükerrer olay kontrolü: aynı tedarikçi, kategori ve ±3 gün içindeki açık olaylar aday olarak gösterilir; otomatik birleştirilmez.
  const possibleDuplicates = (await tx.query(`SELECT id, code, title, occurred_on::text AS "occurredOn" FROM supplier_incidents WHERE supplier_id = $1 AND category = $2 AND id <> $3
    AND duplicate_of_id IS NULL AND status NOT IN ('REJECTED') AND abs(occurred_on - $4::date) <= 3`, [b.supplierId, b.category, i.id, b.occurredOn])).rows;
  await openTask(tx, ctx, { companyId: null, kind: 'incident_review', entityType: 'incident', entityId: i.id, title: `Olay ön incelemesi: ${code}`,
    reason: `${b.title.trim()} (${LEVEL_TR[b.severity]})${possibleDuplicates.length ? ` · ${possibleDuplicates.length} olası mükerrer` : ''}`,
    nextAction: 'Mükerrer, gizlilik ve aciliyet kontrolü yapıp incelemeyi başlatın.', assigneeRole: b.category === 'SECURITY' || b.category === 'PERSONAL_DATA' ? 'SECURITY' : 'PROCUREMENT_MANAGER',
    severity: b.severity === 'HIGH' || b.severity === 'CRITICAL' ? 'HIGH' : 'NORMAL', dedupeKey: `incident-review:${i.id}` });
  await audit(tx, ctx, 'incident.reported', 'incident', i.id, { code, supplierId: b.supplierId, category: b.category, severity: b.severity });
  return { id: i.id, code, possibleDuplicates };
}

type Action = 'START_REVIEW' | 'VERIFY' | 'REJECT' | 'DISPUTE' | 'RESOLVE_DISPUTE' | 'MARK_DUPLICATE' | 'CLOSE' | 'REOPEN';

/** Olay durum geçişleri (02 §9 tablo). Önceki kayıt değişmez; her geçiş zaman çizelgesine yazılır. */
export async function transitionIncident(tx: Tx, ctx: TenantContext, id: string, action: Action,
  b: { note: string; severity?: Level; countedInMetric?: boolean; duplicateOfId?: string | null; upheld?: boolean; evidenceDocumentVersionId?: string | null }) {
  const i = (await tx.query<{ status: string; reported_by: string; dispute_open: boolean; supplier_id: string; category: string; severity: Level; code: string; title: string; verified_at: Date | null }>(
    `SELECT status, reported_by, dispute_open, supplier_id, category, severity, code, title, verified_at FROM supplier_incidents WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!i) throw notFound();
  if (b.note.trim().length < 10) throw unprocessable('note_required', 'Gerekçe/kanıt açıklaması gerekli (en az 10 karakter).');
  const bad = () => conflict('invalid_transition', `"${i.status}" durumundaki olayda bu işlem yapılamaz.`);
  let to = i.status; let kind: string = action;
  const set: Record<string, unknown> = {};
  switch (action) {
    case 'START_REVIEW': if (i.status !== 'REPORTED') throw bad(); to = 'UNDER_REVIEW'; kind = 'REVIEW_STARTED'; break;
    case 'VERIFY':
      if (i.status !== 'UNDER_REVIEW') throw bad();
      if (i.reported_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Olayı bildiren kişi doğrulayamaz.');
      to = 'VERIFIED'; kind = 'VERIFIED'; set.verified_by = ctx.userId; set.verified_at = new Date();
      if (b.severity) set.severity = b.severity;
      if (b.severity && b.severity !== i.severity) b = { ...b, note: `${b.note.trim()} (şiddet: ${LEVEL_TR[i.severity]} → ${LEVEL_TR[b.severity]})` };
      if (b.countedInMetric !== undefined) set.counted_in_metric = b.countedInMetric;
      break;
    case 'REJECT': if (!['REPORTED', 'UNDER_REVIEW'].includes(i.status)) throw bad(); to = 'REJECTED'; kind = 'REJECTED'; break;
    case 'DISPUTE': if (i.status !== 'VERIFIED' || i.dispute_open) throw bad(); set.dispute_open = true; kind = 'DISPUTED'; break;
    case 'RESOLVE_DISPUTE':
      if (!i.dispute_open) throw bad();
      set.dispute_open = false; kind = 'DISPUTE_RESOLVED';
      // İtiraz haklı bulunursa olay doğrulanmamış sayılır; önceki doğrulama izi zaman çizelgesinde kalır.
      if (b.upheld === false) { to = 'REJECTED'; set.verified_by = null; set.verified_at = null; }
      break;
    case 'MARK_DUPLICATE': {
      // Mükerrer işaretleme ön incelemede yapılır; doğrulanmış olayın cezası mükerrer işaretiyle silinemez.
      if (!['REPORTED', 'UNDER_REVIEW'].includes(i.status)) throw bad();
      if (!b.duplicateOfId || b.duplicateOfId === id) throw unprocessable('duplicate_target', 'Asıl olay seçilmeli.');
      const t = (await tx.query<{ supplier_id: string; duplicate_of_id: string | null; status: string }>(`SELECT supplier_id, duplicate_of_id, status FROM supplier_incidents WHERE id = $1`, [b.duplicateOfId])).rows[0];
      if (!t || t.supplier_id !== i.supplier_id || t.duplicate_of_id || t.status === 'REJECTED') throw unprocessable('duplicate_target', 'Asıl olay aynı tedarikçinin reddedilmemiş, mükerrer olmayan bir olayı olmalı.');
      set.duplicate_of_id = b.duplicateOfId; to = 'REJECTED'; kind = 'DUPLICATE'; break;
    }
    case 'CLOSE': {
      if (i.status !== 'VERIFIED' || i.dispute_open) throw bad();
      const open = Number((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM corrective_actions WHERE incident_id = $1 AND status <> 'VERIFIED'`, [id])).rows[0]!.n);
      if (open) throw conflict('actions_open', `${open} düzeltici faaliyet bağımsız doğrulanmadan olay kapatılamaz.`);
      to = 'CLOSED'; kind = 'CLOSED'; set.closed_by = ctx.userId; set.closed_at = new Date(); break;
    }
    case 'REOPEN': if (!['CLOSED', 'REJECTED'].includes(i.status)) throw bad(); to = i.verified_at && i.status === 'CLOSED' ? 'VERIFIED' : 'UNDER_REVIEW'; kind = 'REOPENED';
      // Yeniden açma mükerrer işaretini de kaldırır (yanlış işaretleme geri alınabilir).
      set.closed_by = null; set.closed_at = null; set.duplicate_of_id = null; break;
  }
  set.status = to;
  const cols = Object.keys(set);
  await tx.query(`UPDATE supplier_incidents SET ${cols.map((c, n) => `${c} = $${n + 2}`).join(', ')} WHERE id = $1`, [id, ...cols.map((c) => set[c])]);
  await tx.query(`INSERT INTO incident_events (tenant_id, incident_id, kind, from_status, to_status, note, evidence_document_version_id, actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.tenantId, id, kind, i.status, to, b.note.trim(), b.evidenceDocumentVersionId ?? null, ctx.userId]);
  if (action === 'START_REVIEW' || action === 'REJECT' || action === 'VERIFY' || action === 'MARK_DUPLICATE') await closeTasks(tx, `incident-review:${id}`);
  // İtiraz süresiz açık kalmaz: sonuçlandırma görevi son tarihle açılır; itiraz açıkken ceza askıdadır.
  if (action === 'DISPUTE') {
    await openTask(tx, ctx, { companyId: null, kind: 'incident_dispute', entityType: 'incident', entityId: id, title: `İtiraz sonuçlandırma: ${i.code}`,
      reason: b.note.trim(), nextAction: 'Tedarikçi itirazını kanıtla değerlendirip sonuçlandırın.', assigneeRole: 'PROCUREMENT_MANAGER',
      dueAt: new Date(Date.now() + 14 * 86_400_000), severity: 'HIGH', dedupeKey: `incident-dispute:${id}` });
  }
  if (action === 'RESOLVE_DISPUTE') await closeTasks(tx, `incident-dispute:${id}`);
  // Ciddi güvenlik/kişisel veri olayı: yeniden risk incelemesi ve yeni işlem kararı görevleri. Dış bildirim kendiliğinden gönderilmez.
  const severity = (set.severity as Level | undefined) ?? i.severity;
  if (action === 'VERIFY' && ['SECURITY', 'PERSONAL_DATA'].includes(i.category) && (severity === 'HIGH' || severity === 'CRITICAL')) {
    await openTask(tx, ctx, { companyId: null, kind: 'risk_rereview', entityType: 'supplier', entityId: i.supplier_id, title: `Risk yeniden incelemesi: ${i.code}`,
      reason: `Doğrulanmış ${LEVEL_TR[severity]} ${i.category === 'SECURITY' ? 'güvenlik' : 'kişisel veri'} olayı: ${i.title}`, nextAction: 'Değerlendirmeyi yenileyin; hukuki/düzenleyici bildirim gerekip gerekmediğini hukukla karara bağlayın.',
      assigneeRole: 'SECURITY', severity: severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH', dedupeKey: `risk-rereview:${id}` });
    await openTask(tx, ctx, { companyId: null, kind: 'new_business_hold', entityType: 'supplier', entityId: i.supplier_id, title: `Yeni işlem kararı: ${i.code}`,
      reason: 'Ciddi olay doğrulandı; yeni sipariş/seçim durdurulmalı mı?', nextAction: 'Yeni işlem durdurma kararını verin; sistem otomatik durdurmaz.',
      assigneeRole: 'PROCUREMENT_MANAGER', severity: severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH', dedupeKey: `new-business-hold:${id}` });
  }
  await audit(tx, ctx, `incident.${kind.toLowerCase()}`, 'incident', id, { from: i.status, to, ...Object.fromEntries(Object.entries(set).filter(([k]) => !k.endsWith('_at'))) }, b.note);
  return { status: to, disputeOpen: set.dispute_open ?? i.dispute_open };
}

export async function addCorrectiveAction(tx: Tx, ctx: TenantContext, incidentId: string, b: { title: string; ownerRole: string; dueDate: string }) {
  const i = (await tx.query<{ status: string; code: string }>(`SELECT status, code FROM supplier_incidents WHERE id = $1`, [incidentId])).rows[0];
  if (!i) throw notFound();
  if (!['UNDER_REVIEW', 'VERIFIED'].includes(i.status)) throw conflict('invalid_state', 'Düzeltici faaliyet incelenen veya doğrulanmış olaya eklenir.');
  const a = (await tx.query<{ id: string }>(`INSERT INTO corrective_actions (tenant_id, incident_id, title, owner_role, due_date, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.tenantId, incidentId, b.title.trim(), b.ownerRole, b.dueDate, ctx.userId])).rows[0]!;
  await openTask(tx, ctx, { companyId: null, kind: 'corrective_action', entityType: 'incident', entityId: incidentId, title: `Düzeltici faaliyet: ${b.title.trim()}`,
    reason: `${i.code} için düzeltici faaliyet.`, nextAction: 'Faaliyeti tamamlayıp kanıtını yazın.', assigneeRole: b.ownerRole, dueAt: new Date(`${b.dueDate}T23:59:59+03:00`),
    dedupeKey: `corrective:${a.id}` });
  await tx.query(`INSERT INTO incident_events (tenant_id, incident_id, kind, note, actor) VALUES ($1,$2,'NOTE',$3,$4)`, [ctx.tenantId, incidentId, `Düzeltici faaliyet eklendi: ${b.title.trim()} (hedef ${b.dueDate})`, ctx.userId]);
  await audit(tx, ctx, 'incident.action_added', 'incident', incidentId, { actionId: a.id, ownerRole: b.ownerRole, dueDate: b.dueDate });
  return { id: a.id };
}

export async function completeAction(tx: Tx, ctx: TenantContext, actionId: string, note: string) {
  const a = (await tx.query<{ incident_id: string; owner_role: string; status: string }>(`SELECT incident_id, owner_role, status FROM corrective_actions WHERE id = $1 FOR UPDATE`, [actionId])).rows[0];
  if (!a) throw notFound();
  if (a.status !== 'OPEN') throw conflict('invalid_state', 'Faaliyet zaten tamamlandı.');
  if (!ctx.roles.includes(a.owner_role)) throw new ApiError(403, 'not_owner', 'Faaliyeti yalnız sorumlu rol tamamlar.');
  if (note.trim().length < 10) throw unprocessable('note_required', 'Ne yapıldığı ve kanıtı yazılmalı (en az 10 karakter).');
  await tx.query(`UPDATE corrective_actions SET status = 'DONE', done_note = $2, done_by = $3, done_at = now() WHERE id = $1`, [actionId, note.trim(), ctx.userId]);
  await closeTasks(tx, `corrective:${actionId}`);
  await openTask(tx, ctx, { companyId: null, kind: 'corrective_verify', entityType: 'incident', entityId: a.incident_id, title: 'Düzeltici faaliyet doğrulaması',
    reason: note.trim(), nextAction: 'Bağımsız olarak doğrulayın (tamamlayan kişi doğrulayamaz).', assigneeRole: 'PROCUREMENT_MANAGER', dedupeKey: `corrective-verify:${actionId}` });
  await tx.query(`INSERT INTO incident_events (tenant_id, incident_id, kind, note, actor) VALUES ($1,$2,'NOTE',$3,$4)`, [ctx.tenantId, a.incident_id, `Düzeltici faaliyet tamamlandı: ${note.trim()}`, ctx.userId]);
  await audit(tx, ctx, 'incident.action_done', 'incident', a.incident_id, { actionId });
  return { status: 'DONE' };
}

export async function verifyAction(tx: Tx, ctx: TenantContext, actionId: string) {
  const a = (await tx.query<{ incident_id: string; status: string; done_by: string }>(`SELECT incident_id, status, done_by FROM corrective_actions WHERE id = $1 FOR UPDATE`, [actionId])).rows[0];
  if (!a) throw notFound();
  if (a.status !== 'DONE') throw conflict('invalid_state', 'Yalnız tamamlanmış faaliyet doğrulanır.');
  if (a.done_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Faaliyeti tamamlayan kişi doğrulayamaz (bağımsız kapanış).');
  await tx.query(`UPDATE corrective_actions SET status = 'VERIFIED', verified_by = $2, verified_at = now() WHERE id = $1`, [actionId, ctx.userId]);
  await closeTasks(tx, `corrective-verify:${actionId}`);
  await tx.query(`INSERT INTO incident_events (tenant_id, incident_id, kind, note, actor) VALUES ($1,$2,'NOTE','Düzeltici faaliyet bağımsız doğrulandı.',$3)`, [ctx.tenantId, a.incident_id, ctx.userId]);
  await audit(tx, ctx, 'incident.action_verified', 'incident', a.incident_id, { actionId });
  return { status: 'VERIFIED' };
}

const incidentStateSql = `i.id, i.severity, i.category, i.status, i.verified_at::text AS "verifiedAt", i.dispute_open AS "disputeOpen", i.duplicate_of_id AS "duplicateOfId", i.counted_in_metric AS "countedInMetric"`;

export async function getIncident(tx: Tx, ctx: TenantContext, id: string) {
  const i = (await tx.query(`SELECT ${incidentStateSql}, i.code, i.title, i.description, i.impact, i.location, i.occurred_on::text AS "occurredOn", i.supplier_id AS "supplierId", s.legal_name AS "supplierName",
      i.contract_version_id AS "contractVersionId", f.title AS "contractTitle", i.po_id AS "poId", po.code AS "poCode", d.code AS "duplicateOfCode",
      ur.display_name AS "reportedBy", i.reported_by = $2 AS "reportedByMe", i.reported_at AS "reportedAt", uv.display_name AS "verifiedBy"
    FROM supplier_incidents i JOIN suppliers s ON s.id = i.supplier_id JOIN users ur ON ur.id = i.reported_by LEFT JOIN users uv ON uv.id = i.verified_by
    LEFT JOIN contract_versions cv ON cv.id = i.contract_version_id LEFT JOIN contract_families f ON f.id = cv.family_id LEFT JOIN purchase_orders po ON po.id = i.po_id
    LEFT JOIN supplier_incidents d ON d.id = i.duplicate_of_id WHERE i.id = $1`, [id, ctx.userId])).rows[0];
  if (!i) throw notFound();
  const events = (await tx.query(`SELECT e.kind, e.from_status AS "fromStatus", e.to_status AS "toStatus", e.note, e.at, u.display_name AS actor FROM incident_events e JOIN users u ON u.id = e.actor
    WHERE e.incident_id = $1 ORDER BY e.at`, [id])).rows;
  const actions = (await tx.query(`SELECT a.id, a.title, a.owner_role AS "ownerRole", a.due_date::text AS "dueDate", a.status, a.done_note AS "doneNote", ud.display_name AS "doneBy",
      a.done_by = $2 AS "doneByMe", uv.display_name AS "verifiedBy" FROM corrective_actions a LEFT JOIN users ud ON ud.id = a.done_by LEFT JOIN users uv ON uv.id = a.verified_by
    WHERE a.incident_id = $1 ORDER BY a.created_at`, [id, ctx.userId])).rows;
  const impact = incidentImpact([i as IncidentState]);
  return { incident: i, events, actions, scoreImpact: impact.counted[0] ? { counted: true, penalty: impact.counted[0].penalty, policy: impact.policyVersion } : { counted: false, reason: impact.excluded[0]!.reason, policy: impact.policyVersion } };
}

export async function listIncidents(tx: Tx, filter: { supplierId?: string }) {
  return (await tx.query(`SELECT ${incidentStateSql}, i.code, i.title, i.occurred_on::text AS "occurredOn", s.legal_name AS "supplierName", i.supplier_id AS "supplierId",
      (SELECT count(*)::int FROM corrective_actions a WHERE a.incident_id = i.id AND a.status = 'OPEN') AS "openActions",
      (SELECT count(*)::int FROM corrective_actions a WHERE a.incident_id = i.id AND a.status = 'DONE') AS "awaitingVerification"
    FROM supplier_incidents i JOIN suppliers s ON s.id = i.supplier_id WHERE ($1::uuid IS NULL OR i.supplier_id = $1) ORDER BY i.occurred_on DESC, i.code DESC LIMIT 300`, [filter.supplierId ?? null])).rows;
}

// --- Performans ve yıllık karne -----------------------------------------------------------------------

export async function addPerformanceReview(tx: Tx, ctx: TenantContext, supplierId: string, b: { periodStart: string; periodEnd: string; category: string; weights?: Record<Dimension, number>;
  scores: Partial<Record<Dimension, number>>; basis: string }) {
  const weights = b.weights ?? DEFAULT_WEIGHTS;
  const err = validateWeights(weights);
  if (err) throw unprocessable('invalid_weights', err);
  for (const [k, v] of Object.entries(b.scores)) if (!(PERFORMANCE_DIMENSIONS as readonly string[]).includes(k) || !Number.isInteger(v) || v < 0 || v > 100) throw unprocessable('invalid_score', 'Puanlar 0–100 tam sayı olmalı.');
  if (b.periodEnd < b.periodStart) throw unprocessable('invalid_period', 'Dönem sonu başlangıçtan önce olamaz.');
  if (b.periodEnd > today()) throw unprocessable('invalid_period', 'Dönem sonu bugünden sonra olamaz; tamamlanmış dönem değerlendirilir.');
  if (!(await tx.query(`SELECT 1 FROM suppliers WHERE id = $1`, [supplierId])).rowCount) throw notFound();
  const r = (await tx.query<{ id: string }>(`INSERT INTO performance_reviews (tenant_id, supplier_id, period_start, period_end, category, policy_version, weights, scores, basis, reviewed_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [ctx.tenantId, supplierId, b.periodStart, b.periodEnd, b.category.trim(), b.weights ? 'kurum-ozel' : 'ornek-2026-1', weights, b.scores, b.basis.trim(), ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'performance.reviewed', 'supplier', supplierId, { reviewId: r.id, period: [b.periodStart, b.periodEnd], scores: b.scores });
  return { id: r.id };
}

/** Teslimat/kabul örneklemi: dönemdeki pozitif kabul kayıtları (kullanıcının şirket kapsamındaki siparişler; RLS). */
async function sampleSize(tx: Tx, supplierId: string, from: string, to: string) {
  return Number((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM receipts r JOIN po_lines pl ON pl.id = r.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
    WHERE po.supplier_id = $1 AND r.quantity > 0 AND r.recorded_at >= $2::date AND r.recorded_at < ($3::date + 1)`, [supplierId, from, to])).rows[0]!.n);
}

async function yearSummary(tx: Tx, supplierId: string, year: number) {
  const from = `${year}-01-01`; const to = `${year}-12-31`;
  const review = (await tx.query<{ id: string; scores: Partial<Record<Dimension, number>>; weights: Record<Dimension, number>; policy_version: string; basis: string; period_start: string; period_end: string;
    category: string; reviewer: string; reviewed_at: Date }>(`SELECT r.id, r.scores, r.weights, r.policy_version, r.basis, r.period_start::text, r.period_end::text, r.category, u.display_name AS reviewer, r.reviewed_at
    FROM performance_reviews r JOIN users u ON u.id = r.reviewed_by WHERE r.supplier_id = $1 AND r.period_end >= $2 AND r.period_start <= $3 ORDER BY r.reviewed_at DESC LIMIT 1`, [supplierId, from, to])).rows[0] ?? null;
  const incidents = (await tx.query<IncidentState & { code: string; title: string; occurredOn: string }>(`SELECT ${incidentStateSql}, i.code, i.title, i.occurred_on::text AS "occurredOn"
    FROM supplier_incidents i WHERE i.supplier_id = $1 AND i.occurred_on BETWEEN $2 AND $3 ORDER BY i.occurred_on`, [supplierId, from, to])).rows;
  const impact = incidentImpact(incidents);
  const sample = await sampleSize(tx, supplierId, from, to);
  const perf = review ? performanceScore(review.scores, review.weights, sample, impact.penalty) : { score: null, insufficient: true as const, reason: 'Bu dönem için performans incelemesi yok.' };
  return { year, from, to, review, incidents, impact, sample, perf };
}

/**
 * Yıllık karne (AI12 deterministik): doğrulanmış metrikler, örneklem, olay etkisi, açık faaliyetler, risk ve kaynaklar.
 * Anlatı şablondan üretilir; LLM yok. Veri anı ve politika sürümleri görünür.
 */
export async function scorecard(tx: Tx, ctx: TenantContext, supplierId: string, year: number) {
  const s = (await tx.query<{ legal_name: string; status: string }>(`SELECT legal_name, status FROM suppliers WHERE id = $1`, [supplierId])).rows[0];
  if (!s) throw notFound();
  const cur = await yearSummary(tx, supplierId, year);
  const prev = await yearSummary(tx, supplierId, year - 1);
  const openActions = (await tx.query(`SELECT a.title, a.due_date::text AS "dueDate", a.status, i.code FROM corrective_actions a JOIN supplier_incidents i ON i.id = a.incident_id
    WHERE i.supplier_id = $1 AND a.status <> 'VERIFIED' ORDER BY a.due_date`, [supplierId])).rows as { title: string; dueDate: string; status: string; code: string }[];
  const assessments = await supplierAssessments(tx, ctx, supplierId);
  const current = assessments.filter((a) => a.status !== 'SUPERSEDED');
  const bySeverity = Object.fromEntries((['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as Level[]).map((l) => [l, cur.incidents.filter((x) => x.severity === l && cur.impact.counted.some((c) => c.id === x.id)).length]));
  const narrative: string[] = [];
  narrative.push(cur.perf.score !== null
    ? `${year} performans puanı ${cur.perf.score} (boyut ortalaması ${'base' in cur.perf ? cur.perf.base : '—'}, doğrulanmış olay cezası ${cur.impact.penalty}); örneklem ${cur.sample} kabul kaydı.`
    : `${year} için puan verilmedi: ${cur.perf.reason}`);
  if (cur.perf.score !== null && prev.perf.score !== null) narrative.push(`Önceki yıla göre ${cur.perf.score >= prev.perf.score ? '+' : ''}${Math.round((cur.perf.score - prev.perf.score) * 10) / 10} puan.`);
  narrative.push(`${cur.incidents.length} olay kaydı; ${cur.impact.counted.length} doğrulanmış olay puana yansıdı, ${cur.impact.excluded.length} olay yansımadı (iddia, itiraz, mükerrer veya ölçüme zaten yansımış).`);
  if (openActions.length) narrative.push(`${openActions.length} açık düzeltici faaliyet var; en yakın hedef tarih ${openActions[0]!.dueDate}.`);
  const blocked = current.filter((a) => a.outcome === 'BLOCKED');
  if (blocked.length) narrative.push(`Kritik engel: ${blocked.map((a) => a.scope).join(', ')}.`);
  return {
    supplier: { id: supplierId, name: s.legal_name, status: s.status }, year, dataAsOf: new Date().toISOString(),
    policy: { incident: DEFAULT_INCIDENT_POLICY.version, weights: cur.review?.policy_version ?? null, minSample: MIN_SAMPLE },
    performance: { ...cur.perf, sample: cur.sample, review: cur.review && { id: cur.review.id, period: [cur.review.period_start, cur.review.period_end], category: cur.review.category,
      scores: cur.review.scores, weights: cur.review.weights, basis: cur.review.basis, reviewer: cur.review.reviewer, reviewedAt: cur.review.reviewed_at },
      dimensions: PERFORMANCE_DIMENSIONS.map((d) => ({ key: d, label: DIMENSION_TR[d], score: cur.review?.scores[d] ?? null, weight: cur.review?.weights[d] ?? DEFAULT_WEIGHTS[d] })) },
    previous: { year: year - 1, score: prev.perf.score, insufficient: prev.perf.insufficient },
    reviewCount: Number((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM performance_reviews WHERE supplier_id = $1 AND period_end >= $2 AND period_start <= $3`, [supplierId, cur.from, cur.to])).rows[0]!.n),
    incidents: { total: cur.incidents.length, counted: cur.impact.counted.length, penalty: cur.impact.penalty, bySeverity,
      items: cur.incidents.map((x) => ({ id: x.id, code: x.code, title: x.title, occurredOn: x.occurredOn, severity: x.severity, status: x.status,
        counted: cur.impact.counted.some((c) => c.id === x.id), reason: cur.impact.excluded.find((e) => e.id === x.id)?.reason ?? null })) },
    openActions, assessments: current, narrative,
    sources: [`Kabul kayıtları ${cur.from}–${cur.to} (yalnız erişiminiz olan şirketlerin siparişleri)`, cur.review ? `Performans incelemesi (${cur.review.reviewer})` : 'Performans incelemesi yok', `Olay politikası ${DEFAULT_INCIDENT_POLICY.version}`],
  };
}
