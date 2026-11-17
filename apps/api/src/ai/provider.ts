import type { AiModel } from '@sp/domain';

/**
 * AI sağlayıcı bağdaştırıcısı. Gerçek sağlayıcı (Anthropic) yalnız yapılandırmayla (`AI_PROVIDER=anthropic` + anahtar) kurulur.
 * "test-" ile başlayan sağlayıcı üretim (NODE_ENV=production) dışında kaydedilebilir; canlı başarı gibi gösterilmez
 * (v2 Faz 4 R1: önceden yalnız NODE_ENV=test; geliştirme ortamında etiketli test sağlayıcısı için gevşetildi).
 * Sağlayıcıya araç/eylem yetkisi verilmez: yalnız belge/metin girer, yapılandırılmış veri döner.
 */
export interface AiInput {
  task: string;
  /** Sayfa metinleri (sunucuda kanıt doğrulaması için; test sağlayıcısı bunları okur). */
  pages: string[];
  mimeType: string;
  allowedFields: readonly string[];
  /** v2 Faz 4: belgenin kendisi (gerçek bağdaştırıcı PDF'i belge bloğu olarak gönderir). */
  document?: { bytes: Buffer; mimeType: string; pageCount: number };
  /** AI14: türün güncel şablon sürümünün .docx metni; şablon yoksa null. */
  templateText?: string | null;
  /** AI15: kanıt soruları. */
  questions?: { id: string; text: string }[];
  promptVersion?: string;
  /** Katalog tarifesi: gerçekleşen ücret = yanıt token'ları × tarife. Yoksa ücret bilinmez (null). */
  price?: AiModel['price'];
}
export interface AiResult {
  output: unknown;
  usage: { inputTokens?: number; outputTokens?: number; pages?: number };
  actualCost: string | null;
  /** Yanıttaki model kimliği (defterde `response_model`). */
  model?: string;
}
export interface AiProvider { name: string; run(modelId: string, input: AiInput): Promise<AiResult> }

const providers = new Map<string, AiProvider>();
export function registerAiProvider(p: AiProvider) {
  if (p.name.startsWith('test-') && process.env.NODE_ENV === 'production') throw new Error('test AI provider is forbidden in production');
  providers.set(p.name, p);
}
export const aiProvider = (name: string) => providers.get(name) ?? null;
export const hasAiProviders = () => providers.size > 0;
