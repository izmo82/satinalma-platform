import type { Config } from '../config.ts';
import { anthropicProvider, type AnthropicDeps } from './anthropic.ts';
import { registerAiProvider } from './provider.ts';
import { testFixtureProvider } from './testProvider.ts';

/**
 * v2 Faz 4 (R1): API ve işçi başlangıcında yapılandırılmış sağlayıcıyı kaydeder. `none` hiçbir şey kaydetmez (v1 davranışı: `hasAiProviders()`
 * yanlış kalır, `ai.run` işi çekilmez). Yapılandırma `loadAi` ile zaten doğrulanmıştır; burada ağ çağrısı yapılmaz.
 * Kaydedilen sağlayıcının adını döner (katalogdaki `provider` ile eşleşir).
 */
export function registerConfiguredAiProvider(cfg: Config['ai'] | undefined, deps: AnthropicDeps = {}): string | null {
  if (!cfg || cfg.provider === 'none') return null;
  const p = cfg.provider === 'test' ? testFixtureProvider() : anthropicProvider(cfg, deps);
  registerAiProvider(p);
  return p.name;
}
