-- D92: ana veri fatura okuyamaz; açık aday tedarikçi görevleri tedarikçi kaydına taşınır.
UPDATE tasks t SET entity_type = 'supplier', entity_id = i.supplier_id
FROM invoices i
WHERE t.status = 'OPEN' AND t.kind = 'invoice_issue' AND t.entity_type = 'invoice' AND t.entity_id = i.id
  AND t.dedupe_key LIKE 'invoice-issue:%:SUPPLIER_NOT_ACTIVE';
