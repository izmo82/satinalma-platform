-- 010 KDV dışı vergiler (ÖTV, ÖİV…): KDV matrahına girer ve ödenecek tutara eklenir. Belgede yazan değer beyandır.
ALTER TABLE invoice_lines ADD COLUMN other_tax_amount numeric(20,2) CHECK (other_tax_amount >= 0);
ALTER TABLE invoices ADD COLUMN declared_other_tax_total numeric(20,2) CHECK (declared_other_tax_total >= 0);
