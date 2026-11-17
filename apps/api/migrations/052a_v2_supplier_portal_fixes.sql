-- 052a v2 Faz 5 (D110) Görev 2 inceleme düzeltmeleri. 052 uygulanmış olduğundan değiştirilmez; bu dosya telafi eder ve sıkılaştırır.
-- (1) app_portal_standing(): karne puanına giren risk seviyesi (scoreRiskLevel) supplierEval.ts yearSummary ile aynı hesaplanır:
--     tedarikçinin en yeni 50 değerlendirmesinden (supplierAssessments ile aynı pencere) durumu REVIEWED, incelemesi bu yıl ya da önce
--     tamamlanmış olanların (kalan risk ?? içsel risk) en yükseği. residualLevel (son tamamlanmış değerlendirmenin kalan riski) görüntü için kalır.
-- (2) public_application_create: açık başvuru denetiminden önce aynı kiracı + kimliğin süresi geçmiş doğrulanmamış (UNVERIFIED) başvuruları
--     EXPIRED işaretlenir (işçi henüz çalışmadıysa kimlik "işgal" edilemez; satır ve dosyalar silinmez).
-- (3) Derinlemesine savunma: tedarikçi oturumu yalnız PORTAL belgesi ekler; suppliers'ı doğrudan güncelleyemez (portal_update_contact
--     SECURITY DEFINER olduğundan etkilenmez); yenileme zinciri aynı tedarikçi + tür ve döngüsüz; tur daveti alıcı kullanıcı üzerinden de
--     tekil; hatırlatma bağlantı sütunları bir kez yazılır; NEEDS_DOCUMENTS boş belge listesiyle olmaz; ülke kodu iki büyük harf;
--     işlevlere gelen geçersiz girdi (uzun metin, bozuk sayı/tarih, eksik alan) SP422 olur.
-- Not (D110): doğrulama e-postası gövdesi düz metin belirteçli bağlantıyı içerir (gönderim için gerekli); e-posta kutusu ekranı maskeler.

-- 1. İçsel risk (domain inherentRisk ile aynı kural). Yalnız SECURITY DEFINER işlevlerinden kullanılır.
CREATE OR REPLACE FUNCTION supplier_inherent_level(f jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN f->>'dataSensitivity' = 'HIGH' AND f->>'accessLevel' = 'HIGH' THEN 'CRITICAL'
    WHEN 'HIGH' IN (coalesce(f->>'dataSensitivity', ''), coalesce(f->>'accessLevel', ''), coalesce(f->>'criticality', '')) THEN 'HIGH'
    WHEN (SELECT count(*) FROM jsonb_each_text(f) e WHERE e.value = 'HIGH') > 0
      OR (SELECT count(*) FROM jsonb_each_text(f) e WHERE e.value = 'MEDIUM') >= 2 THEN 'MEDIUM'
    ELSE 'LOW' END
$$;
REVOKE ALL ON FUNCTION supplier_inherent_level(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_portal_standing() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := app_tenant_id();
  v_supplier uuid := app_supplier_id();
  v_today date := (now() AT TIME ZONE 'Europe/Istanbul')::date;
  v_year int := extract(year FROM (now() AT TIME ZONE 'Europe/Istanbul'))::int;
  v_from date;
  v_to date;
  v_categories text[];
BEGIN
  IF v_tenant IS NULL OR v_supplier IS NULL THEN
    RAISE EXCEPTION 'portal_context_required' USING ERRCODE = '42501';
  END IF;
  SELECT s.service_categories INTO v_categories FROM suppliers s WHERE s.id = v_supplier AND s.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'portal_context_required' USING ERRCODE = '42501';
  END IF;
  v_from := make_date(v_year, 1, 1);
  v_to := make_date(v_year, 12, 31);
  RETURN jsonb_build_object(
    'surveys', coalesce((
      SELECT jsonb_agg(jsonb_build_object('ratio', x.ratio) ORDER BY x.reviewed_at)
      FROM (
        SELECT a.reviewed_at,
               round(sum(CASE r.response WHEN 'YES' THEN 2 WHEN 'PARTIAL' THEN 1 ELSE 0 END)::numeric * 100
                     / (count(*) FILTER (WHERE r.response IS DISTINCT FROM 'NOT_APPLICABLE') * 2), 1)::text AS ratio
        FROM (SELECT * FROM supplier_assessments
              WHERE tenant_id = v_tenant AND supplier_id = v_supplier ORDER BY created_at DESC LIMIT 50) a
        JOIN questionnaire_questions q ON q.template_id = a.template_id AND q.tenant_id = a.tenant_id
        LEFT JOIN assessment_answers r ON r.assessment_id = a.id AND r.question_id = q.id
        WHERE a.reviewed_at IS NOT NULL AND extract(year FROM (a.reviewed_at AT TIME ZONE 'Europe/Istanbul'))::int = v_year
        GROUP BY a.id, a.reviewed_at
        HAVING count(*) FILTER (WHERE r.response IS DISTINCT FROM 'NOT_APPLICABLE') > 0
      ) x), '[]'::jsonb),
    'review', (
      SELECT CASE WHEN (SELECT bool_and(p.scores ? d AND p.weights ? d) FROM unnest(ARRAY['quality','delivery','sla','communication','commercial']) d)
                  THEN jsonb_build_object('score', (round((SELECT sum((p.scores->>d)::numeric * (p.weights->>d)::numeric)
                                                         FROM unnest(ARRAY['quality','delivery','sla','communication','commercial']) d) / 100, 1))::text)
                  ELSE NULL END
      FROM performance_reviews p
      WHERE p.tenant_id = v_tenant AND p.supplier_id = v_supplier AND p.period_end >= v_from AND p.period_start <= v_to
      ORDER BY p.reviewed_at DESC LIMIT 1),
    'verifiedIncidents', coalesce((
      SELECT jsonb_agg(jsonb_build_object('severity', i.severity) ORDER BY i.occurred_on, i.code)
      FROM supplier_incidents i
      WHERE i.tenant_id = v_tenant AND i.supplier_id = v_supplier AND i.occurred_on BETWEEN v_from AND v_to
        AND (i.status = 'VERIFIED' OR (i.status = 'CLOSED' AND i.verified_at IS NOT NULL))
        AND i.duplicate_of_id IS NULL AND NOT i.dispute_open AND NOT i.counted_in_metric), '[]'::jsonb),
    'residualLevel', (
      SELECT a.residual_level FROM supplier_assessments a
      WHERE a.tenant_id = v_tenant AND a.supplier_id = v_supplier AND a.status = 'REVIEWED' AND a.reviewed_at IS NOT NULL
      ORDER BY a.reviewed_at DESC LIMIT 1),
    'scoreRiskLevel', (
      SELECT (ARRAY['LOW','MEDIUM','HIGH','CRITICAL'])[max(array_position(ARRAY['LOW','MEDIUM','HIGH','CRITICAL'],
               coalesce(a.residual_level, supplier_inherent_level(a.inherent_factors))))]
      FROM (SELECT * FROM supplier_assessments
            WHERE tenant_id = v_tenant AND supplier_id = v_supplier ORDER BY created_at DESC LIMIT 50) a
      WHERE a.status = 'REVIEWED' AND a.reviewed_at IS NOT NULL
        AND extract(year FROM (a.reviewed_at AT TIME ZONE 'Europe/Istanbul'))::int <= v_year),
    'actions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('title', c.title, 'dueDate', c.due_date::text, 'status', c.status) ORDER BY c.due_date, c.created_at)
      FROM corrective_actions c JOIN supplier_incidents i ON i.id = c.incident_id
      WHERE c.tenant_id = v_tenant AND i.supplier_id = v_supplier AND c.status <> 'VERIFIED'
        AND i.status <> 'REJECTED' AND i.duplicate_of_id IS NULL), '[]'::jsonb),
    'pendingSurveys', (
      SELECT count(*)::int FROM supplier_assessments a
      WHERE a.tenant_id = v_tenant AND a.supplier_id = v_supplier AND a.portal_status = 'SENT'),
    'missingDocs', (
      SELECT count(*)::int FROM supplier_document_types t
      WHERE t.tenant_id = v_tenant AND t.active AND (t.required OR t.required_categories && v_categories)
        AND NOT EXISTS (SELECT 1 FROM supplier_documents d
                        WHERE d.tenant_id = v_tenant AND d.supplier_id = v_supplier AND d.type_code = t.code AND d.superseded_by_id IS NULL
                          AND (d.valid_until >= v_today OR (d.valid_until IS NULL AND NOT t.expiry_required))))
  );
END $$;
REVOKE ALL ON FUNCTION app_portal_standing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_standing() TO sp_app;

-- 2. Belge yardımcısı: geçersiz girdi (bozuk sayı/tarih, uzun ya da eksik alan, kısıt) SP422 olur.
CREATE OR REPLACE FUNCTION supplier_application_add_documents(p_tenant uuid, p_application uuid, p_documents jsonb, p_allowed text[])
RETURNS int LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  d jsonb;
  v_type supplier_document_types%ROWTYPE;
  v_total bigint := 0;
  v_n int := 0;
  v_size bigint;
  v_valid date;
BEGIN
  IF p_documents IS NULL OR jsonb_typeof(p_documents) <> 'array' THEN
    RAISE EXCEPTION 'invalid_application: documents' USING ERRCODE = 'SP422';
  END IF;
  IF jsonb_array_length(p_documents) > 10 THEN
    RAISE EXCEPTION 'invalid_application: too_many_files' USING ERRCODE = 'SP422';
  END IF;
  FOR d IN SELECT * FROM jsonb_array_elements(p_documents) LOOP
    IF jsonb_typeof(d) <> 'object' THEN
      RAISE EXCEPTION 'invalid_application: documents' USING ERRCODE = 'SP422';
    END IF;
    SELECT * INTO v_type FROM supplier_document_types WHERE tenant_id = p_tenant AND code = d->>'typeCode' AND active;
    IF NOT FOUND OR (p_allowed IS NOT NULL AND NOT (v_type.code = ANY (p_allowed))) THEN
      RAISE EXCEPTION 'invalid_application: document_type' USING ERRCODE = 'SP422';
    END IF;
    BEGIN
      v_size := (d->>'sizeBytes')::bigint;
      v_valid := nullif(d->>'validUntil', '')::date;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'invalid_application: document_fields' USING ERRCODE = 'SP422';
    END;
    IF v_size IS NULL OR v_size <= 0 OR v_size > 10485760 THEN
      RAISE EXCEPTION 'invalid_application: file_size' USING ERRCODE = 'SP422';
    END IF;
    v_total := v_total + v_size;
    IF d->>'avScanStatus' = 'INFECTED' THEN
      RAISE EXCEPTION 'invalid_application: file_infected' USING ERRCODE = 'SP422';
    END IF;
    IF v_type.expiry_required AND v_valid IS NULL THEN
      RAISE EXCEPTION 'invalid_application: valid_until_required' USING ERRCODE = 'SP422';
    END IF;
    BEGIN
      INSERT INTO supplier_documents (tenant_id, application_id, type_code, title, original_filename, mime_type, size_bytes, sha256,
                                      storage_key, basic_check_status, basic_check_reason, av_scan_status, valid_until, uploaded_via)
      VALUES (p_tenant, p_application, v_type.code, coalesce(nullif(btrim(d->>'title'), ''), v_type.name), d->>'originalFilename',
              d->>'mimeType', v_size, d->>'sha256', d->>'storageKey', d->>'basicCheckStatus', d->>'basicCheckReason',
              d->>'avScanStatus', v_valid, 'APPLICATION');
    EXCEPTION
      WHEN string_data_right_truncation OR not_null_violation OR check_violation OR invalid_text_representation THEN
        RAISE EXCEPTION 'invalid_application: document_fields' USING ERRCODE = 'SP422';
      WHEN unique_violation THEN
        RAISE EXCEPTION 'invalid_application: storage_key' USING ERRCODE = 'SP422';
    END;
    v_n := v_n + 1;
  END LOOP;
  IF v_total > 41943040 THEN
    RAISE EXCEPTION 'invalid_application: total_size' USING ERRCODE = 'SP422';
  END IF;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION supplier_application_add_documents(uuid, uuid, jsonb, text[]) FROM PUBLIC;

-- 3. Başvuru açma: süresi geçmiş doğrulanmamış başvuru kimliği tutmaz; geçersiz girdi SP422.
CREATE OR REPLACE FUNCTION public_application_create(p_slug text, p_app jsonb, p_documents jsonb, p_token_hash bytea, p_ip_hash bytea, p_mail jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
  v_allowed_categories text[];
  v_email text := lower(btrim(coalesce(p_app->>'contactEmail', '')));
  v_country text := upper(coalesce(nullif(btrim(p_app->>'country'), ''), 'TR'));
  v_tax_type text := p_app->>'taxIdType';
  v_tax_id text := p_app->>'taxId';
  v_categories text[];
  v_id uuid;
BEGIN
  SELECT s.tenant_id, s.categories INTO v_tenant, v_allowed_categories
    FROM supplier_application_settings s WHERE s.public_slug = p_slug AND s.enabled;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'applications_closed' USING ERRCODE = 'SP404';
  END IF;
  IF p_app IS NULL OR jsonb_typeof(p_app) <> 'object' THEN
    RAISE EXCEPTION 'invalid_application: fields' USING ERRCODE = 'SP422';
  END IF;
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 OR p_ip_hash IS NULL OR octet_length(p_ip_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid_application: hash' USING ERRCODE = 'SP422';
  END IF;
  IF p_mail IS NULL OR jsonb_typeof(p_mail) <> 'object' OR coalesce(p_mail->>'status', '') NOT IN ('NOT_CONFIGURED','QUEUED')
     OR coalesce(p_mail->>'subject', '') = '' OR p_mail->>'body' IS NULL THEN
    RAISE EXCEPTION 'invalid_application: mail' USING ERRCODE = 'SP422';
  END IF;
  IF v_email !~ '^[^@\s]+@[^@\s]+$' THEN
    RAISE EXCEPTION 'invalid_application: contact_email' USING ERRCODE = 'SP422';
  END IF;
  IF v_country !~ '^[A-Z]{2}$' OR v_tax_type IS NULL OR v_tax_type NOT IN ('VKN','TCKN','FOREIGN') OR coalesce(v_tax_id, '') = '' THEN
    RAISE EXCEPTION 'invalid_application: tax_id' USING ERRCODE = 'SP422';
  END IF;
  IF p_app ? 'categories' AND jsonb_typeof(p_app->'categories') <> 'array' THEN
    RAISE EXCEPTION 'invalid_application: categories' USING ERRCODE = 'SP422';
  END IF;
  v_categories := coalesce(ARRAY(SELECT jsonb_array_elements_text(p_app->'categories')), '{}');
  IF NOT (v_categories <@ v_allowed_categories) THEN
    RAISE EXCEPTION 'invalid_application: categories' USING ERRCODE = 'SP422';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('supplier_application:' || v_tenant::text, 0));
  IF (SELECT count(*) FROM supplier_applications a
       WHERE a.tenant_id = v_tenant AND lower(a.contact_email) = v_email AND a.created_at > now() - interval '24 hours') >= 3
     OR (SELECT count(*) FROM supplier_applications a
       WHERE a.tenant_id = v_tenant AND a.ip_hash = p_ip_hash AND a.created_at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'SP429';
  END IF;
  -- Süresi geçmiş doğrulanmamış başvuru (işçi henüz işaretlemediyse) burada EXPIRED olur; kimliği başkasına kapatamaz.
  UPDATE supplier_applications
     SET status = 'EXPIRED', token_hash = NULL, token_purpose = NULL, token_expires_at = NULL, row_version = row_version + 1
   WHERE tenant_id = v_tenant AND country = v_country AND tax_id_type = v_tax_type AND tax_id = v_tax_id
     AND status = 'UNVERIFIED' AND token_expires_at <= now();
  IF EXISTS (SELECT 1 FROM supplier_applications a
              WHERE a.tenant_id = v_tenant AND a.country = v_country AND a.tax_id_type = v_tax_type AND a.tax_id = v_tax_id
                AND a.status IN ('UNVERIFIED','SUBMITTED','NEEDS_DOCUMENTS')) THEN
    RAISE EXCEPTION 'application_exists' USING ERRCODE = 'SP409';
  END IF;

  BEGIN
    INSERT INTO supplier_applications (tenant_id, legal_name, country, tax_id_type, tax_id, contact_name, contact_email, contact_phone,
                                       address, categories, services, token_hash, token_purpose, token_expires_at, ip_hash)
    VALUES (v_tenant, btrim(p_app->>'legalName'), v_country, v_tax_type, v_tax_id, btrim(p_app->>'contactName'), v_email,
            nullif(btrim(p_app->>'contactPhone'), ''), nullif(btrim(p_app->>'address'), ''), v_categories, nullif(btrim(p_app->>'services'), ''),
            p_token_hash, 'VERIFY', now() + interval '24 hours', p_ip_hash)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'application_exists' USING ERRCODE = 'SP409';
    WHEN check_violation OR not_null_violation OR string_data_right_truncation OR invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_application: fields' USING ERRCODE = 'SP422';
  END;

  PERFORM supplier_application_add_documents(v_tenant, v_id, coalesce(p_documents, '[]'::jsonb), NULL);

  BEGIN
    INSERT INTO email_outbox (tenant_id, to_email, subject, body_text, related_type, related_id, status)
    VALUES (v_tenant, v_email, p_mail->>'subject', p_mail->>'body', 'supplier_application', v_id, p_mail->>'status');
  EXCEPTION WHEN check_violation OR not_null_violation OR string_data_right_truncation THEN
    RAISE EXCEPTION 'invalid_application: mail' USING ERRCODE = 'SP422';
  END;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public_application_create(text, jsonb, jsonb, bytea, bytea, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_application_create(text, jsonb, jsonb, bytea, bytea, jsonb) TO sp_app;

-- 4. Tedarikçi oturumu yalnız PORTAL belgesi ekler (başvuru ve iç yükleme kanalları ona kapalı).
CREATE POLICY supplier_portal_insert ON supplier_documents AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_supplier_id() IS NULL OR uploaded_via = 'PORTAL');

-- 5. Tedarikçi oturumu suppliers satırını doğrudan güncelleyemez; iletişim değişikliği yalnız portal_update_contact (SECURITY DEFINER).
CREATE POLICY supplier_no_direct_update ON suppliers AS RESTRICTIVE FOR UPDATE
  USING (app_supplier_id() IS NULL)
  WITH CHECK (app_supplier_id() IS NULL);

-- 6. Yenileme zinciri: yenisi aynı tedarikçinin aynı türdeki belgesidir ve zincir döngü kurmaz. Bağlama ve yenileme bir kez yazılır (052).
CREATE OR REPLACE FUNCTION supplier_documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_new supplier_documents%ROWTYPE;
  v_cursor uuid;
  v_steps int := 0;
BEGIN
  IF (OLD.supplier_id IS NOT NULL AND NEW.supplier_id IS DISTINCT FROM OLD.supplier_id)
     OR (OLD.superseded_by_id IS NOT NULL AND NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id) THEN
    RAISE EXCEPTION 'immutable_record: supplier_documents' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.superseded_by_id IS NOT NULL AND OLD.superseded_by_id IS NULL THEN
    SELECT * INTO v_new FROM supplier_documents WHERE id = NEW.superseded_by_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR NEW.supplier_id IS NULL OR v_new.supplier_id IS DISTINCT FROM NEW.supplier_id OR v_new.type_code <> NEW.type_code THEN
      RAISE EXCEPTION 'supplier_documents: supersede must reference the same supplier and document type' USING ERRCODE = '23514';
    END IF;
    v_cursor := NEW.superseded_by_id;
    WHILE v_cursor IS NOT NULL LOOP
      IF v_cursor = NEW.id OR v_steps > 1000 THEN
        RAISE EXCEPTION 'supplier_documents: supersede cycle' USING ERRCODE = '23514';
      END IF;
      SELECT superseded_by_id INTO v_cursor FROM supplier_documents WHERE id = v_cursor;
      v_steps := v_steps + 1;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- 7. Tur daveti: kullanıcıya bağlı alıcıda (to_email boş olsa da) aynı tur için tek satır.
CREATE UNIQUE INDEX email_outbox_round_invite_user_once ON email_outbox (related_type, related_id, to_user_id)
  WHERE related_type IN ('rfq_round_invite');

-- 8. Hatırlatma: e-posta ve görev bağlantıları bir kez yazılır (NULL → değer); diğer sütunlar değişmez, satır silinmez.
DROP TRIGGER supplier_document_reminders_immutable ON supplier_document_reminders;
CREATE OR REPLACE FUNCTION supplier_document_reminders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.document_id, NEW.offset_days, NEW.due_on, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.document_id, OLD.offset_days, OLD.due_on, OLD.created_at)
     OR (OLD.email_outbox_id IS NOT NULL AND NEW.email_outbox_id IS DISTINCT FROM OLD.email_outbox_id)
     OR (OLD.task_id IS NOT NULL AND NEW.task_id IS DISTINCT FROM OLD.task_id) THEN
    RAISE EXCEPTION 'immutable_record: supplier_document_reminders' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_document_reminders_guard BEFORE UPDATE ON supplier_document_reminders FOR EACH ROW EXECUTE FUNCTION supplier_document_reminders_guard();
CREATE TRIGGER supplier_document_reminders_no_delete BEFORE DELETE ON supplier_document_reminders FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
GRANT UPDATE (email_outbox_id, task_id) ON supplier_document_reminders TO sp_app;

-- 9. Başvuru kısıtları.
ALTER TABLE supplier_applications
  ADD CONSTRAINT supplier_applications_requested_documents CHECK (status <> 'NEEDS_DOCUMENTS' OR cardinality(requested_documents) > 0),
  ADD CONSTRAINT supplier_applications_country CHECK (country ~ '^[A-Z]{2}$');
