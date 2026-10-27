/**
 * AI sağlayıcı bağdaştırıcısı. Gerçek sağlayıcı bu sürümde bağlı değildir (ücretli kaynak kullanıcı onayı ister; BLOCKED).
 * "test-" ile başlayan sağlayıcı yalnız NODE_ENV=test'te kaydedilebilir; canlı başarı gibi gösterilmez.
 * Sağlayıcıya araç/eylem yetkisi verilmez: yalnız metin girer, yapılandırılmış veri döner.
 */
export interface AiInput { task: string; pages: string[]; mimeType: string; allowedFields: readonly string[] }
export interface AiResult { output: unknown; usage: { inputTokens?: number; outputTokens?: number; pages?: number }; actualCost: string | null }
export interface AiProvider { name: string; run(modelId: string, input: AiInput): Promise<AiResult> }

const providers = new Map<string, AiProvider>();
export function registerAiProvider(p: AiProvider) {
  if (p.name.startsWith('test-') && process.env.NODE_ENV !== 'test') throw new Error('test AI provider only in NODE_ENV=test');
  providers.set(p.name, p);
}
export const aiProvider = (name: string) => providers.get(name) ?? null;
export const hasAiProviders = () => providers.size > 0;
