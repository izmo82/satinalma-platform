import { createHash } from 'node:crypto';
import {
  AI_DISCLAIMER, AI_FIELD_TR, CONTRACT_AI_FIELDS, CRITICAL_AI_FIELDS, FIELD_KIND, REVIEW_CATEGORIES, REVIEW_CATEGORY_TR, REVIEW_RUBRIC_VERSION, belowThreshold, can,
  checkContractExtraction, checkEvidenceOutput, checkReviewOutput, normalizeTaxId, reviewScore,
  type AiConfidence, type CheckedEvidenceAnswer, type ContractAiField, type ReviewCategory,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, notFound, unprocessable } from '../errors.ts';
import { DEFAULT_AI_MODEL_ID } from '../config.ts';
import { PROMPT_VERSIONS } from '../ai/prompts.ts';
import { isTestProvider, TEST_PROVIDER_LABEL } from '../ai/testProvider.ts';
import { AiPrepareError, contractSettings, contractWorkload, keyVariant, requestAi, type AiRunRow, type ResultWriter, type TaskHandler } from './ai.ts';
import type { AiInput } from '../ai/provider.ts';
import { docxText } from '../ai/text.ts';
import type { ObjectStore } from '../storage.ts';
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

/**
 * Yeni sürüm (addContractVersion) ve taslak (createDraft) için: sürüm kimliği bilinen istek. Yetki çağıranda denetlenmiştir.
 * Görev 4 inceleme M3: istek kayıt noktası (SAVEPOINT) içinde yapılır; okuma istenemezse yalnız o kısım geri alınır, taslak/sürüm yine oluşur
 * ve elle akış sürer.
 */
export async function requestExtractionForVersion(tx: Tx, ctx: TenantContext, contractVersionId: string, opts: { modelId?: string } = {}) {
  await tx.query('SAVEPOINT contract_ai_extraction');
  try {
    const r = await requestExtractionForVersionUnsafe(tx, ctx, contractVersionId, opts);
    await tx.query('RELEASE SAVEPOINT contract_ai_extraction');
    return r;
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT contract_ai_extraction');
    // Günlüğe yalnız hata adı/kodu (belge metni yok).
    console.error('contract extraction request failed', contractVersionId, (e as { code?: string }).code ?? (e as Error).name);
    return { runId: null, status: 'FAILED', reason: EXTRACTION_REQUEST_FAILED };
  }
}
export const EXTRACTION_REQUEST_FAILED = 'Okuma istenemedi; alanları elle girin.';

async function requestExtractionForVersionUnsafe(tx: Tx, ctx: TenantContext, contractVersionId: string, opts: { modelId?: string }) {
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

/** M4: karar satırı yazılamadı (yetki ya da eşzamanlı değişiklik); işlem geri alınır, denetim yazılmaz. */
const decisionNotSaved = () => new ApiError(409, 'extraction_not_saved', 'Öneri kararı kaydedilemedi; sayfayı yenileyip yeniden deneyin.');

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
    throw unprocessable('decision_mismatch', `Kaydedilen değer öneriyle aynı değil: ${mismatched.map((m) => m.label).join(', ')}. Alanı öneriye eşitleyin ya da öneriyi yoksayın.`,
      { fields: mismatched });
  }
  // Görev 4 inceleme M4: "Düzeltildi" denen değer öneriye eşitse karar "Onaylandı" saklanır (karar kaydedilen değere uyar).
  const final = (d: AiDecisionInput): AiDecision =>
    d.decision === 'CORRECTED' && savedEquals(byId.get(d.extractionId)!.field, byId.get(d.extractionId)!.value, saved) === true ? 'CONFIRMED' : d.decision;
  const out = decisions.map((d) => ({ extractionId: d.extractionId, field: byId.get(d.extractionId)!.field, decision: final(d) }));
  for (const d of out) {
    const u = await tx.query(`UPDATE contract_extractions SET decision = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [d.extractionId, d.decision, ctx.userId]);
    // Final inceleme M4: satır güncellenmediyse (ör. RLS süzdü) karar yazılmış sayılmaz; denetim kaydı da yazılmaz (işlem geri alınır).
    if (u.rowCount !== 1) throw decisionNotSaved();
  }
  // Denetim kaydında değer yok (belge içeriği deftere/denetime kopyalanmaz); alan ve karar yeter.
  await audit(tx, ctx, 'contract.extraction.decided', 'contract_family', familyId, { runId: run!.id, documentVersionId, decisions: out });
  return out;
}

/**
 * Görev 4 inceleme I1: alan kaydından sonra, güncel okumanın "Onaylandı" önerilerinden kaydedilen değeri artık öneriye eşit olmayanlar
 * "Düzeltildi" olur (karar değeri izler; eski onay yanıltmasın). Bu istekte açıkça karar verilen öneriler hariç (onlar applyAiDecisions'ta).
 */
export async function reconcileConfirmed(tx: Tx, ctx: TenantContext, familyId: string, documentVersionId: string, saved: SavedContractValues, exclude: string[] = []) {
  const run = await latestRun(tx, documentVersionId);
  if (!run) return [];
  const rows = (await tx.query<{ id: string; field: ContractAiField; value: string | null }>(
    `SELECT id, field, value FROM contract_extractions WHERE ai_run_id = $1 AND family_id = $2 AND decision = 'CONFIRMED' AND NOT (id = ANY($3::uuid[]))`,
    [run.id, familyId, exclude])).rows;
  const stale = rows.filter((r) => savedEquals(r.field, r.value, saved) === false);
  if (!stale.length) return [];
  for (const r of stale) {
    const u = await tx.query(`UPDATE contract_extractions SET decision = 'CORRECTED', decided_by = $2, decided_at = now() WHERE id = $1`, [r.id, ctx.userId]);
    if (u.rowCount !== 1) throw decisionNotSaved(); // M4: güncellenmeyen satır için denetim yok
  }
  const out = stale.map((r) => ({ extractionId: r.id, field: r.field, decision: 'CORRECTED' as const }));
  await audit(tx, ctx, 'contract.extraction.decided', 'contract_family', familyId,
    { runId: run.id, documentVersionId, decisions: out, system: true, reason: 'Kaydedilen değer onaylanan öneriden farklı; karar "Düzeltildi" oldu.' });
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

// --- İnceleme (AI14, R7–R10) ve kanıt okuması (AI15, R14) — Görev 5 --------------------------------------------------------

/** R9: şablon sürümü idempotent anahtarın ek parçasıdır (`tpl-{id|none}`); işçi şablonu buradan bulur. */
const templateVariant = (templateVersionId: string | null) => `tpl-${templateVersionId ?? 'none'}`;
const templateOfVariant = (variant: string | undefined): string | null | undefined => {
  const m = /^tpl-([0-9a-f-]{36}|none)$/.exec(variant ?? '');
  return m ? (m[1] === 'none' ? null : m[1]!) : undefined;
};
/**
 * Final inceleme M5: güncel inceleme işinin anahtar öneki (sürüm + belge sürümü + GÜNCEL şablon sürümü). Şablon sürümü değişince eski
 * şablonun işi "son iş" sayılmaz; 4. adım iş yok gördüğü için incelemeyi kendiliğinden ister (kural aynı: yalnız iş yok/bekliyorsa).
 */
const reviewKeyPrefix = (contractVersionId: string, documentVersionId: string, templateVersionId: string | null) =>
  `AI14:contract_version:${contractVersionId}:${documentVersionId}:${templateVariant(templateVersionId)}`;
export const NO_TEMPLATE_NOTE = 'Şablon yok; yalnız hukuk incelemesi';
export const UNVERIFIED_FINDING_LABEL = 'kaynak doğrulanamadı';
export const BELOW_THRESHOLD_ADVICE = 'Puan eşiğin altında; ek onaycı (ör. kurumun hukuk danışmanı) eklemeniz önerilir.';

/**
 * R7: türüne uyan güncel şablon sürümü. Ailede seçili şablon varsa onun güncel sürümü (yerine geçilmiş seçimde de güncel olan); yoksa
 * ailenin türündeki şablonların (koda göre ilk) güncel sürümü. Tür yok ya da OTHER ise ya da güncel sürüm yoksa null (yalnız hukuk incelemesi).
 */
async function currentTemplateVersion(tx: Tx, familyId: string): Promise<string | null> {
  const f = (await tx.query<{ contract_type: string | null; template_version_id: string | null }>(
    `SELECT contract_type, template_version_id FROM contract_families WHERE id = $1`, [familyId])).rows[0];
  if (!f) return null;
  if (f.template_version_id) {
    const cur = (await tx.query<{ id: string }>(`SELECT cur.id FROM contract_template_versions sel
      JOIN contract_template_versions cur ON cur.template_id = sel.template_id AND cur.superseded_at IS NULL WHERE sel.id = $1`, [f.template_version_id])).rows[0];
    if (cur) return cur.id;
  }
  if (!f.contract_type || f.contract_type === 'OTHER') return null;
  return (await tx.query<{ id: string }>(`SELECT tv.id FROM contract_templates t JOIN contract_template_versions tv ON tv.template_id = t.id AND tv.superseded_at IS NULL
    WHERE t.contract_type = $1 ORDER BY t.code, t.id LIMIT 1`, [f.contract_type])).rows[0]?.id ?? null;
}

/**
 * R7/R9/R11: inceleme isteği — güncel ana sürüm + türün güncel şablon sürümü. İdempotent anahtar
 * `AI14:contract_version:{sürüm}:{belge sürümü}:tpl-{şablon sürümü|none}:{istem sürümü}`: çalışmış iş yeni ücret yaratmaz; `force`
 * ("Yeniden incele") yalnız başarısız işe yeni deneme açar. Onaycı ve başka departman isteyemez.
 */
export async function requestContractReview(tx: Tx, ctx: TenantContext, familyId: string, opts: { force?: boolean; modelId?: string } = {}) {
  const v = await currentVersion(tx, familyId);
  if (!familyWritable(ctx, v.department_id)) throw new ApiError(403, 'department_forbidden', 'Bu sözleşmeyi görebilirsiniz ama inceleme isteyemezsiniz.');
  const templateVersionId = await currentTemplateVersion(tx, familyId);
  const r = await requestAi(tx, ctx, {
    task: 'AI14', entityType: 'contract_version', entityId: v.contract_version_id, documentVersionId: v.document_version_id, companyId: v.company_id,
    workload: contractWorkload(v.page_count ?? 1), modelId: opts.modelId ?? DEFAULT_AI_MODEL_ID, promptVersion: PROMPT_VERSIONS.AI14,
    variant: templateVariant(templateVersionId), retryFailed: !!opts.force,
  });
  return { runId: r.runId, status: r.status, reason: r.reason, templateVersionId };
}

/** AI14 hazırlığı: şablon sürümünün .docx metni (Faz 3 kapısı app_template_file; kiracı geneli). Okunamazsa ücretsiz FAILED. */
async function prepareReview(tx: Tx, _ctx: TenantContext, run: AiRunRow, store: ObjectStore): Promise<Partial<AiInput>> {
  const tv = templateOfVariant(keyVariant(run));
  if (tv === undefined) throw new AiPrepareError('İnceleme isteğinde şablon bilgisi yok; çağrı yapılmadı.');
  if (tv === null) return { templateText: null };
  const f = (await tx.query<{ storage_key: string; disposed: boolean }>(`SELECT storage_key, disposed FROM app_template_file($1)`, [tv])).rows[0];
  if (!f || f.disposed) throw new AiPrepareError('Şablon belgesi bulunamadı ya da imha edildi; çağrı yapılmadı. Şablonu güncelleyip yeniden inceleyin.');
  try { return { templateText: docxText(await store.get(f.storage_key)) }; }
  catch { throw new AiPrepareError('Şablon metni okunamadı; çağrı yapılmadı.'); }
}

/** AI14 sonuç yazıcısı: bulguları KOD denetler (R7), puanı yalnız doğrulanmış bulgulardan `reviewScore` hesaplar (R8); değişmez kayıt (R9). */
export const writeContractReview: ResultWriter = async (tx, ctx, { run, pages, output, model, input }) => {
  const cv = (await tx.query<{ family_id: string }>(`SELECT family_id FROM contract_versions WHERE id = $1`, [run.entity_id])).rows[0];
  if (!cv || run.entity_type !== 'contract_version' || !run.document_version_id) throw new Error('contract_version_missing');
  const templateVersionId = templateOfVariant(keyVariant(run)) ?? null;
  const templateText = input?.templateText ?? null;
  const checked = checkReviewOutput(output, pages, templateVersionId ? templateText : null);
  // Modelin döndürdüğü puan/karar anahtarları (score, approve …) checkReviewOutput'ta IGNORED_KEY olur; puan yalnız kodda.
  const { score, subScores } = reviewScore(checked.findings, templateVersionId !== null);
  const review = (await tx.query<{ id: string }>(`INSERT INTO contract_reviews (tenant_id, family_id, document_version_id, template_version_id, ai_run_id, model_id,
      prompt_version, rubric_version, score, sub_scores, summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ctx.tenantId, cv.family_id, run.document_version_id, templateVersionId, run.id, model ?? null, run.prompt_version ?? PROMPT_VERSIONS.AI14, REVIEW_RUBRIC_VERSION,
      score, JSON.stringify(subScores), checked.summary])).rows[0]!;
  for (const [ord, f] of checked.findings.entries()) {
    await tx.query(`INSERT INTO contract_review_findings (tenant_id, review_id, category, kind, severity, title, quote, page, template_ref, suggestion, verified, ord)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.tenantId, review.id, f.category, f.kind, f.severity, f.title.trim() || REVIEW_CATEGORY_TR[f.category], f.quote, f.page !== null && f.page > 0 ? f.page : null,
        f.templateRef, f.recommendation, f.verified, ord]);
  }
  const flags = [...checked.flags, ...checked.findings.flatMap((f, i) => f.flags.map((x) => `finding${i}:${x}`))];
  return { flags, fields: checked.findings.length, data: { familyId: cv.family_id, reviewId: review.id, score } };
};
export const REVIEW_HANDLER: TaskHandler = { prepare: prepareReview, write: writeContractReview };

interface ReviewRow {
  id: string; document_version_id: string; template_version_id: string | null; ai_run_id: string; model_id: string | null; prompt_version: string; rubric_version: string;
  score: number; sub_scores: Record<ReviewCategory, number | null>; summary: string | null; created_at: Date; template_code: string | null; template_version_no: number | null;
  provider: string | null;
}
async function familyReviews(tx: Tx, familyId: string) {
  return (await tx.query<ReviewRow>(`SELECT r.id, r.document_version_id, r.template_version_id, r.ai_run_id, r.model_id, r.prompt_version, r.rubric_version, r.score, r.sub_scores,
      r.summary, r.created_at, t.code AS template_code, tv.version_no AS template_version_no, m.provider
    FROM contract_reviews r LEFT JOIN contract_template_versions tv ON tv.id = r.template_version_id LEFT JOIN contract_templates t ON t.id = tv.template_id
      LEFT JOIN ai_runs ar ON ar.id = r.ai_run_id LEFT JOIN ai_models m ON m.id = ar.model_ref
    WHERE r.family_id = $1 ORDER BY r.created_at DESC, r.id DESC`, [familyId])).rows;
}
const reviewThreshold = async (tx: Tx) => (await contractSettings(tx)).reviewThreshold;

/**
 * Sözleşmenin inceleme özeti (GET …/v2 ve gönderim denetimi). Güncel = en son inceleme; yeni belge sürümü ya da yeni şablon sürümü onu
 * "güncel değil" yapar (R9). Eşik karşılaştırması yalnız güncel olmayan değil (stale=false) incelemede yapılır; puan hiçbir şeyi engellemez.
 */
export async function reviewSummary(tx: Tx, familyId: string) {
  const v = await currentVersion(tx, familyId);
  const latest = (await familyReviews(tx, familyId))[0];
  if (!latest) return null;
  const tv = await currentTemplateVersion(tx, familyId);
  const stale = latest.document_version_id !== v.document_version_id || latest.template_version_id !== tv;
  const threshold = await reviewThreshold(tx);
  const test = isTestProvider(latest.provider);
  return {
    id: latest.id, score: latest.score, threshold, belowThreshold: !stale && belowThreshold(latest.score, threshold), stale,
    template: latest.template_code ? { code: latest.template_code, versionNo: latest.template_version_no! } : null, modelId: latest.model_id,
    isTestProvider: test, providerLabel: test ? TEST_PROVIDER_LABEL : null, createdAt: latest.created_at, disclaimer: AI_DISCLAIMER,
    advice: !stale && belowThreshold(latest.score, threshold) ? BELOW_THRESHOLD_ADVICE : null,
  };
}

/** GET /contracts/:id/reviews: güncel inceleme (bulgularıyla), son iş, geçmiş, eşik, uyarı. Görünürlük RLS'ten (departman veya onaycı). */
export async function getContractReviews(tx: Tx, ctx: TenantContext, familyId: string) {
  const v = await currentVersion(tx, familyId);
  const tv = await currentTemplateVersion(tx, familyId);
  const all = await familyReviews(tx, familyId);
  const threshold = await reviewThreshold(tx);
  const isStale = (r: ReviewRow) => r.document_version_id !== v.document_version_id || r.template_version_id !== tv;
  const base = (r: ReviewRow) => {
    const test = isTestProvider(r.provider);
    return { id: r.id, score: r.score, documentVersionId: r.document_version_id, template: r.template_code ? { code: r.template_code, versionNo: r.template_version_no! } : null,
      modelId: r.model_id, promptVersion: r.prompt_version, rubricVersion: r.rubric_version, isTestProvider: test, providerLabel: test ? TEST_PROVIDER_LABEL : null,
      stale: isStale(r), createdAt: r.created_at };
  };
  const cur = all[0];
  let current = null;
  if (cur) {
    const findings = (await tx.query<{ id: string; category: ReviewCategory; kind: string; severity: string; title: string; quote: string | null; page: number | null;
        template_ref: string | null; suggestion: string | null; verified: boolean }>(
      `SELECT id, category, kind, severity, title, quote, page, template_ref, suggestion, verified FROM contract_review_findings WHERE review_id = $1 ORDER BY ord`, [cur.id])).rows;
    current = {
      ...base(cur), subScores: cur.sub_scores,
      subScoreList: REVIEW_CATEGORIES.map((c) => ({ category: c, label: REVIEW_CATEGORY_TR[c], score: cur.sub_scores[c] ?? null })),
      summary: cur.summary, templateNote: cur.template_code ? null : NO_TEMPLATE_NOTE,
      findings: findings.map((f) => ({ id: f.id, category: f.category, categoryLabel: REVIEW_CATEGORY_TR[f.category], kind: f.kind, severity: f.severity, title: f.title,
        quote: f.quote, page: f.page, templateRef: f.template_ref, suggestion: f.suggestion, verified: f.verified, sourceLabel: f.verified ? null : UNVERIFIED_FINDING_LABEL })),
    };
  }
  const run = (await tx.query<{ id: string; status: string; reason: string | null; provider: string | null; prompt_version: string | null; response_model: string | null;
      created_at: Date; finished_at: Date | null }>(
    `SELECT r.id, r.status, r.reason, m.provider, r.prompt_version, r.response_model, r.created_at, r.finished_at
     FROM ai_runs r LEFT JOIN ai_models m ON m.id = r.model_ref WHERE r.task = 'AI14' AND r.document_version_id = $1
       AND (r.idempotency_key = $2 OR starts_with(r.idempotency_key, $2 || ':')) ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    [v.document_version_id, reviewKeyPrefix(v.contract_version_id, v.document_version_id, tv)])).rows[0] ?? null;
  const runTest = isTestProvider(run?.provider);
  const below = !!current && !current.stale && belowThreshold(current.score, threshold);
  return {
    familyId, contractVersionId: v.contract_version_id, documentVersionId: v.document_version_id, templateVersionId: tv,
    current,
    run: run && { id: run.id, status: run.status, reason: run.reason, provider: run.provider, isTestProvider: runTest, providerLabel: runTest ? TEST_PROVIDER_LABEL : null,
      promptVersion: run.prompt_version, responseModel: run.response_model, createdAt: run.created_at, finishedAt: run.finished_at },
    history: all.slice(1).map(base),
    threshold, belowThreshold: below, advice: below ? BELOW_THRESHOLD_ADVICE : null, disclaimer: AI_DISCLAIMER,
    can: { request: can(ctx.roles, 'contract.ai.request') && familyWritable(ctx, v.department_id) },
  };
}

/**
 * R10: gönderimde eşik denetim olayı. Güncel (stale olmayan) inceleme eşiğin altındaysa `contract.review_below_threshold_acknowledged` yazılır;
 * gönderim ASLA engellenmez. Döner: yazıldıysa olay verisi, değilse null.
 */
export async function auditReviewAtSubmit(tx: Tx, ctx: TenantContext, familyId: string) {
  const s = await reviewSummary(tx, familyId);
  if (!s || !s.belowThreshold) return null;
  const data = { reviewId: s.id, score: s.score, threshold: s.threshold, rubricVersion: REVIEW_RUBRIC_VERSION, isTestProvider: s.isTestProvider };
  await audit(tx, ctx, 'contract.review_below_threshold_acknowledged', 'contract_family', familyId, data);
  return data;
}

// --- Kanıt okuması (AI15, R14): Faz 7 altyapısı; ekran/uç yok ------------------------------------------------------------------

export interface EvidenceQuestion { id: string; text: string }
export interface EvidenceReadingInput { documentVersionId: string; purpose: string; questions: EvidenceQuestion[] }

/**
 * R14: kanıt belgesi okuma isteği (AI15). Konu belge sürümüdür (`entity_type='document_version'`). Sorular ve amaç iş yüküne yazılır;
 * kayıt (`ai_evidence_readings`) iş bitince bir kez açılır (değişmez). İdempotent anahtar soru kümesinin özetini içerir. Karar kural motorunda.
 */
export async function requestEvidenceReading(tx: Tx, ctx: TenantContext, input: EvidenceReadingInput, opts: { force?: boolean; modelId?: string } = {}) {
  const purpose = input.purpose?.trim() ?? '';
  if (purpose.length < 1 || purpose.length > 200) throw unprocessable('invalid_purpose', 'Okuma amacı 1-200 karakter olmalı.');
  const qs = input.questions ?? [];
  if (qs.length < 1 || qs.length > 50) throw unprocessable('invalid_questions', 'En az 1, en çok 50 soru gönderilir.');
  const ids = qs.map((q) => q.id?.trim() ?? '');
  if (ids.some((id) => id.length < 1 || id.length > 100) || new Set(ids).size !== ids.length) throw unprocessable('invalid_questions', 'Soru kimlikleri boş olmayan ve benzersiz olmalı.');
  if (qs.some((q) => typeof q.text !== 'string' || q.text.trim().length < 1 || q.text.length > 1000)) throw unprocessable('invalid_questions', 'Soru metni 1-1000 karakter olmalı.');
  const questions = qs.map((q) => ({ id: q.id.trim(), text: q.text.trim() }));
  const dv = (await tx.query<{ id: string; company_id: string; page_count: number | null }>(
    `SELECT id, company_id, page_count FROM document_versions WHERE id = $1`, [input.documentVersionId])).rows[0];
  if (!dv) throw notFound();
  const digest = createHash('sha256').update(JSON.stringify({ purpose, questions })).digest('hex').slice(0, 20);
  const r = await requestAi(tx, ctx, {
    task: 'AI15', entityType: 'document_version', entityId: dv.id, documentVersionId: dv.id, companyId: dv.company_id,
    workload: contractWorkload(dv.page_count ?? 1), modelId: opts.modelId ?? DEFAULT_AI_MODEL_ID, promptVersion: PROMPT_VERSIONS.AI15,
    variant: `q-${digest}`, retryFailed: !!opts.force, jobPayload: { purpose, questions },
  });
  return { runId: r.runId, status: r.status, reason: r.reason };
}

const payloadQuestions = (p: Record<string, unknown> | undefined): EvidenceQuestion[] | null =>
  Array.isArray(p?.questions) && p!.questions.every((q) => q && typeof q === 'object' && typeof (q as EvidenceQuestion).id === 'string' && typeof (q as EvidenceQuestion).text === 'string')
    ? (p!.questions as EvidenceQuestion[]) : null;

export const EVIDENCE_HANDLER: TaskHandler = {
  async prepare(_tx, _ctx, _run, _store, payload) {
    const questions = payloadQuestions(payload);
    if (!questions?.length || typeof payload.purpose !== 'string') throw new AiPrepareError('Kanıt soruları yok; çağrı yapılmadı.');
    return { questions };
  },
  /** AI15 yazıcısı: alıntısı doğrulanmayan cevap UNCLEAR (checkEvidenceOutput); kayıt bir kez, değişmez. */
  async write(tx, ctx, { run, pages, output, payload }) {
    const questions = payloadQuestions(payload);
    if (!questions || typeof payload?.purpose !== 'string' || !run.document_version_id) throw new Error('evidence_payload_missing');
    const checked = checkEvidenceOutput(output, pages, questions.map((q) => q.id));
    await tx.query(`INSERT INTO ai_evidence_readings (tenant_id, company_id, document_version_id, ai_run_id, purpose, question_set, result) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.tenantId, run.company_id, run.document_version_id, run.id, payload.purpose, JSON.stringify(questions), JSON.stringify({ answers: checked.answers, flags: checked.flags })]);
    const flags = [...checked.flags, ...checked.answers.flatMap((a) => a.flags.map((x) => `${a.questionId}:${x}`))];
    return { flags, fields: checked.answers.filter((a) => a.answer !== 'UNCLEAR').length, data: { documentVersionId: run.document_version_id } };
  },
};

/** R14 okuma işlevi (Faz 7 kural motoru tüketir): belge sürümünün kanıt okumaları, en yenisi önce; test sağlayıcısı etiketli. RLS belge görünürlüğü. */
export async function evidenceReadings(tx: Tx, documentVersionId: string) {
  const rows = (await tx.query<{ id: string; ai_run_id: string; purpose: string; question_set: EvidenceQuestion[]; result: { answers: CheckedEvidenceAnswer[]; flags: string[] } | null;
      created_at: Date; provider: string | null; response_model: string | null; prompt_version: string | null }>(
    `SELECT e.id, e.ai_run_id, e.purpose, e.question_set, e.result, e.created_at, m.provider, r.response_model, r.prompt_version
     FROM ai_evidence_readings e LEFT JOIN ai_runs r ON r.id = e.ai_run_id LEFT JOIN ai_models m ON m.id = r.model_ref
     WHERE e.document_version_id = $1 ORDER BY e.created_at DESC, e.id DESC`, [documentVersionId])).rows;
  return rows.map((e) => ({
    id: e.id, runId: e.ai_run_id, documentVersionId, purpose: e.purpose, questions: e.question_set, answers: e.result?.answers ?? [], flags: e.result?.flags ?? [],
    modelId: e.response_model, promptVersion: e.prompt_version, isTestProvider: isTestProvider(e.provider), providerLabel: isTestProvider(e.provider) ? TEST_PROVIDER_LABEL : null,
    createdAt: e.created_at,
  }));
}
