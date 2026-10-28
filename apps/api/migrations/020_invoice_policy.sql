-- Faz 4 kalanları (02 §12–13): kategori bazında tolerans, KDV dışı vergilerin oran kontrolü, sözleşme limitinin vergi dahil/hariç
-- yöntemi. Yalnız sütun ekler; mevcut satırlar eski davranışı korur (kategori '' = para biriminin genel kuralı, limit NET).

-- Tolerans: para birimi + kategori. '' = o para biriminde kategori kuralı olmayan bütün alımlar. Kategori, siparişin projesinden gelir.
ALTER TABLE tolerance_rules ADD COLUMN category text NOT NULL DEFAULT '' CHECK (category = btrim(category) AND length(category) <= 200);
ALTER TABLE tolerance_rules DROP CONSTRAINT tolerance_rules_pkey;
ALTER TABLE tolerance_rules ADD PRIMARY KEY (tenant_id, currency, category);

-- KDV dışı vergiler satır başına ayrı: [{ "code": "4080", "name": "ÖİV", "rate": "7.5" | null, "amount": "75.00" }].
-- Oran varsa tutar = net × oran denetlenir; oransız (maktu, ör. ÖTV listesi) tutar beyandır ve ekranda öyle görünür.
-- other_tax_amount toplam olarak kalır (KDV matrahı ve ödenecek tutar hesabı değişmez).
ALTER TABLE invoice_lines ADD COLUMN other_taxes jsonb CHECK (other_taxes IS NULL OR jsonb_typeof(other_taxes) = 'array');

-- Sözleşme limiti: NET (vergi hariç, varsayılan) veya GROSS (KDV ve KDV dışı vergiler dahil). Koşul revizyonuyla değişir.
ALTER TABLE contract_terms ADD COLUMN limit_basis text NOT NULL DEFAULT 'NET' CHECK (limit_basis IN ('NET','GROSS'));

-- Sipariş satırının KDV oranı: vergi dahil limitli sözleşmede açık taahhüt brüt hesaplanır (zorunlu); diğerlerinde bilgi amaçlı.
ALTER TABLE po_lines ADD COLUMN tax_rate numeric(5,2) CHECK (tax_rate IS NULL OR tax_rate BETWEEN 0 AND 100);

-- Güncel kalem görünümü oranı da gösterir (sütun sona eklenir; CREATE OR REPLACE mevcut sütun sırasını korumalı).
CREATE OR REPLACE VIEW po_lines_current WITH (security_invoker = true) AS
SELECT pl.id, pl.tenant_id, pl.company_id, pl.po_id, pl.line_no, pl.kind, pl.description, pl.unit,
       coalesce(r.quantity, pl.quantity) AS quantity, coalesce(r.unit_price, pl.unit_price) AS unit_price,
       pl.quantity AS original_quantity, pl.unit_price AS original_unit_price, coalesce(r.change_no, 0) AS revision,
       pl.tax_rate
FROM po_lines pl
LEFT JOIN LATERAL (SELECT quantity, unit_price, change_no FROM po_line_revisions x WHERE x.po_line_id = pl.id ORDER BY change_no DESC LIMIT 1) r ON true;
