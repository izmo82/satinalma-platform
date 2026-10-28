// Seçici yeniden içe alma (08 "Tenant recovery: izole snapshot restore + selected reimport; bütün DB'yi geriye döndürme").
// Kaynak: izole geri yüklenmiş kopya (PITR veya pg_dump). Hedef: canlı veritabanı. Yalnız seçilen kiracının, seçilen tablolarında
// hedefte OLMAYAN satırlar eklenir; var olan satırın üzerine yazılmaz (farklıysa yalnız raporlanır), hiçbir şey silinmez.
// Varsayılan deneme (--apply yoksa hiçbir şey yazılmaz). Uygulamada tek transaction, kiracının denetim izine "ops.reimport" kaydı.
// Satır içeriği yazdırılmaz; yalnız tablo, sayı ve kimlik.
//
//   npx tsx apps/api/src/reimport.ts --source postgres://...restore --target postgres://...canli --tenant <uuid> \
//     --tables tasks,documents,document_versions [--ids <uuid,...>] --reason "Gerekçe" --operator "Ad Soyad" [--apply]
import pg from 'pg';

pg.types.setTypeParser(1700, (v) => v);

export interface ReimportOptions {
  tenantId: string;
  tables: string[];
  /** Yalnız bu birincil anahtarlar (tek sütunlu anahtar). Boş = kiracının tablodaki bütün eksik satırları. */
  ids?: string[];
  apply: boolean;
  reason: string;
  operator: string;
}

export interface TableResult { table: string; missing: number; inserted: number; differs: number; blockedByParent: number; sampleIds: string[] }

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function tableMeta(c: pg.PoolClient, table: string) {
  const cols = (await c.query<{ column_name: string; is_generated: string; data_type: string }>(
    `SELECT column_name, is_generated, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])).rows;
  if (!cols.length) throw new Error(`tablo yok: ${table}`);
  if (!cols.some((x) => x.column_name === 'tenant_id')) throw new Error(`kiracı sütunu olmayan tablo içe alınmaz: ${table}`);
  const pk = (await c.query<{ attname: string }>(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = format('public.%I', $1::text)::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [table])).rows.map((r) => r.attname);
  if (!pk.length) throw new Error(`birincil anahtarı olmayan tablo içe alınmaz: ${table}`);
  const kept = cols.filter((x) => x.is_generated !== 'ALWAYS');
  return { cols: kept.map((x) => x.column_name), json: new Set(kept.filter((x) => x.data_type === 'json' || x.data_type === 'jsonb').map((x) => x.column_name)), pk };
}

/** Seçilen tablolar arası yabancı anahtar sırası: önce üst tablolar. */
async function fkOrder(c: pg.PoolClient, tables: string[]) {
  const edges = (await c.query<{ child: string; parent: string; cols: string[]; pcols: string[] }>(`
    SELECT cl.relname AS child, pl.relname AS parent,
      array(SELECT attname FROM pg_attribute WHERE attrelid = co.conrelid AND attnum = ANY (co.conkey) ORDER BY array_position(co.conkey, attnum))::text[] AS cols,
      array(SELECT attname FROM pg_attribute WHERE attrelid = co.confrelid AND attnum = ANY (co.confkey) ORDER BY array_position(co.confkey, attnum))::text[] AS pcols
    FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_class pl ON pl.oid = co.confrelid
    WHERE co.contype = 'f' AND cl.relname = ANY ($1) AND cl.relnamespace = 'public'::regnamespace`, [tables])).rows;
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, stack: Set<string>) => {
    if (seen.has(t)) return;
    if (stack.has(t)) return; // döngü: ekleme sırası dışarıdan verildiği gibi
    stack.add(t);
    for (const e of edges) if (e.child === t && e.parent !== t && tables.includes(e.parent)) visit(e.parent, stack);
    seen.add(t); order.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return { order, edges };
}

export async function reimport(source: pg.Pool, target: pg.Pool, o: ReimportOptions) {
  const src = await source.connect();
  const dst = await target.connect();
  try {
    const sv = (await src.query<{ m: string }>(`SELECT max(name) AS m FROM schema_migrations`)).rows[0]!.m;
    const tv = (await dst.query<{ m: string }>(`SELECT max(name) AS m FROM schema_migrations`)).rows[0]!.m;
    if (sv !== tv) throw new Error(`şema sürümleri farklı (kaynak ${sv}, hedef ${tv}); önce kaynağa migration uygulayın`);
    if (!(await dst.query(`SELECT 1 FROM tenants WHERE id = $1`, [o.tenantId])).rowCount) throw new Error('kiracı hedefte yok');
    if (o.reason.trim().length < 10 || !o.operator.trim()) throw new Error('gerekçe (en az 10 karakter) ve işlemi yapan kişi zorunlu');

    // Kaynak tutarlı tek anlık görüntüden okunur.
    await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await dst.query('BEGIN');
    const { order, edges } = await fkOrder(dst, o.tables);
    const results: TableResult[] = [];
    const planned = new Map<string, { values: Record<string, string> }[]>(); // bu içe almada eklenecek üst satırlar (deneme dahil)
    for (const table of order) {
      const { cols, json, pk } = await tableMeta(dst, table);
      if (o.ids?.length && pk.length !== 1) throw new Error(`--ids yalnız tek sütunlu anahtarda: ${table}`);
      const parentEdges = edges.filter((e) => e.child === table && e.parent !== table);
      const fkCols = [...new Set(parentEdges.flatMap((e) => e.cols))];
      // Satır PostgreSQL'in kendi metin biçimiyle taşınır (tarih/saat/ondalık JS tipine çevrilmez; saat dilimi ve hassasiyet kaybı yok).
      // json/jsonb sütunları olduğu gibi; diğerleri ::text. Hedefte jsonb_populate_recordset türün kendi girdi işleviyle çözer.
      const parts: string[] = [];
      for (let i = 0; i < cols.length; i += 40) parts.push(`jsonb_build_object(${cols.slice(i, i + 40).map((c) => `'${c.replace(/'/g, "''")}', ${ident(c)}${json.has(c) ? '' : '::text'}`).join(', ')})`);
      const idFilter = o.ids?.length ? ` AND ${ident(pk[0]!)}::text = ANY ($2)` : '';
      const params = o.ids?.length ? [o.tenantId, o.ids] : [o.tenantId];
      const sel = `SELECT ${pk.map((k, i) => `${ident(k)}::text AS "k${i}"`).join(', ')}${fkCols.map((c, i) => `, ${ident(c)}::text AS "f${i}"`).join('')}, (${parts.join(' || ')})::text AS "j"
        FROM ${ident(table)} WHERE tenant_id = $1${idFilter}`;
      type Row = { key: string; fk: Record<string, string | null>; j: string };
      const read = async (c: pg.PoolClient): Promise<Row[]> => (await c.query(sel, params)).rows.map((r) => ({
        key: JSON.stringify(pk.map((_, i) => r[`k${i}`])), j: r.j as string,
        fk: Object.fromEntries(fkCols.map((c2, i) => [c2, r[`f${i}`] as string | null])) }));
      const srcRows = await read(src);
      const dstRows = new Map((await read(dst)).map((r) => [r.key, r.j]));
      const missing = srcRows.filter((r) => !dstRows.has(r.key));
      const differs = srcRows.filter((r) => dstRows.has(r.key) && dstRows.get(r.key) !== r.j).length;
      // Üst kaydı hedefte olmayan (ve bu içe almada gelmeyecek) satır eklenemez: raporlanır.
      const insertable: Row[] = [];
      let blocked = 0;
      for (const r of missing) {
        let ok = true;
        for (const e of parentEdges) {
          const vals = e.cols.map((c) => r.fk[c] ?? null);
          if (vals.some((v) => v === null)) continue;
          if ((planned.get(e.parent) ?? []).some((p) => e.pcols.every((c, i) => p.values[c] === vals[i]))) continue;
          const exists = (await dst.query(`SELECT 1 FROM ${ident(e.parent)} WHERE (${e.pcols.map((c) => `${ident(c)}::text`).join(', ')}) = (${vals.map((_, i) => `$${i + 1}`).join(', ')})`, vals)).rowCount;
          if (!exists) { ok = false; break; }
        }
        if (ok) insertable.push(r); else blocked++;
      }
      // Alt tabloların üst kontrolü için eklenecek satırların anahtar değerleri (tek sütunlu anahtar ve FK hedef sütunları).
      const targetCols = [...new Set(edges.filter((e) => e.parent === table).flatMap((e) => e.pcols))];
      const values = targetCols.length && insertable.length
        ? (await dst.query(`SELECT ${targetCols.map((c) => `${ident(c)}::text AS ${ident(c)}`).join(', ')} FROM jsonb_populate_recordset(NULL::${ident(table)}, $1::jsonb)`,
          [`[${insertable.map((r) => r.j).join(',')}]`])).rows.map((v) => ({ values: v as Record<string, string> }))
        : [];
      planned.set(table, values);
      let inserted = 0;
      if (o.apply) {
        for (let i = 0; i < insertable.length; i += 500) {
          const chunk = `[${insertable.slice(i, i + 500).map((r) => r.j).join(',')}]`;
          const r = await dst.query(`INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) OVERRIDING SYSTEM VALUE
            SELECT ${cols.map(ident).join(', ')} FROM jsonb_populate_recordset(NULL::${ident(table)}, $1::jsonb) ON CONFLICT DO NOTHING`, [chunk]);
          inserted += r.rowCount ?? 0;
        }
      }
      results.push({ table, missing: missing.length, inserted, differs, blockedByParent: blocked, sampleIds: missing.slice(0, 5).map((r) => JSON.parse(r.key).join('/')) });
    }
    if (o.apply) {
      await dst.query(`INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, data, reason) VALUES ($1, NULL, 'ops.reimport', 'tenant', $1, $2, $3)`,
        [o.tenantId, { operator: o.operator.trim(), sourceSchema: sv, tables: results.map(({ table, inserted, differs, blockedByParent }) => ({ table, inserted, differs, blockedByParent })) }, o.reason.trim()]);
      await dst.query('COMMIT');
    } else {
      await dst.query('ROLLBACK');
    }
    await src.query('COMMIT');
    return { applied: o.apply, results };
  } catch (err) {
    await dst.query('ROLLBACK').catch(() => undefined);
    await src.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    src.release(); dst.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const need = (n: string) => arg(n) ?? (console.error(`--${n} gerekli`), process.exit(2));
  const source = new pg.Pool({ connectionString: need('source'), max: 1 });
  const target = new pg.Pool({ connectionString: need('target'), max: 1 });
  try {
    const r = await reimport(source, target, {
      tenantId: need('tenant'), tables: need('tables').split(',').map((t) => t.trim()).filter(Boolean),
      ids: arg('ids')?.split(',').map((x) => x.trim()).filter(Boolean), apply: process.argv.includes('--apply'),
      reason: need('reason'), operator: need('operator'),
    });
    console.log(JSON.stringify(r, null, 2));
    if (!r.applied) console.log('Deneme: hiçbir şey yazılmadı. Uygulamak için --apply ekleyin.');
  } catch (err) {
    console.error(`İçe alma yapılmadı: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await source.end(); await target.end();
  }
}
