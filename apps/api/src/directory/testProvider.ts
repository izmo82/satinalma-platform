import { readFile } from 'node:fs/promises';
import { inScope } from '@sp/domain';
import type { DirectoryProvider, DirectoryUser } from './provider.ts';

// Açıkça etiketli test dizini: gerçek Entra değildir, hiçbir yanıtta gerçek başarı gibi gösterilmez.
export const TEST_LABEL = 'Test dizini (gerçek Entra değil)';

async function load(path: string): Promise<{ tenantLabel: string; users: DirectoryUser[] }> {
  const j = JSON.parse(await readFile(path, 'utf8')) as { tenantLabel?: unknown; users?: unknown };
  if (!Array.isArray(j.users)) throw new Error('users dizisi yok');
  return { tenantLabel: typeof j.tenantLabel === 'string' ? j.tenantLabel : 'Test dizini', users: j.users as DirectoryUser[] };
}

export function testProvider(fixturePath: string): DirectoryProvider {
  return {
    kind: 'test',
    label: TEST_LABEL,
    tenantLabel: 'test',
    async testConnection() {
      try { await load(fixturePath); return { ok: true }; }
      catch { return { ok: false, code: 'fixture_unreadable', message: 'Test dizini dosyası okunamadı ya da biçimi geçersiz.' }; }
    },
    async listUsers(scope) {
      const { users } = await load(fixturePath);
      return scope.type === 'OU_FILTER' ? users.filter((u) => inScope(u, scope.value)) : users;
    },
  };
}
