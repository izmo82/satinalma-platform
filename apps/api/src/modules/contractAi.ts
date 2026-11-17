import {
  AI_FIELD_TR, CONTRACT_AI_FIELDS, CRITICAL_AI_FIELDS, FIELD_KIND, can, checkContractExtraction, normalizeTaxId,
  type AiConfidence, type ContractAiField,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, notFound, unprocessable } from '../errors.ts';
import { DEFAULT_AI_MODEL_ID } from '../config.ts';
import { PROMPT_VERSIONS } from '../ai/prompts.ts';
import { isTestProvider, TEST_PROVIDER_LABEL } from '../ai/testProvider.ts';
import { contractWorkload, requestAi, type ResultWriter } from './ai.ts';
import { familyWritable } from './contractChain.ts';

/**
 * v2 Faz 4 Görev 4 (R3–R6, R11): sözleşme alan okuması (AI06). Okuma isteği yönlendirme kapısından geçer ve deftere yazılır (çalışmasa da);
 * işçi sonucu `checkContractExtraction` ile KOD denetler ve yalnız öneri satırı (`contract_extractions`) açar. Okunan hiçbir değer
 * `contract_terms`/`contract_families`'e yazılmaz: insan Faz 3 alan kaydıyla girer, kararını (`aiDecisions`) aynı işlemde verir.
 * Onaycı (başka departmandan) okur, istemez ve karar yazmaz (karar 1/051c RLS + burada 403).
 */

/** Sözleşme görevlerinin tek model ayarı (R1): `config.ai.modelId`; yapılandırma yoksa varsayılan. */
export const contractAiModelId = (cfg?: { modelId?: string } | null) => cfg?.modelId ?? DEFAULT_AI_MODEL_ID;

interface CurrentVersion {
  family_id: string; department_id: string | null; company_id: string; contract_version_id: string; document_version_id: string; page_count: number | null;
}
/** Ailenin güncel sürümü (Faz 3 FAMILY_SQL ile aynı: yerine geçilmemiş en yüksek sürüm). Görünmüyorsa (RLS) 404. */
async function currentVersion(tx: Tx, familyId: string): Promise<CurrentVersion> {
  const r = (await tx.query<CurrentVersion>(`SELECT f.id AS family_id, f.department_id, f.company_id, cv.id AS contract_version_id, cv.document_version_id, dv.page_count
    FROM contract_families f
    JOIN LATERAL (SELECT v.id, v.document_version_id FROM contract_versions v WHERE v.family_id = f.id AND v.superseded_by_id IS NULL ORDER BY v.version_no DESC LIMIT 1) cv ON true
    LEFT JOIN document_versions dv ON dv.id = cv.document_version_id
    WHERE f.id = $1`, [familyId])).rows[0];
  if (!r) throw notFound();
  return r;
}

/**
 * R11: okuma isteği (taslak oluşturma, yeni ana sürüm, "Yeniden oku"). İdempotent anahtar `AI06:contract_version:{sürüm}:{belge sürümü}:{istem sürümü}`:
 * çalışmış/kuyruktaki iş tekrar ücret yaratmaz; bekleyen iş yeniden yönlendirilir; `force` ile başarısız iş yeni deneme açar.
 */
export async function requestContractExtraction(tx: Tx, ctx: TenantContext, familyId: string, opts: { force?: boolean; modelId?: string } = {}) {
  const v = await currentVersion(tx, familyId);
  if (!familyWritable(ctx, v.department_id)) throw new ApiError(403, 'department_forbidden', 'Bu sözleşmeyi görebilirsiniz ama okuma isteyemezsiniz.');
  return requestVersionExtraction(tx, ctx, v, opts);
}

/** Yeni sürüm (addContractVersion) ve taslak (createDraft) için: sürüm kimliği bilinen istek. Yetki çağıranda denetlenmiştir. */
export async function requestExtractionForVersion(tx: Tx, ctx: TenantContext, contractVersionId: string, opts: { modelId?: string } = {}) {
  const v = (await tx.query<CurrentVersion>(`SELECT f.id AS family_id, f.department_id, f.company_id, cv.id AS contract_version_id, cv.document_version_id, dv.page_count
    FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id LEFT JOIN document_versions dv ON dv.id = cv.document_version_id
    WHERE cv.id = $1`, [contractVersionId])).rows[0];
  if (!v) throw notFound();
  return requestVersionExtraction(tx, ctx, v, opts);
}

async function requestVersionExtraction(tx: Tx, ctx: TenantContext, v: CurrentVersion, opts: { force?: boolean; modelId?: string }) {
  const r = await requestAi(tx, ctx, {
    task: 'AI06', entityType: 'contract_version', entityId: v.contract_version_id, documentVersionId: v.document_version_id, companyId: v.company_id,
    workload: contractWorkload(v.page_count ?? 1), modelId: opts.modelId ?? DEFAULT_AI_MODEL_ID, promptVersion: PROMPT_VERSIONS.AI06, retryFailed: !!opts.force,
  });
  return { runId: r.runId, status: r.status, reason: r.reason };
}

/** R5 ve karar 4: kritik, bool/enum alanlar önceden doldurulmaz; yalnız HIGH/MEDIUM doğrulanmış kritik olmayan metin/sayı/tarih alanı. */
export const prefillOf = (field: ContractAiField, confidence: AiConfidence) =>
  !CRITICAL_AI_FIELDS.includes(field) && FIELD_KIND[field] !== 'bool' && FIELD_KIND[field] !== 'enum' && (confidence === 'HIGH' || confidence === 'MEDIUM');

/** Güncel belge sürümünün en son AI06 çalıştırması (yoksa null). */
async function latestRun(tx: Tx, documentVersionId: string) {
  return (await tx.query<{ id: string; status: string; reason: string | null; provider: string | null; prompt_version: string | null; response_model: string | null;
      created_at: Date; finished_at: Date | null }>(
    `SELECT r.id, r.status, r.reason, m.provider, r.prompt_version, r.response_model, r.created_at, r.finished_at
     FROM ai_runs r LEFT JOIN ai_models m ON m.id = r.model_ref WHERE r.task = 'AI06' AND r.document_version_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    [documentVersionId])).rows[0] ?? null;
}

interface ExtractionRow {
  id: string; field: ContractAiField; value: string | null; page: number | null; evidence: string | null; confidence: AiConfidence; flags: string[];
  requires_human: boolean; decision: 'PENDING' | 'CONFIRMED' | 'CORRECTED' | 'REJECTED'; decided_by: string | null; decided_by_name: string | null; decided_at: Date | null;
}

/** GET /contracts/:id/extractions: güncel sürümün okuma durumu ve alan önerileri (test sağlayıcısı etiketli). */
export async function getExtractions(tx: Tx, ctx: TenantContext, familyId: string) {
  const v = await currentVersion(tx, familyId);
  const run = await latestRun(tx, v.document_version_id);
  const rows = run ? (await tx.query<ExtractionRow>(`SELECT e.id, e.field, e.value, e.page, e.evidence, e.confidence, e.flags, e.requires_human, e.decision,
      e.decided_by, u.display_name AS decided_by_name, e.decided_at
    FROM contract_extractions e LEFT JOIN users u ON u.id = e.decided_by WHERE e.ai_run_id = $1`, [run.id])).rows : [];
  const order = new Map(CONTRACT_AI_FIELDS.map((f, i) => [f, i]));
  rows.sort((a, b) => order.get(a.field)! - order.get(b.field)!);
  const test = isTestProvider(run?.provider);
  return {
    familyId, contractVersionId: v.contract_version_id, documentVersionId: v.document_version_id,
    run: run && { id: run.id, status: run.status, reason: run.reason, provider: run.provider, isTestProvider: test, providerLabel: test ? TEST_PROVIDER_LABEL : null,
      promptVersion: run.prompt_version, responseModel: run.response_model, createdAt: run.created_at, finishedAt: run.finished_at },
    fields: rows.map((e) => ({
      id: e.id, field: e.field, label: AI_FIELD_TR[e.field], value: e.value, page: e.page, evidence: e.evidence, confidence: e.confidence, flags: e.flags,
      requiresHuman: e.requires_human, critical: CRITICAL_AI_FIELDS.includes(e.field), prefill: prefillOf(e.field, e.confidence), decision: e.decision,
      decidedBy: e.decided_by ? { id: e.decided_by, displayName: e.decided_by_name ?? '' } : null, decidedAt: e.decided_at,
    })),
    can: { request: can(ctx.roles, 'contract.ai.request') && familyWritable(ctx, v.department_id) },
  };
}

/** AI06 sonuç yazıcısı (işçi): çıktıyı kod denetler, alan başına öneri satırı açar; hiçbir sözleşme alanına yazmaz. */
export const writeContractExtraction: ResultWriter = async (tx, ctx, { run, pages, output }) => {
  const cv = (await tx.query<{ family_id: string }>(`SELECT family_id FROM contract_versions WHERE id = $1`, [run.entity_id])).rows[0];
  if (!cv || run.entity_type !== 'contract_version' || !run.document_version_id) throw new Error('contract_version_missing');
  const checked = checkContractExtraction(output, pages);
  for (const f of checked.fields) {
    await tx.query(`INSERT INTO contract_extractions (tenant_id, family_id, document_version_id, ai_run_id, field, value, page, evidence, confidence, flags, requires_human)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ctx.tenantId, cv.family_id, run.document_version_id, run.id, f.field, f.value, f.page, f.evidence, f.confidence, JSON.stringify(f.flags), f.requiresHuman]);
  }
  const flags = [...checked.flags, ...checked.fields.flatMap((f) => f.flags.filter((x) => x !== 'MISSING').map((x) => `${f.field}:${x}`))];
  return { flags, fields: checked.fields.filter((f) => f.value !== null).length, data: { familyId: cv.family_id } };
};

// --- Kararlar (R6) -----------------------------------------------------------------------------------------------------------

export type AiDecision = 'CONFIRMED' | 'CORRECTED' | 'REJECTED';
export interface AiDecisionInput { extractionId: string; decision: AiDecision }

/** Kaydedilmiş insan değeri (Faz 3 alan kaydı sonrası) — öneriyle karşılaştırma için normalize. Karşılığı olmayan alan undefined. */
export interface SavedContractValues {
  title: string; contractType: string | null; supplierName: string | null; supplierVkn: string | null; signedOn: string | null; startDate: string | null;
  endDate: string | null; indefinite: boolean; noticeAmount: number | null; noticeUnit: string | null; amount: string | null; currency: string | null;
  limitBasis: string | null; autoRenewal: boolean | null; contractNo: string | null; paymentDays: number | null; governingCourt: string | null; priceEscalation: string | null;
}
const textEq = (a: string | null, b: string | null) => a != null && b != null && a.replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr-TR') === b.replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr-TR');
const vknOf = (x: string | null) => { if (!x) return null; const r = normalizeTaxId('TR', 'VKN', x); return r.ok ? r.normalized : null; };
/** Kaydedilen değer öneriye eşit mi? `null` = bu alanın kayıtta karşılığı yok (karar yalnız insan beyanıdır, değer yazılmaz). */
function savedEquals(field: ContractAiField, suggestion: string | null, s: SavedContractValues): boolean | null {
  if (suggestion === null) return false;
  switch (field) {
    case 'title': return textEq(s.title, suggestion);
    case 'contractType': return s.contractType === suggestion;
    case 'supplierName': return textEq(s.supplierName, suggestion);
    case 'supplierVkn': return vknOf(s.supplierVkn) === suggestion;
    case 'signedOn': return s.signedOn === suggestion;
    case 'startDate': return s.startDate === suggestion;
    case 'endDate': return s.endDate === suggestion;
    case 'indefinite': return String(s.indefinite) === suggestion;
    case 'noticePeriodDays': return s.noticeUnit === 'DAY' && s.noticeAmount != null && String(s.noticeAmount) === suggestion;
    case 'amount': return s.amount === suggestion;
    case 'currency': return s.currency === suggestion;
    case 'limitBasis': return s.limitBasis === suggestion;
    case 'autoRenewal': return s.autoRenewal != null && String(s.autoRenewal) === suggestion;
    case 'contractNo': return textEq(s.contractNo, suggestion);
    case 'paymentTermDays': return s.paymentDays != null && String(s.paymentDays) === suggestion;
    case 'governingCourt': return textEq(s.governingCourt, suggestion);
    case 'priceEscalation': return textEq(s.priceEscalation, suggestion);
    case 'guarantee': case 'slaPenalty': case 'kvkkClause': return null;
  }
}

/**
 * R6: kararlar Faz 3 alan kaydıyla AYNI işlemde yazılır (çağıran: updateFields, kayıttan sonra). Yalnız güncel belge sürümünün en son okumasının
 * önerileri karara açıktır. `CONFIRMED` yalnız kaydedilen değer öneriye eşitse (aksi 422 decision_mismatch → işlem geri alınır, alan da kaydedilmez).
 */
export async function applyAiDecisions(tx: Tx, ctx: TenantContext, familyId: string, documentVersionId: string, saved: SavedContractValues, decisions: AiDecisionInput[]) {
  if (!decisions.length) return [];
  const ids = decisions.map((d) => d.extractionId);
  if (new Set(ids).size !== ids.length) throw unprocessable('extraction_duplicate', 'Aynı öneri için birden fazla karar gönderildi.');
  const run = await latestRun(tx, documentVersionId);
  const rows = run ? (await tx.query<{ id: string; field: ContractAiField; value: string | null }>(
    `SELECT id, field, value FROM contract_extractions WHERE id = ANY($1::uuid[]) AND family_id = $2 AND ai_run_id = $3`, [ids, familyId, run.id])).rows : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) throw unprocessable('extraction_unknown', 'Öneri bulunamadı ya da güncel belge sürümünün okumasına ait değil; sayfayı yenileyin.', { extractionIds: unknown });
  const mismatched = decisions.filter((d) => d.decision === 'CONFIRMED' && savedEquals(byId.get(d.extractionId)!.field, byId.get(d.extractionId)!.value, saved) === false)
    .map((d) => ({ extractionId: d.extractionId, field: byId.get(d.extractionId)!.field, label: AI_FIELD_TR[byId.get(d.extractionId)!.field] }));
  if (mismatched.length) {
    throw unprocessable('decision_mismatch', `Kaydedilen değer öneriyle aynı değil: ${mismatched.map((m) => m.label).join(', ')}. Öneriyi kullanın ya da kararı "Düzeltildi" yapın.`,
      { fields: mismatched });
  }
  for (const d of decisions) {
    await tx.query(`UPDATE contract_extractions SET decision = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [d.extractionId, d.decision, ctx.userId]);
  }
  const out = decisions.map((d) => ({ extractionId: d.extractionId, field: byId.get(d.extractionId)!.field, decision: d.decision }));
  // Denetim kaydında değer yok (belge içeriği deftere/denetime kopyalanmaz); alan ve karar yeter.
  await audit(tx, ctx, 'contract.extraction.decided', 'contract_family', familyId, { runId: run!.id, documentVersionId, decisions: out });
  return out;
}

/** R6 gönderim kapısı: güncel belge sürümünün en son okumasında değeri olan kritik öneri PENDING ise 422 (alan listesiyle). Okuma yoksa engel yok. */
export async function assertNoPendingCriticalSuggestions(tx: Tx, documentVersionId: string) {
  const run = await latestRun(tx, documentVersionId);
  if (!run || run.status !== 'SUCCEEDED') return;
  const pending = (await tx.query<{ id: string; field: ContractAiField }>(`SELECT id, field FROM contract_extractions
    WHERE ai_run_id = $1 AND decision = 'PENDING' AND value IS NOT NULL AND field = ANY($2::text[])`, [run.id, [...CRITICAL_AI_FIELDS]])).rows;
  if (!pending.length) return;
  pending.sort((a, b) => CRITICAL_AI_FIELDS.indexOf(a.field) - CRITICAL_AI_FIELDS.indexOf(b.field));
  throw unprocessable('ai_suggestions_pending',
    `Yapay zekâ önerileri karar bekliyor: ${pending.map((p) => AI_FIELD_TR[p.field]).join(', ')}. Her kritik öneriyi kullanın, düzeltin ya da reddedin.`,
    { pending: pending.map((p) => ({ extractionId: p.id, field: p.field, label: AI_FIELD_TR[p.field] })) });
}
