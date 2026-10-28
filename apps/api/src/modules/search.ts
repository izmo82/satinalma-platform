import { can, type Permission } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { unprocessable } from '../errors.ts';

// Üst çubuk araması (04 §Bilgi mimarisi, 03 FR13 "kaynaklı arama"): yalnız kullanıcının okuma izni olan türler, satırlar RLS ile
// süzülür (şirket kapsamı dışı kayıt hiç dönmez). Her sonuç neyle eşleştiğini söyler. Sayılar yalnız görünen sonuçlardır.

const PER_TYPE = 6;
const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

interface Hit { type: string; id: string; title: string; ref: string | null; matched: string; status: string | null }

const SOURCES: { type: string; perm: Permission; sql: string; exact?: boolean }[] = [
  { type: 'project', perm: 'project.read', sql: `SELECT 'project' AS type, id, title, code AS ref, status,
      CASE WHEN code ILIKE $1 THEN 'Proje no' ELSE 'Başlık' END AS matched FROM projects WHERE code ILIKE $1 OR title ILIKE $1 ORDER BY updated_at DESC LIMIT ${PER_TYPE}` },
  { type: 'supplier', perm: 'supplier.read', exact: true, sql: `SELECT 'supplier' AS type, id, legal_name AS title, tax_id_type || ' ' || tax_id AS ref, status,
      CASE WHEN tax_id = $2 THEN 'Vergi kimliği' ELSE 'Ünvan' END AS matched FROM suppliers WHERE legal_name ILIKE $1 OR tax_id = $2 ORDER BY legal_name LIMIT ${PER_TYPE}` },
  { type: 'contract', perm: 'contract.read', sql: `SELECT 'contract' AS type, cv.id, f.title, f.code AS ref, cv.stage AS status,
      CASE WHEN f.code ILIKE $1 THEN 'Sözleşme no' ELSE 'Başlık' END AS matched FROM contract_families f
      JOIN LATERAL (SELECT id, stage FROM contract_versions v WHERE v.family_id = f.id AND v.superseded_by_id IS NULL LIMIT 1) cv ON true
      WHERE f.code ILIKE $1 OR f.title ILIKE $1 ORDER BY f.created_at DESC LIMIT ${PER_TYPE}` },
  { type: 'purchase_order', perm: 'po.read', sql: `SELECT 'purchase_order' AS type, po.id, s.legal_name AS title, po.code AS ref, po.status, 'Sipariş no' AS matched
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.code ILIKE $1 ORDER BY po.issued_at DESC LIMIT ${PER_TYPE}` },
  { type: 'invoice', perm: 'invoice.read', exact: true, sql: `SELECT 'invoice' AS type, i.id, s.legal_name AS title, i.invoice_no AS ref, i.kind AS status,
      CASE WHEN i.invoice_no ILIKE $1 THEN 'Fatura no' ELSE 'ETTN' END AS matched FROM invoices i JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.invoice_no ILIKE $1 OR i.ettn::text = lower($2) ORDER BY i.issue_date DESC LIMIT ${PER_TYPE}` },
  { type: 'document', perm: 'document.read', sql: `SELECT 'document' AS type, dv.id, d.title, d.code AS ref, d.kind AS status,
      CASE WHEN d.code ILIKE $1 THEN 'Belge no' ELSE 'Başlık' END AS matched FROM documents d
      JOIN LATERAL (SELECT id FROM document_versions v WHERE v.document_id = d.id ORDER BY v.version_no DESC LIMIT 1) dv ON true
      WHERE d.code ILIKE $1 OR d.title ILIKE $1 ORDER BY d.created_at DESC LIMIT ${PER_TYPE}` },
  { type: 'incident', perm: 'incident.read', sql: `SELECT 'incident' AS type, id, title, code AS ref, status,
      CASE WHEN code ILIKE $1 THEN 'Olay no' ELSE 'Başlık' END AS matched FROM supplier_incidents WHERE code ILIKE $1 OR title ILIKE $1 ORDER BY reported_at DESC LIMIT ${PER_TYPE}` },
];

export async function search(tx: Tx, ctx: TenantContext, q: string) {
  const term = q.trim();
  if (term.length < 2) throw unprocessable('query_too_short', 'Aramak için en az 2 karakter yazın.');
  const exact = term.replace(/\s+/g, '');
  const groups: { type: string; items: Hit[] }[] = [];
  for (const s of SOURCES) {
    if (!can(ctx.roles, s.perm)) continue;
    // Yalnız tam eşleşme alanı (vergi kimliği, ETTN) olan sorgular ikinci parametreyi alır.
    const rows = (await tx.query<Hit>(s.sql, s.exact ? [like(term), exact] : [like(term)])).rows;
    if (rows.length) groups.push({ type: s.type, items: rows });
  }
  return { query: term, groups, limitPerType: PER_TYPE };
}

// --- Bildirimler: kullanıcının rolüne atanmış açık görevlerden, son görülmeden sonra açılanlar ---

export async function notifications(tx: Tx, ctx: TenantContext) {
  const seen = (await tx.query<{ last_seen_at: Date }>(`SELECT last_seen_at FROM notification_reads WHERE user_id = $1`, [ctx.userId])).rows[0]?.last_seen_at ?? null;
  // Bildirim metni görev başlığıdır (hassas içerik yok: belge metni/tutar ayrıntısı görev açıklamasında kalır).
  const items = (await tx.query(`SELECT t.id, t.title, t.entity_type AS "entityType", t.entity_id AS "entityId", t.severity, t.created_at AS "createdAt",
      ($3::timestamptz IS NULL OR t.created_at > $3) AS unread
    FROM tasks t WHERE t.status = 'OPEN' AND t.assignee_role = ANY($1::text[]) AND (t.assignee_user_id IS NULL OR t.assignee_user_id = $2)
    ORDER BY t.created_at DESC LIMIT 20`, [ctx.roles, ctx.userId, seen])).rows;
  const unread = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM tasks t WHERE t.status = 'OPEN' AND t.assignee_role = ANY($1::text[])
    AND (t.assignee_user_id IS NULL OR t.assignee_user_id = $2) AND ($3::timestamptz IS NULL OR t.created_at > $3)`, [ctx.roles, ctx.userId, seen])).rows[0]!.n;
  return { items, unread, lastSeenAt: seen };
}

export async function markSeen(tx: Tx, ctx: TenantContext) {
  await tx.query(`INSERT INTO notification_reads (tenant_id, user_id, last_seen_at) VALUES ($1,$2,now())
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET last_seen_at = now()`, [ctx.tenantId, ctx.userId]);
  return { ok: true };
}

// --- Kayıtlı tablo görünümleri (kişisel) ---

export async function listViews(tx: Tx, page: string) {
  return (await tx.query(`SELECT id, name, params, created_at AS "createdAt" FROM saved_views WHERE page = $1 ORDER BY name`, [page])).rows;
}
export async function saveView(tx: Tx, ctx: TenantContext, b: { page: string; name: string; params: Record<string, unknown> }) {
  const r = (await tx.query<{ id: string }>(`INSERT INTO saved_views (tenant_id, user_id, page, name, params) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (tenant_id, user_id, page, name) DO NOTHING RETURNING id`, [ctx.tenantId, ctx.userId, b.page, b.name.trim(), b.params])).rows[0];
  if (!r) throw unprocessable('duplicate_name', 'Bu adla kayıtlı görünüm var; başka ad seçin veya önce silin.');
  return { id: r.id };
}
export async function deleteView(tx: Tx, id: string) {
  await tx.query(`DELETE FROM saved_views WHERE id = $1`, [id]);
  return { ok: true };
}
