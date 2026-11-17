import { inScope } from '@sp/domain';
import type { DirectoryProvider, DirectoryScope, DirectoryUser } from './provider.ts';

// Microsoft Graph (salt okuma, istemci kimlik bilgileri). İstemci sırrı yalnız belirteç isteğinin gövdesinde bulunur;
// hata iletileri sabit Türkçe metindir, sunucu yanıtı ya da özgün hata iletisi hiçbir yere kopyalanmaz.

export class DirectoryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DirectoryError';
  }
}

const GRAPH = 'https://graph.microsoft.com';
const SELECT = 'id,displayName,mail,userPrincipalName,department,jobTitle,accountEnabled,onPremisesDistinguishedName';
const MAX_PAGES = 200;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 30_000;

const MESSAGES: Record<string, string> = {
  unauthorized: 'Entra kimlik bilgileri reddedildi. Kiracı, istemci kimliği ve sırrı kontrol edin.',
  forbidden: 'Uygulamanın dizini okuma izni yok (Microsoft Graph uygulama izinleri ve yönetici onayı).',
  not_found: 'Kapsamda belirtilen grup ya da yönetim birimi bulunamadı.',
  throttled: 'Microsoft Graph isteği sınırladı; birkaç dakika sonra yeniden deneyin.',
  network: 'Microsoft Graph\'a ulaşılamadı (ağ hatası).',
  bad_response: 'Microsoft Graph beklenmeyen bir yanıt verdi.',
  too_many_pages: `Kapsam çok geniş: ${MAX_PAGES} sayfadan fazla sonuç var. Kapsamı daraltın.`,
  http_error: 'Microsoft Graph isteği başarısız oldu.',
};
const fail = (code: string) => new DirectoryError(code, MESSAGES[code] ?? MESSAGES.http_error!);

export interface GraphOptions { sleep?: (ms: number) => Promise<void> }

interface GraphUser {
  id?: unknown; displayName?: unknown; mail?: unknown; userPrincipalName?: unknown; department?: unknown;
  jobTitle?: unknown; accountEnabled?: unknown; onPremisesDistinguishedName?: unknown; manager?: { id?: unknown } | null;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function mapUser(u: GraphUser): DirectoryUser | null {
  const objectId = str(u.id);
  if (!objectId) return null;
  return {
    objectId,
    // mail yoksa UPN e-posta sayılmaz: bu kullanıcıya rol verilemez.
    email: str(u.mail),
    displayName: str(u.displayName) ?? str(u.userPrincipalName) ?? objectId,
    userPrincipalName: str(u.userPrincipalName) ?? '',
    department: str(u.department),
    jobTitle: str(u.jobTitle),
    managerObjectId: str(u.manager?.id),
    accountEnabled: u.accountEnabled !== false,
    onPremisesDistinguishedName: str(u.onPremisesDistinguishedName),
  };
}

export function graphProvider(
  cfg: { tenantId: string; clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
  opts: GraphOptions = {},
): DirectoryProvider {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Sır nesnenin görünür alanlarında durmaz (JSON.stringify/günlük sızdırmaz).
  const secret = (() => cfg.clientSecret);
  let token: { value: string; expiresAt: number } | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try { res = await fetchImpl(url, init); } catch { throw fail('network'); }
      if ((res.status === 429 || res.status === 503) && attempt < MAX_ATTEMPTS) {
        const ra = Number(res.headers.get('retry-after'));
        const ms = Number.isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, MAX_RETRY_WAIT_MS) : 1000 * attempt;
        await sleep(ms);
        continue;
      }
      if (res.status === 429 || res.status === 503) throw fail('throttled');
      return res;
    }
  }

  async function getToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const body = new URLSearchParams({
      grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: secret(), scope: `${GRAPH}/.default`,
    });
    const res = await send(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw fail('unauthorized');
    if (!res.ok) throw fail('http_error');
    let j: { access_token?: unknown; expires_in?: unknown };
    try { j = await res.json() as typeof j; } catch { throw fail('bad_response'); }
    const value = str(j.access_token);
    if (!value) throw fail('bad_response');
    const ttl = typeof j.expires_in === 'number' ? j.expires_in : 3600;
    token = { value, expiresAt: Date.now() + ttl * 1000 };
    return value;
  }

  async function getPage(url: string): Promise<{ value: GraphUser[]; next: string | null }> {
    const res = await send(url, { headers: { authorization: `Bearer ${await getToken()}`, consistencylevel: 'eventual', accept: 'application/json' } });
    if (res.status === 401) { token = null; throw fail('unauthorized'); }
    if (res.status === 403) throw fail('forbidden');
    if (res.status === 404) throw fail('not_found');
    if (!res.ok) throw fail('http_error');
    let j: { value?: unknown; '@odata.nextLink'?: unknown };
    try { j = await res.json() as typeof j; } catch { throw fail('bad_response'); }
    if (!Array.isArray(j.value)) throw fail('bad_response');
    const next = str(j['@odata.nextLink']);
    // Belirteç yalnız Graph'a gider: nextLink başka sunucuya işaret ederse reddedilir.
    if (next && !next.startsWith(`${GRAPH}/`)) throw fail('bad_response');
    return { value: j.value as GraphUser[], next };
  }

  function firstUrl(scope: DirectoryScope): string {
    const q = `$select=${SELECT}&$expand=${encodeURIComponent('manager($select=id)')}&$top=999`;
    const id = encodeURIComponent(scope.value);
    switch (scope.type) {
      case 'GROUP': return `${GRAPH}/v1.0/groups/${id}/transitiveMembers/microsoft.graph.user?${q}`;
      case 'ADMIN_UNIT': return `${GRAPH}/v1.0/directory/administrativeUnits/${id}/members/microsoft.graph.user?${q}`;
      case 'OU_FILTER': return `${GRAPH}/v1.0/users?${q}`;
    }
  }

  return {
    kind: 'graph',
    label: 'Microsoft Entra ID (Microsoft Graph)',
    tenantLabel: cfg.tenantId,
    async testConnection() {
      try {
        const page = await getPage(`${GRAPH}/v1.0/users?$select=id&$top=1`);
        void page;
        return { ok: true };
      } catch (e) {
        if (e instanceof DirectoryError) return { ok: false, code: e.code, message: e.message };
        return { ok: false, code: 'http_error', message: MESSAGES.http_error! };
      }
    },
    async listUsers(scope) {
      const out: DirectoryUser[] = [];
      let url: string | null = firstUrl(scope);
      for (let pages = 1; url; pages++) {
        const page = await getPage(url);
        for (const raw of page.value) { const u = mapUser(raw); if (u) out.push(u); }
        if (page.next && pages >= MAX_PAGES) throw fail('too_many_pages');
        url = page.next;
      }
      return scope.type === 'OU_FILTER' ? out.filter((u) => inScope(u, scope.value)) : out;
    },
  };
}
