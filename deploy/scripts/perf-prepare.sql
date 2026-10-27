-- Performans ölçümü için hacim büyütme (Faz 7). YALNIZ geri yüklenmiş ölçüm kopyasında (sp_perf) çalıştırılır; canlı/geliştirme
-- veritabanına uygulanmaz. Demo kiracısının ilk şirketine sentetik fatura, satır, onay, görev ve denetim kaydı eklenir.
\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database() NOT LIKE 'sp_perf%' THEN RAISE EXCEPTION 'yalnız sp_perf* veritabanında çalışır (%).', current_database(); END IF; END $$;

CREATE TEMP TABLE ctx AS
SELECT t.id AS tenant_id,
  (SELECT id FROM legal_entities WHERE tenant_id = t.id ORDER BY name DESC LIMIT 1) AS company_id,
  (SELECT id FROM suppliers WHERE tenant_id = t.id AND status = 'ACTIVE' ORDER BY legal_name LIMIT 1) AS supplier_id,
  (SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.tenant_id = t.id AND 'FINANCE' = ANY(m.roles) LIMIT 1) AS user_id
FROM tenants t WHERE t.name = 'Örnek Holding (SENTETİK)';

INSERT INTO invoices (tenant_id, company_id, supplier_id, kind, invoice_no, issue_date, currency, created_by, created_at)
SELECT c.tenant_id, c.company_id, c.supplier_id, 'INVOICE', 'PERF' || lpad(g::text, 7, '0'), date '2026-01-01' + (g % 300), 'TRY', c.user_id,
  timestamptz '2026-01-01' + (g % 300) * interval '1 day'
FROM ctx c, generate_series(1, 20000) g;

INSERT INTO invoice_lines (tenant_id, company_id, invoice_id, line_no, description, quantity, unit, unit_price, net_amount, tax_rate, tax_amount)
SELECT i.tenant_id, i.company_id, i.id, n, 'Sentetik kalem ' || n, 2, 'adet', 250, 500.00, 20, 100.00
FROM invoices i, generate_series(1, 2) n WHERE i.invoice_no LIKE 'PERF%';

-- Yarısı onaylı; ERP bağdaştırıcısı olmadığı için aktarım "yapılandırılmadı".
INSERT INTO invoice_decisions (tenant_id, company_id, invoice_id, kind, check_hash, decided_by, decided_at)
SELECT i.tenant_id, i.company_id, i.id, 'APPROVAL', 'perf', c.user_id, i.created_at + interval '2 days'
FROM invoices i, ctx c WHERE i.invoice_no LIKE 'PERF%' AND right(i.invoice_no, 1) IN ('0','2','4','6','8');
INSERT INTO erp_exports (invoice_id, tenant_id, company_id, idempotency_key, status, last_error)
SELECT d.invoice_id, d.tenant_id, d.company_id, 'erp-invoice-' || d.invoice_id, 'NOT_CONFIGURED', 'ERP bağdaştırıcısı yapılandırılmadı'
FROM invoice_decisions d JOIN invoices i ON i.id = d.invoice_id WHERE i.invoice_no LIKE 'PERF%';

INSERT INTO tasks (tenant_id, company_id, kind, entity_type, entity_id, title, reason, next_action, assignee_role, severity, due_at, dedupe_key)
SELECT i.tenant_id, i.company_id, 'invoice.review', 'invoice', i.id, 'Fatura ' || i.invoice_no || ': inceleme', 'Sentetik yük', 'İnceleyin',
  CASE WHEN right(i.invoice_no, 1) IN ('1','3') THEN 'BUYER' ELSE 'FINANCE' END, 'NORMAL', now() + (random() * 20 - 10) * interval '1 day', 'perf:' || i.id
FROM invoices i WHERE i.invoice_no LIKE 'PERF%' AND right(i.invoice_no, 1) IN ('1','3','5','7');

INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, data, at)
SELECT c.tenant_id, c.user_id, 'perf.synthetic', 'invoice', NULL, '{}', now() - g * interval '1 minute'
FROM ctx c, generate_series(1, 200000) g;

ANALYZE;
SELECT 'invoices' AS t, count(*) FROM invoices UNION ALL SELECT 'invoice_lines', count(*) FROM invoice_lines UNION ALL SELECT 'invoice_decisions', count(*) FROM invoice_decisions
UNION ALL SELECT 'tasks', count(*) FROM tasks UNION ALL SELECT 'audit_events', count(*) FROM audit_events;
