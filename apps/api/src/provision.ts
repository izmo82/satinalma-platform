import pg from 'pg';
import { parseArgs } from 'node:util';
import { normalizeRoles, normalizeTaxId, type TaxIdType } from '@sp/domain';

/**
 * İlk kurulum ve operasyon aracı (kurum içi veya bulut fark etmez). Owner bağlantısıyla çalışır, her değişikliği
 * denetim kaydına yazar. Kullanıcı parolası tutulmaz: kullanıcı davet edilir, ilk kurumsal IdP girişinde bağlanır.
 *
 *   provision tenant:create --name "Örnek A.Ş." --region TR --company "Örnek A.Ş." --tax-type VKN --tax-id 1234567890
 *   provision user:invite --tenant <id> --email ad@kurum.com.tr --name "Ad Soyad" --roles TENANT_ADMIN --companies all
 *   provision user:invite --tenant <id> --email teklif@tedarikci.com.tr --name "Ad Soyad" --roles SUPPLIER --supplier <supplierId>
 */
const OPS_ACTOR = null;

export async function provision(url: string, argv: string[], log = console.log): Promise<Record<string, string>> {
  const [command, ...rest] = argv;
  const { values: a } = parseArgs({
    args: rest, strict: true,
    options: {
      name: { type: 'string' }, region: { type: 'string' }, company: { type: 'string' }, country: { type: 'string', default: 'TR' },
      'tax-type': { type: 'string', default: 'VKN' }, 'tax-id': { type: 'string' }, currency: { type: 'string', default: 'TRY' },
      tenant: { type: 'string' }, email: { type: 'string' }, roles: { type: 'string' }, companies: { type: 'string', default: '' },
      reason: { type: 'string', default: 'initial provisioning' },
      supplier: { type: 'string' },
    },
  });
  const need = (k: keyof typeof a) => {
    const v = a[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`--${k} is required`);
    return v.trim();
  };
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    let out: Record<string, string>;
    if (command === 'tenant:create') {
      const taxType = need('tax-type') as TaxIdType;
      const tax = normalizeTaxId(need('country'), taxType, need('tax-id'));
      if (!tax.ok) throw new Error(`invalid tax id: ${tax.reason}`);
      const t = (await client.query<{ id: string }>('INSERT INTO tenants (name, data_region) VALUES ($1,$2) RETURNING id',
        [need('name'), need('region')])).rows[0]!;
      const c = (await client.query<{ id: string }>(
        `INSERT INTO legal_entities (tenant_id, name, country, tax_id_type, tax_id, default_currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [t.id, need('company'), need('country'), taxType, tax.normalized, need('currency')])).rows[0]!;
      await client.query(`INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, data, reason)
        VALUES ($1,$2,'tenant.provisioned','tenant',$1,$3,$4)`, [t.id, OPS_ACTOR, { companyId: c.id }, a.reason]);
      out = { tenantId: t.id, companyId: c.id };
    } else if (command === 'user:invite') {
      const tenantId = need('tenant');
      const email = need('email').toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid --email');
      // Eski ve v2 rol kodları kabul edilir; üyelikte v2 rolleri saklanır (D93).
      const given = need('roles').split(',').map((r) => r.trim());
      const unknown = given.filter((r) => !normalizeRoles([r]).length);
      if (unknown.length) throw new Error(`unknown roles: ${unknown.join(',')}`);
      const roles: string[] = normalizeRoles(given);
      // Tedarikçi portalı kullanıcısı: yalnız SUPPLIER rolü, şirket belgesi kapsamı yok, tek tedarikçiye bağlı.
      const supplierId = a.supplier?.trim() || null;
      if ((supplierId !== null) !== roles.includes('SUPPLIER') || (supplierId && roles.length !== 1)) {
        throw new Error('SUPPLIER role requires --supplier <id> and no other roles; --supplier is only valid with --roles SUPPLIER');
      }
      if (supplierId && !(await client.query('SELECT 1 FROM suppliers WHERE tenant_id = $1 AND id = $2', [tenantId, supplierId])).rowCount) {
        throw new Error('--supplier must belong to --tenant');
      }
      const companyIds = supplierId ? [] : a.companies === 'all'
        ? (await client.query<{ id: string }>('SELECT id FROM legal_entities WHERE tenant_id = $1', [tenantId])).rows.map((r) => r.id)
        : a.companies!.split(',').map((s) => s.trim()).filter(Boolean);
      const own = await client.query('SELECT 1 FROM legal_entities WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, companyIds]);
      if (own.rowCount !== companyIds.length) throw new Error('--companies must belong to --tenant');
      const existing = (await client.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(email) = $1 AND (auth_subject = 'invite|' || $1 OR auth_subject LIKE 'oidc|%') ORDER BY created_at LIMIT 1`, [email])).rows[0];
      const userId = existing?.id ?? (await client.query<{ id: string }>(
        `INSERT INTO users (auth_subject, email, display_name) VALUES ('invite|' || $1, $1, $2) RETURNING id`, [email, need('name')])).rows[0]!.id;
      await client.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, supplier_id) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, company_ids = EXCLUDED.company_ids, supplier_id = EXCLUDED.supplier_id, status = 'ACTIVE'`,
        [tenantId, userId, roles, companyIds, supplierId]);
      await client.query(`INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, data, reason)
        VALUES ($1,$2,'membership.provisioned','user',$3,$4,$5)`, [tenantId, OPS_ACTOR, userId, { roles, companyIds, supplierId }, a.reason]);
      out = { userId, tenantId };
    } else {
      throw new Error('usage: provision tenant:create|user:invite [options]');
    }
    await client.query('COMMIT');
    log(JSON.stringify(out));
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('DATABASE_OWNER_URL required');
  await provision(url, process.argv.slice(2));
}
