import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.ts';
import type { AiInput, AiProvider, AiResult } from './provider.ts';
import { isContractAiTask, schemaFor, SYSTEM_PROMPTS, taskInstruction, templateBlockText } from './prompts.ts';

/**
 * v2 Faz 4 (R12) Anthropic bağdaştırıcısı. Ücretli, kurum dışı sağlayıcıdır: yalnız `AI_PROVIDER=anthropic` + anahtarla kurulur;
 * katalog satırı etkin ve kiracı politikası izinli değilse yönlendirme buraya hiç gelmez.
 * - Tek çağrı: `maxRetries: 0` (ücretli çağrı en çok bir kez; v1 ilkesi). Sunucu tarafı model yedeği (`fallbacks`) bilinçli olarak
 *   KULLANILMAZ: tek model ayarı (`AI_MODEL_ID`) ve defterdeki model kaydı bozulmasın diye. `temperature` gönderilmez; düşünme varsayılan.
 * - PDF `document` bloğu (base64) + (AI14) şablon metni `text` bloğu + görev metni; yapılandırılmış çıktı `output_config.format`.
 * - 32 MB / 600 sayfa sınırı çağrıdan önce denetlenir. `refusal` / `max_tokens` → hata (iş FAILED, sebep Türkçe).
 * - Belge ya da istem metni günlüğe ve hata iletisine yazılmaz.
 */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_PAGES = 600;
export const MAX_OUTPUT_TOKENS = 16000;

export type AiProviderErrorCode = 'DOCUMENT_LIMIT' | 'UNSUPPORTED_DOCUMENT' | 'UNSUPPORTED_TASK' | 'MODEL_MISMATCH' | 'REFUSAL' | 'MAX_TOKENS'
  | 'INCOMPLETE' | 'INVALID_OUTPUT' | 'RATE_LIMITED' | 'AUTH' | 'BAD_REQUEST' | 'PROVIDER_UNAVAILABLE' | 'CONNECTION';

/**
 * Sağlayıcı hatası: `code` makine için, `message` Türkçe ve ekranda gösterilebilir (belge metni içermez).
 * Final inceleme I1: sağlayıcı yanıt döndürdükten sonraki başarısızlıkta (ret, token sınırı, yarım yanıt, geçersiz çıktı) çağrı ücretlidir;
 * yanıttaki kullanım (`usage`) ve model (`model`) hatayla taşınır, yönlendirici gerçekleşen ücreti bunlarla yazar.
 * Yanıt yoksa (5xx, bağlantı) kullanım bilinmez: alanlar boş kalır, bütçede tahmin sayılır.
 */
export class AiProviderError extends Error {
  readonly usage?: AiResult['usage'];
  readonly model?: string;
  constructor(readonly code: AiProviderErrorCode, message: string, billed?: { usage: AiResult['usage']; model?: string }) {
    super(message); this.name = 'AiProviderError';
    if (billed) { this.usage = billed.usage; if (billed.model) this.model = billed.model; }
  }
}

/** Testte taklit edilebilen asgari istemci yüzeyi (`client.messages.create`). */
export interface AnthropicLike {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming, opts?: { maxRetries?: number }): Promise<unknown> };
}
export interface AnthropicDeps {
  client?: AnthropicLike;
  createClient?: (opts: { apiKey: string; maxRetries: 0 }) => AnthropicLike;
}

const defaultClient = (opts: { apiKey: string; maxRetries: 0 }): AnthropicLike => new Anthropic(opts) as unknown as AnthropicLike;

/** Ücret hesabı yönlendiricidedir (karar 6); geriye dönük ad için yeniden dışa aktarılır. */
export { costFromPrice } from './provider.ts';

function classify(e: unknown): AiProviderError {
  if (e instanceof AiProviderError) return e;
  if (e instanceof Anthropic.RateLimitError) return new AiProviderError('RATE_LIMITED', 'Sağlayıcı istek sınırına takıldı; iş tekrar ücret yaratmasın diye otomatik denenmez.');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new AiProviderError('AUTH', 'Sağlayıcı kimlik doğrulaması başarısız (anahtar ya da yetki).');
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.UnprocessableEntityError || e instanceof Anthropic.ContentTooLargeError || e instanceof Anthropic.NotFoundError) {
    return new AiProviderError('BAD_REQUEST', 'Sağlayıcı isteği kabul etmedi (belge ya da model uygun değil).');
  }
  if (e instanceof Anthropic.APIConnectionError) return new AiProviderError('CONNECTION', 'Sağlayıcıya bağlanılamadı ya da süre aşıldı.');
  if (e instanceof Anthropic.APIError) return new AiProviderError('PROVIDER_UNAVAILABLE', `Sağlayıcı hatası (${e.status ?? 'bilinmiyor'}).`);
  return new AiProviderError('PROVIDER_UNAVAILABLE', 'Sağlayıcı çağrısı başarısız.');
}

export function anthropicProvider(cfg: NonNullable<Config['ai']>, deps: AnthropicDeps = {}): AiProvider {
  if (!cfg.apiKey) throw new Error('ANTHROPIC_API_KEY gerekli: anahtarsız Anthropic sağlayıcısı kurulmaz');
  const client = deps.client ?? (deps.createClient ?? defaultClient)({ apiKey: cfg.apiKey, maxRetries: 0 });
  return {
    name: 'anthropic',
    async run(modelId: string, input: AiInput): Promise<AiResult> {
      const task = input.task;
      if (!isContractAiTask(task)) throw new AiProviderError('UNSUPPORTED_TASK', `${task} görevi bu sağlayıcıda desteklenmiyor.`);
      // Defterdeki model kaydı ile gönderilen model aynı olmalı (tek model ayarı).
      if (modelId !== cfg.modelId) throw new AiProviderError('MODEL_MISMATCH', 'Katalog modeli AI_MODEL_ID ayarıyla uyuşmuyor.');
      const d = input.document;
      if (!d || d.mimeType !== 'application/pdf') throw new AiProviderError('UNSUPPORTED_DOCUMENT', 'Yalnız PDF desteklenir: desteklenmeyen belge türü.');
      if (d.pageCount > MAX_PDF_PAGES) throw new AiProviderError('DOCUMENT_LIMIT', `Belge ${MAX_PDF_PAGES} sayfadan uzun: belge sınırı aşıldı.`);
      const template = task === 'AI14' && input.templateText ? input.templateText : null;
      // Base64 boyutu (4/3) dönüştürmeden önce hesaplanır: büyük belge için gereksiz bellek ayrılmaz.
      if (Math.ceil(d.bytes.length / 3) * 4 + Buffer.byteLength(template ?? '') > MAX_REQUEST_BYTES) {
        throw new AiProviderError('DOCUMENT_LIMIT', 'Belge 32 MB istek sınırını aşıyor: belge sınırı aşıldı.');
      }
      const data = d.bytes.toString('base64');
      const content: Anthropic.ContentBlockParam[] = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
        ...(template ? [{ type: 'text' as const, text: templateBlockText(template) }] : []),
        { type: 'text', text: taskInstruction(task, { questions: input.questions, hasTemplate: !!template }) },
      ];
      let msg: Anthropic.Message;
      try {
        msg = await client.messages.create({
          model: cfg.modelId,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: SYSTEM_PROMPTS[task],
          messages: [{ role: 'user', content }],
          output_config: { format: { type: 'json_schema', schema: schemaFor(task, input.questions) } },
        }, { maxRetries: 0 }) as Anthropic.Message;
      } catch (e) { throw classify(e); }
      // I1: yanıt geldiyse çağrı ücretlidir; sonraki her hata kullanım ve modeli taşır.
      const usage = { inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens, pages: d.pageCount };
      const billed = { usage, ...(typeof msg.model === 'string' ? { model: msg.model } : {}) };
      if (msg.stop_reason === 'refusal') throw new AiProviderError('REFUSAL', 'Model isteği reddetti; alanları elle girebilirsiniz.', billed);
      if (msg.stop_reason === 'max_tokens') throw new AiProviderError('MAX_TOKENS', 'Model yanıtı çıktı sınırına ulaştı; sonuç eksik olduğu için kullanılmadı.', billed);
      if (msg.stop_reason !== 'end_turn') throw new AiProviderError('INCOMPLETE', `Model yanıtı tamamlanmadı (${msg.stop_reason ?? 'bilinmiyor'}).`, billed);
      const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
      let output: unknown;
      try { output = JSON.parse(text); } catch { throw new AiProviderError('INVALID_OUTPUT', 'Model yanıtı geçerli JSON değil.', billed); }
      return { output, usage, actualCost: null, model: msg.model };
    },
  };
}
