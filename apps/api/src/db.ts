import pg from 'pg';

// numeric değerler string kalır (decimal kaybı yok); bigint de string.
pg.types.setTypeParser(1700, (v) => v);

export interface TenantContext {
  userId: string;
  tenantId: string;
  roles: string[];
  companyIds: string[];
  /** Tedarikçi portalı kullanıcısıysa temsil ettiği tedarikçi; RLS yalnız onun kayıtlarını açar. */
  supplierId?: string | null;
  correlationId: string;
}

export type Tx = pg.PoolClient;

export function createPool(url: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 10_000 });
}

/**
 * Her istek kendi transaction'ında, yalnız transaction-local (SET LOCAL eşdeğeri) kiracı bağlamıyla çalışır.
 * Bağlantı havuza döndüğünde bağlam otomatik düşer; pooled bağlantıda sızıntı olmaz (T03).
 */
export async function withTenant<T>(pool: pg.Pool, ctx: TenantContext, fn: (tx: Tx) => Promise<T>, opts: { snapshot?: boolean } = {}): Promise<T> {
  const client = await pool.connect();
  try {
    // snapshot: tek tutarlı görüntüden okuma (dışa aktarım); yazma yapılmaz.
    await client.query(opts.snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.company_ids', $3, true),
              set_config('app.supplier_id', $4, true)`,
      [ctx.tenantId, ctx.userId, `{${ctx.companyIds.join(',')}}`, ctx.supplierId ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Kiracı bağlamı olmadan yalnız SECURITY DEFINER kapılarını çağırmak için (kimlik çözümleme, iş çekme). */
export async function withoutTenant<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
