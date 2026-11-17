-- v2 Faz 3 (R8) Görev 3 düzeltmesi: şablon dosyası meta verisi kiracı genelidir. Belgeler şirket kapsamlı (RLS) olduğundan, farklı şirketteki
-- iç kullanıcı şablonu indiremezdi. Kapı yalnız şablon sürümünün dosya bilgisini döner; kiracı eşleşmeli ve tedarikçi bağlamı olmamalı.
CREATE OR REPLACE FUNCTION app_template_file(tv uuid)
RETURNS TABLE (storage_key text, original_filename text, mime_type text, size_bytes bigint, disposed boolean, document_id uuid, sha256 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT dv.storage_key, dv.original_filename, dv.mime_type, dv.size_bytes,
         EXISTS (SELECT 1 FROM document_disposals x WHERE x.document_id = dv.document_id),
         dv.document_id, dv.sha256::text
  FROM contract_template_versions v
  JOIN document_versions dv ON dv.tenant_id = v.tenant_id AND dv.id = v.document_version_id
  WHERE v.id = tv AND v.tenant_id = app_tenant_id() AND app_supplier_id() IS NULL
$$;
REVOKE ALL ON FUNCTION app_template_file(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_template_file(uuid) TO sp_app;
