// v2 Faz 8 (D113): ERP sağlayıcı arayüzü (R1). Özellik başına uç nokta (adres, kaynak yolu, kimlik doğrulama) çözülmüş olarak gelir;
// sır yalnız çağrı anında `loadEndpointSecret` ile açılır ve sağlayıcı dışına çıkmaz. Sağlayıcı hataları sırdan arındırılmış iletiyle
// `ErpProviderError` olur; zaman aşımı "belirsiz"dir (`ErpTimeout`): yazmada tekrar göndermeden önce `find` ile sorgulanır.
import { ERP_FEATURE_CATALOG, type ErpAuthType, type ErpFeature } from '@sp/domain';
import type { Config } from '../config.ts';
import { ErpTimeout } from './adapter.ts';
import { taklitProvider } from './taklit.ts';
import { oracleEbsProvider } from './oracleEbs.ts';

export { ErpTimeout };

export type ErpProviderKind = 'TAKLIT' | 'ORACLE_EBS';

export type ResolvedEndpoint = {
  id: string;
  tenantId: string;
  feature: ErpFeature;
  baseUrl: string;
  resourcePath: string;
  authType: ErpAuthType;
  username: string | null;
  clientId: string | null;
  tokenUrl: string | null;
  /** Açılmış parola / istemci sırrı. Günlüğe, yanıta, hata iletisine yazılmaz. */
  secret: string | null;
  timeoutMs: number;
};

export interface ErpProvider {
  kind: ErpProviderKind;
  label: string;
  /** false = taklit; sonucu gerçek başarı gibi gösterilmez. */
  real: boolean;
  test(ep: ResolvedEndpoint): Promise<{ ok: boolean; message: string; latencyMs: number }>;
  read(ep: ResolvedEndpoint, feature: ErpFeature, cursor: string | null): Promise<{ records: unknown[]; nextCursor: string | null }>;
  find(ep: ResolvedEndpoint, feature: ErpFeature, idempotencyKey: string): Promise<{ externalRef: string } | null>;
  write(ep: ResolvedEndpoint, feature: ErpFeature, payload: Record<string, string | null>, idempotencyKey: string): Promise<{ externalRef: string }>;
}

/** Sağlayıcı hatası. `code` makine kodu (hata kaydı `code` sütunu), `message` sırdan arındırılmış Türkçe ileti (≤500). */
export class ErpProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message.slice(0, 500));
    this.name = 'ErpProviderError';
  }
}

export function assertReadable(feature: ErpFeature): void {
  if (!ERP_FEATURE_CATALOG[feature]?.reads) throw new ErpProviderError('feature_not_readable', 'Bu özellik ERP\'den okunmaz.');
}
export function assertWritable(feature: ErpFeature): void {
  if (!ERP_FEATURE_CATALOG[feature]?.writes) throw new ErpProviderError('feature_not_writable', 'Bu özellik ERP\'ye yazılmaz.');
}

/**
 * Yapılandırmaya göre sağlayıcı. Bir dağıtımda tek sağlayıcı vardır: `ERP_PROVIDER=taklit` yalnız TAKLIT'i, `oracle-ebs` yalnız
 * ORACLE_EBS'i açar; uç noktanın türü uymazsa null (çağıran NOT_CONFIGURED yazar). Taklit üretimde hiçbir yoldan açılmaz.
 */
export function erpProvider(kind: ErpProviderKind, config: Pick<Config, 'env' | 'erp'>, deps: { fetch?: typeof fetch } = {}): ErpProvider | null {
  const erp = config.erp;
  if (!erp || erp.provider === 'none') return null;
  const production = config.env === 'production';
  if (kind === 'TAKLIT') return erp.provider === 'taklit' && !production ? taklitProvider({ production }) : null;
  if (kind === 'ORACLE_EBS') return erp.provider === 'oracle-ebs' ? oracleEbsProvider({ allowedHosts: erp.allowedHosts, production, fetch: deps.fetch }) : null;
  return null;
}
