// v2 Faz 1 (D93/D95): yeni sipariş bağı PUT'ta reddedildiği için eski (v1) sipariş bağlı fatura durumu bu fikstürle kurulur.
import type pg from 'pg';

type Allocation = { lineNo: number; poLineId: string | null; contractVersionId: string | null; quantity: string; amount: string };
type Res = { status: number; body: any };

/**
 * v2 Faz 1 (D93): yeni sipariş bağı kaldırıldı; PUT yalnız faturanın mevcut eski (v1) sipariş bağını korur veya kaldırır.
 * Eski sipariş bağlı fatura durumu test/demo verisi olarak kurulur: gövdedeki sipariş bağları v1'deki gibi doğrudan yazılır
 * (sahip bağlantısı, ürün davranışı değil), ardından aynı gövde PUT ile kaydedilir (koruma yolu: değerlendirme, departman
 * devralma, denetim olayı ve doğrulama hataları aynen çalışır). PUT reddedilirse yazılan satırlar geri alınır; önceki tahsis
 * değişmeden kalır (eski PUT'un davranışı).
 */
export async function legacyLinkPut(owner: pg.Pool, put: (body: unknown) => Promise<Res>, invoiceId: string,
  body: { allocations: Allocation[] } & Record<string, unknown>): Promise<Res> {
  const inserted: string[] = [];
  for (const a of body.allocations) {
    if (!a.poLineId) continue;
    const exists = (await owner.query(`SELECT 1 FROM invoice_allocations WHERE invoice_id = $1 AND po_line_id = $2`, [invoiceId, a.poLineId])).rowCount;
    if (exists) continue;
    inserted.push((await owner.query<{ id: string }>(`INSERT INTO invoice_allocations (tenant_id, company_id, invoice_id, line_no, po_line_id, contract_version_id, quantity, amount, created_by)
      SELECT tenant_id, company_id, id, $3, $2, NULL, $4, $5, created_by FROM invoices WHERE id = $1 RETURNING id`,
      [invoiceId, a.poLineId, a.lineNo, a.quantity, a.amount])).rows[0]!.id);
  }
  const r = await put(body);
  if (r.status !== 200 && inserted.length) await owner.query(`DELETE FROM invoice_allocations WHERE id = ANY($1::uuid[])`, [inserted]);
  return r;
}
