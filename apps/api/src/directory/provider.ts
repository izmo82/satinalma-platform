import type { Config } from '../config.ts';
import { graphProvider, type GraphOptions } from './graph.ts';
import { testProvider } from './testProvider.ts';

export interface DirectoryUser {
  objectId: string;
  /** Graph `mail`; yoksa null (UPN e-posta sayılmaz, bu kullanıcıya rol verilemez). */
  email: string | null;
  displayName: string;
  userPrincipalName: string;
  department: string | null;
  jobTitle: string | null;
  managerObjectId: string | null;
  accountEnabled: boolean;
  onPremisesDistinguishedName: string | null;
}
export interface DirectoryScope { type: 'GROUP' | 'ADMIN_UNIT' | 'OU_FILTER'; value: string }
export interface DirectoryProvider {
  kind: 'graph' | 'test';
  label: string;
  tenantLabel: string;
  testConnection(): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** Hata durumunda `DirectoryError` (code + sır içermeyen Türkçe ileti) fırlatır. */
  listUsers(scope: DirectoryScope): Promise<DirectoryUser[]>;
}

export { DirectoryError } from './graph.ts';

/** Yapılandırmaya göre sağlayıcı; `none` ya da eksik yapılandırmada null. `opts.sleep` testlerde Retry-After beklemesini taklit eder. */
export function directoryProvider(cfg: Config['directory'], fetchImpl?: typeof fetch, opts?: GraphOptions): DirectoryProvider | null {
  if (!cfg) return null;
  if (cfg.kind === 'graph') {
    if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) return null;
    return graphProvider({ tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: cfg.clientSecret }, fetchImpl, opts);
  }
  if (cfg.kind === 'test') return cfg.testFixture ? testProvider(cfg.testFixture) : null;
  return null;
}
