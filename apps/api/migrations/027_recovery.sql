-- 027 Lira Defteri: harcamanın kanıt zinciri ve "masada unutulan para" bulguları (D80).
-- Bulgular kurallarla hesaplanır (yapay zekâ karar vermez); talep, tahsil ve kapatma insan kaydıdır. Tutarlar decimal.

-- Ödeme tarihi: ERP "ödendi" olayının tarihi. Eski ödenmiş faturalarda boş kalır (uydurulmaz; erken ödeme kuralı çalışmaz).
ALTER TABLE invoices ADD COLUMN paid_at date;
GRANT UPDATE (paid_at) ON invoices TO sp_app;

-- Sözleşme koşullarına iki yapılandırılmış hüküm: vade (gün) ve kur farkı. Boş = sözleşmede girilmemiş (kural "incelenmeli" der).
ALTER TABLE contract_terms
  ADD COLUMN payment_days int CHECK (payment_days IS NULL OR payment_days BETWEEN 0 AND 365),
  ADD COLUMN fx_difference text CHECK (fx_difference IN ('ALLOWED','NOT_ALLOWED'));

-- Kur tablosu (ör. TCMB döviz satış): finans girer; düzeltme silip yeniden girerek (denetim izinde görünür).
CREATE TABLE fx_rates (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$' AND currency <> 'TRY'),
  rate_date date NOT NULL,
  rate numeric(20,6) NOT NULL CHECK (rate > 0),
  source text NOT NULL CHECK (length(btrim(source)) >= 2),
  entered_by uuid NOT NULL REFERENCES users(id),
  entered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, currency, rate_date)
);

-- Kiracı ayarı: yıllık sermaye maliyeti (%). Erken ödemenin maliyeti bununla hesaplanır; girilmezse kural çalışmaz.
CREATE TABLE recovery_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  capital_cost_rate numeric(7,4) NOT NULL CHECK (capital_cost_rate > 0 AND capital_cost_rate <= 500),
  set_by uuid NOT NULL REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now()
);

-- Bulgu (vaka). Konu anahtarı başına tek kayıt: tarama yeniden çalışınca açık vaka güncellenir, insanın üzerinde çalıştığı vaka değişmez.
CREATE TABLE recovery_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  code text NOT NULL,
  subject_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('FX_DIFF_NOT_ALLOWED','FX_DIFF_EXCESS','FX_DIFF_UNVERIFIED','ADVANCE_UNOFFSET','EARLY_PAYMENT','GUARANTEE_EXPIRY')),
  supplier_id uuid NOT NULL,
  invoice_id uuid,
  contract_version_id uuid,
  guarantee_id uuid,
  amount numeric(20,2) CHECK (amount IS NULL OR amount > 0),
  currency char(3) NOT NULL,
  summary text NOT NULL,
  basis jsonb NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED','CLAIMED','RECOVERED','DISMISSED','OBSOLETE')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  claimed_by uuid REFERENCES users(id),
  claimed_at timestamptz,
  claim_note text,
  recovered_by uuid REFERENCES users(id),
  recovered_at timestamptz,
  recovered_amount numeric(20,2) CHECK (recovered_amount IS NULL OR recovered_amount > 0),
  recovered_note text,
  dismissed_by uuid REFERENCES users(id),
  dismissed_at timestamptz,
  dismiss_reason text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, subject_key),
  FOREIGN KEY (tenant_id, company_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_version_id) REFERENCES contract_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, guarantee_id) REFERENCES contract_guarantees (tenant_id, id),
  -- Talep ve tahsil yalnız tedarikçiden geri alınabilir türlerde ve tutarı hesaplanmış vakada.
  CHECK (status NOT IN ('CLAIMED','RECOVERED') OR (kind IN ('FX_DIFF_NOT_ALLOWED','FX_DIFF_EXCESS','ADVANCE_UNOFFSET') AND amount IS NOT NULL)),
  CHECK ((status = 'RECOVERED') = (recovered_at IS NOT NULL) AND (recovered_at IS NULL) = (recovered_amount IS NULL) AND (recovered_at IS NULL) = (recovered_by IS NULL)),
  CHECK ((status = 'DISMISSED') = (dismissed_at IS NOT NULL) AND (dismissed_at IS NULL) = (dismissed_by IS NULL) AND (dismissed_at IS NULL OR length(btrim(dismiss_reason)) >= 10)),
  CHECK ((claimed_at IS NULL) = (claimed_by IS NULL) AND (claimed_at IS NULL OR length(btrim(claim_note)) >= 5)),
  CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
  CHECK (status NOT IN ('CONFIRMED','CLAIMED','RECOVERED') OR confirmed_at IS NOT NULL),
  CHECK (status NOT IN ('CLAIMED','RECOVERED') OR claimed_at IS NOT NULL)
);
CREATE INDEX recovery_cases_status ON recovery_cases (tenant_id, status);

-- Kapanmış vaka (tahsil edildi, kapatıldı) bir daha değişmez; silinmez.
CREATE OR REPLACE FUNCTION recovery_cases_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status IN ('RECOVERED','DISMISSED') THEN
    RAISE EXCEPTION 'immutable_record: recovery_cases' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_cases_guard BEFORE UPDATE OR DELETE ON recovery_cases FOR EACH ROW EXECUTE FUNCTION recovery_cases_guard();

ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON fx_rates USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, DELETE ON fx_rates TO sp_app;

ALTER TABLE recovery_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON recovery_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON recovery_settings TO sp_app;
GRANT UPDATE (capital_cost_rate, set_by, set_at) ON recovery_settings TO sp_app;

-- Vaka şirket kapsamındadır: kullanıcı yalnız erişebildiği şirketlerin bulgularını görür.
ALTER TABLE recovery_cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope ON recovery_cases USING (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()))
  WITH CHECK (tenant_id = app_tenant_id() AND company_id = ANY (app_company_ids()));
GRANT SELECT, INSERT ON recovery_cases TO sp_app;
GRANT UPDATE (kind, amount, currency, summary, basis, status, last_seen_at, contract_version_id, confirmed_by, confirmed_at, claimed_by, claimed_at, claim_note,
  recovered_by, recovered_at, recovered_amount, recovered_note, dismissed_by, dismissed_at, dismiss_reason) ON recovery_cases TO sp_app;
