/**
 * AI görev yönlendirme ve çıktı denetimi (07, T22–T24). Saf ve deterministik.
 * Önce kural/veri; model yalnız izinli sağlayıcı, bölge ve bütçe kapısından geçerse. Uygunsuz sağlayıcıya sessiz geçiş yok.
 * Bilinmeyen tarife sıfır sayılmaz. Model çıktısı veri kabul edilir: kaynağı doğrulanmayan alan NULL, talimat/eylem yok sayılır.
 */
import { add, cmp, dec, str } from './money.ts';
import { normalizeTaxId } from './taxId.ts';

export type AiTask = 'AI01' | 'AI02' | 'AI03' | 'AI04' | 'AI05' | 'AI06' | 'AI07' | 'AI08' | 'AI09' | 'AI10' | 'AI11' | 'AI12' | 'AI13' | 'AI14' | 'AI15';
export type Capability = 'structuredOutput' | 'vision' | 'ocr' | 'signatureDetection';

/** Görev matrisi (07): önce deterministik yöntem, yetkili insan kontrolü. Para/vergi/VKN/limit/puan/onay modele verilmez. */
export const AI_TASKS: Record<AiTask, { name: string; needs: Capability[]; deterministic: string; human: string }> = {
  AI01: { name: 'Belge türü', needs: ['structuredOutput'], deterministic: 'MIME/şema/kural', human: 'Sınıf düzeltilebilir' },
  AI02: { name: 'Fatura alanları', needs: ['structuredOutput'], deterministic: 'e-Fatura XML ayrıştırıcı', human: 'Kritik alan insan onayı' },
  AI03: { name: 'Firma eşleme', needs: ['structuredOutput'], deterministic: 'Vergi kimliğiyle kesin DB araması', human: 'Satınalma (tedarikçi aktivasyonu)' },
  AI04: { name: 'Teklif satırları', needs: ['structuredOutput'], deterministic: 'Portal satır girişi', human: 'Teknik uzman' },
  AI05: { name: 'Karşılaştırma anlatısı', needs: ['structuredOutput'], deterministic: 'Hesap motoru + rapor servisi', human: 'Satınalmacı/kurul' },
  AI06: { name: 'Sözleşme metadata/yükümlülük', needs: ['structuredOutput'], deterministic: 'Elle giriş + ikinci kişi doğrulaması', human: 'Satınalma ve sorumlu' },
  AI07: { name: 'Fatura farkı açıklaması', needs: ['structuredOutput'], deterministic: 'Deterministik eşleştirme', human: 'Satınalma' },
  AI08: { name: 'Güvenlik anketi özeti', needs: ['structuredOutput'], deterministic: 'Anket kuralları', human: 'Güvenlik uzmanı' },
  AI09: { name: 'Olay/faaliyet özeti', needs: ['structuredOutput'], deterministic: 'Olay iş akışı', human: 'İnsan doğrulama' },
  AI10: { name: 'Belge soruları', needs: ['structuredOutput'], deterministic: 'Yetki filtreli arama', human: 'Aksiyon yetkisi yok' },
  AI11: { name: 'Yenileme özeti', needs: ['structuredOutput'], deterministic: 'Tarih motoru', human: 'Yetkili karar' },
  AI12: { name: 'Yıllık karne anlatısı', needs: ['structuredOutput'], deterministic: 'Şablon anlatı', human: 'Dönem/örneklem görünür' },
  AI13: { name: 'İmza görüntüsü', needs: ['vision', 'signatureDetection'], deterministic: '—', human: 'Taraf/sürüm bazlı insan' },
  // v2 Faz 4: puan ve karar kodda/insanda; model yalnız bulgu ve kanıt döndürür.
  AI14: { name: 'Sözleşme incelemesi (şablon + hukuk)', needs: ['structuredOutput'], deterministic: 'Puan kuralı (kod) + alıntı denetimi', human: 'Satınalma ve onaycılar; hukuki görüş değildir' },
  AI15: { name: 'Kanıt belgesi okuma', needs: ['structuredOutput'], deterministic: 'Alıntı denetimi + kural motoru', human: 'Kural motoru ve yetkili karar' },
};

export interface AiModel {
  id: string; provider: string; modelId: string; modelVersion: string; tasks: string[]; capabilities: Partial<Record<Capability, boolean>>;
  approvedRegions: string[]; trainsOnCustomerData: boolean; enabled: boolean;
  price: { unit: 'TOKEN_1M' | 'PAGE' | 'CALL'; input?: string | null; output?: string | null; page?: string | null; call?: string | null; currency: string };
}
export interface AiPolicy { allowedProviders: string[]; allowedRegions: string[]; monthlyBudget: string | null; budgetCurrency: string; dailyCallLimit: number | null; allowUpgrade: boolean }
export interface AiUsage { monthSpent: string; todayCalls: number }
/** İşin tahmini boyutu: token veya sayfa. */
export interface AiWorkload { inputTokens?: number; outputTokens?: number; pages?: number }

export type RouteDecision =
  | { decision: 'RUN'; model: AiModel; estimatedCost: string; warnings: string[] }
  | { decision: 'NO_PROVIDER' | 'NOT_ALLOWED' | 'WAIT_QUOTA'; reasons: string[]; estimatedCost: string | null };

/** Tahmini ücret; tarifenin gerekli kalemi bilinmiyorsa null (sıfır değil). */
export function estimateCost(m: AiModel, w: AiWorkload): string | null {
  const p = m.price;
  const need = (x: string | null | undefined) => (x == null || x === '' ? null : x);
  if (p.unit === 'PAGE') { const v = need(p.page); return v === null ? null : str(dec(v) * BigInt(w.pages ?? 1), 6); }
  if (p.unit === 'CALL') { const v = need(p.call); return v === null ? null : str(dec(v), 6); }
  const i = need(p.input); const o = need(p.output);
  if (i === null || o === null) return null;
  // TOKEN_1M: fiyat 1 milyon token başına; BigInt ölçekte bölme hassasiyeti için 6 basamak.
  const cost = (dec(i) * BigInt(w.inputTokens ?? 0) + dec(o) * BigInt(w.outputTokens ?? 0)) / 1_000_000n;
  return str(cost, 6);
}

/** Ayarlı model (ör. AI_MODEL_ID) katalogda kayıtlı ve etkin değilken gösterilen sebep. */
export const NO_CONFIGURED_MODEL_REASON = 'Seçili yapay zekâ modeli bu ortamda etkin değil.';

/**
 * Yönlendirme: görev yeteneği → kiracı politikası (sağlayıcı, bölge, eğitim yok) → bütçe/kota. Politika yoksa ücretli AI kapalıdır.
 * %80'de uyarı, %100'de yeni ücretli iş bekler (T23); manuel iş akışı ve belge korunur.
 */
export function routeTask(task: AiTask, models: AiModel[], policy: AiPolicy | null, usage: AiUsage, workload: AiWorkload, opts?: { modelId?: string }): RouteDecision {
  const need = AI_TASKS[task].needs;
  const capable = models.filter((m) => (opts?.modelId === undefined || m.modelId === opts.modelId) && m.enabled && m.tasks.includes(task) && need.every((c) => m.capabilities[c] === true));
  if (!capable.length) {
    // Final inceleme I2: ekranda gösterilen tam Türkçe cümle; ham model kimliği kullanıcıya gösterilmez (defterde model_id ayrıca durur).
    if (opts?.modelId !== undefined) return { decision: 'NO_PROVIDER', estimatedCost: null, reasons: [NO_CONFIGURED_MODEL_REASON] };
    return { decision: 'NO_PROVIDER', estimatedCost: null, reasons: [task === 'AI13' && models.some((m) => m.enabled && m.capabilities.vision)
      ? 'Görüntü işleyen model var ama imza tespiti yeteneği kayıtlı değil; görüntü işleme imza tespiti sayılmaz.'
      : `${AI_TASKS[task].name} için kayıtlı ve etkin model yok.`] };
  }
  if (!policy) return { decision: 'NOT_ALLOWED', estimatedCost: null, reasons: ['Kiracı AI politikası tanımlı değil; ücretli AI kapalı.'] };
  const reasons: string[] = [];
  const allowed = capable.filter((m) => {
    if (!policy.allowedProviders.includes(m.provider)) { reasons.push(`${m.provider}: kiracı politikasında izinli değil.`); return false; }
    if (!m.approvedRegions.some((r) => policy.allowedRegions.includes(r))) { reasons.push(`${m.provider}/${m.modelId}: izinli bölgede değil.`); return false; }
    if (m.trainsOnCustomerData) { reasons.push(`${m.provider}/${m.modelId}: müşteri verisiyle eğitim yapıyor.`); return false; }
    // Bütçe kontrolü kur varsayımı yapmaz: tarife bütçeyle aynı para biriminde olmalı.
    if (policy.monthlyBudget !== null && m.price.currency !== policy.budgetCurrency) { reasons.push(`${m.provider}/${m.modelId}: tarife ${m.price.currency}, bütçe ${policy.budgetCurrency}; kur dönüşümü yapılmaz.`); return false; }
    return true;
  });
  if (!allowed.length) return { decision: 'NOT_ALLOWED', estimatedCost: null, reasons };
  if (policy.dailyCallLimit !== null && usage.todayCalls >= policy.dailyCallLimit) {
    return { decision: 'WAIT_QUOTA', estimatedCost: null, reasons: [`Günlük çağrı sınırı (${policy.dailyCallLimit}) doldu; iş yarın veya limit artınca çalışır.`] };
  }
  // Fiyatı bilinen en ucuz uygun model; fiyatı bilinmeyen model bütçe tanımlıysa seçilmez.
  const priced = allowed.map((m) => ({ m, c: estimateCost(m, workload) }));
  const known = priced.filter((x): x is { m: AiModel; c: string } => x.c !== null).sort((a, b) => cmp(dec(a.c), dec(b.c)));
  if (policy.monthlyBudget === null) {
    const pick = known[0] ?? priced[0]!;
    return { decision: 'RUN', model: pick.m, estimatedCost: pick.c ?? 'UNKNOWN', warnings: pick.c === null ? ['Tarife bilinmiyor; tahmini ücret hesaplanamadı.'] : [] };
  }
  if (!known.length) return { decision: 'NOT_ALLOWED', estimatedCost: null, reasons: ['Uygun modellerin tarifesi bilinmiyor; bütçe kontrolü yapılamaz.'] };
  const pick = known[0]!;
  const budget = dec(policy.monthlyBudget);
  const after = add(dec(usage.monthSpent), dec(pick.c));
  if (cmp(dec(usage.monthSpent), budget) >= 0 || cmp(after, budget) > 0) {
    return { decision: 'WAIT_QUOTA', estimatedCost: pick.c, reasons: [`Aylık AI bütçesi doldu (${usage.monthSpent}/${policy.monthlyBudget} ${policy.budgetCurrency}); ücretli iş bekler, manuel akış devam eder.`] };
  }
  const warnings = cmp(after * 100n, budget * 80n) >= 0 ? [`Aylık AI bütçesinin %80'i aşıldı (${str(after, 2)}/${policy.monthlyBudget} ${policy.budgetCurrency}).`] : [];
  return { decision: 'RUN', model: pick.m, estimatedCost: pick.c, warnings };
}

export interface AiFieldOut { name: string; value: string | null; page?: number | null; evidence?: string | null }
export interface CheckedField { name: string; value: string | null; page: number | null; evidence: string | null; flags: string[] }
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr-TR');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Kelime/sayı sınırıyla geçiyor mu ("ABC12" "ABC123" içinde, "1.200" "11.200,00" içinde geçmez). */
const containsToken = (hay: string, needle: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(needle)}(?![\\p{L}\\p{N}])`, 'u').test(hay);

/**
 * Model çıktısı denetimi (T22). İzinli alan listesi dışındaki her anahtar (ör. "actions", "approve") yok sayılır ve işaretlenir.
 * Değer, belirtilen sayfadaki kanıt metninde geçmiyorsa NULL olur (uydurma kaynak kullanıcıya çıkmaz). Vergi kimliği AI'dan kesin
 * eşleşme için kullanılmaz; sağlama toplamı geçmezse NULL.
 */
export function checkAiOutput(raw: unknown, allowed: readonly string[], pages: string[]): { fields: CheckedField[]; flags: string[] } {
  const flags: string[] = [];
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (k !== 'fields') flags.push(`IGNORED_KEY:${k}`);
  const list = Array.isArray(obj.fields) ? (obj.fields as AiFieldOut[]) : [];
  const fields: CheckedField[] = [];
  for (const name of allowed) {
    const f = list.find((x) => x && x.name === name);
    const out: CheckedField = { name, value: null, page: null, evidence: null, flags: [] };
    if (!f || f.value == null || String(f.value).trim() === '') { out.flags.push('MISSING'); fields.push(out); continue; }
    const value = String(f.value).trim();
    const page = Number.isInteger(f.page) ? (f.page as number) : null;
    const evidence = typeof f.evidence === 'string' ? f.evidence : null;
    const text = page !== null && page >= 1 && page <= pages.length ? norm(pages[page - 1]!) : null;
    if (!evidence || text === null) out.flags.push('NO_SOURCE');
    // Kanıt, değerin kendisinden ibaret olamaz: etiket/bağlam içermeli (ör. "Fatura No ABC123").
    else if (norm(evidence).length < norm(value).length + 3) out.flags.push('WEAK_SOURCE');
    else if (!text.includes(norm(evidence))) out.flags.push('SOURCE_NOT_FOUND');
    else if (!containsToken(norm(evidence), norm(value))) out.flags.push('VALUE_NOT_IN_SOURCE');
    else if (name.includes('tax_id') && !normalizeTaxId('TR', 'VKN', value).ok && !normalizeTaxId('TR', 'TCKN', value).ok) out.flags.push('INVALID_TAX_ID');
    else { out.value = value; out.page = page; out.evidence = evidence; }
    fields.push(out);
  }
  for (const f of list) if (f && typeof f.name === 'string' && !allowed.includes(f.name)) flags.push(`IGNORED_FIELD:${f.name}`);
  return { fields, flags };
}
