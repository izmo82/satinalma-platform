# v2 Faz 4 — Yapay zekâ: sözleşme alan okuma, şablon karşılaştırma, hukuk incelemesi (+ kanıt belgesi okuma altyapısı) — Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sözleşme ekleme sihirbazının "Oku" adımında yapay zekâ belgeden alanları okur (değer, kaynak sayfa, alıntı, güven); "Tamamla ve doğrula" adımında öneriler insan tarafından kaydedilir (tutar, para birimi, tarihler ve VKN her zaman insan onayıyla). "İncele ve gönder" adımında ve sözleşme detayının "İnceleme" sekmesinde şablon karşılaştırması + hukuk ön incelemesi gösterilir: 0–100 puan (kod hesaplar), alt puanlar, bulgular, genel yorum, "Yapay zekâ ön incelemesidir, hukuki görüş değildir." Puan eşiğin altındaysa ek onaycı **önerilir**. Her çağrı kaydedilir ve Yönetim > Yapay zekâ'da görünür; aylık bütçe dolunca yeni çağrı bekler. Faz 7 için kanıt belgesi okuma altyapısı (servis + tablo, ekransız) hazırlanır. Web ve iOS birlikte.

**Architecture:** v1 yapay zekâ yönetişimi (`apps/api/src/modules/ai.ts`, `ai/provider.ts`, `packages/domain/src/aiRouter.ts`, tablolar `ai_models`, `ai_tenant_policies`, `ai_runs`) **genişletilir, yeniden yazılmaz**: her istek `requestAi` yönlendirme kapısından (model kaydı → kiracı politikası → bütçe/günlük sınır) geçer, deftere yazılır, `jobs` kuyruğunda `ai.run` işi olarak çalışır, çıktı sunucuda kaynağa karşı denetlenir ve yalnız "öneri" olarak saklanır. Yeni görev kodları: AI06 (mevcut "Sözleşme metadata") alan okuma, AI14 sözleşme incelemesi (şablon + hukuk, tek çağrı), AI15 kanıt belgesi okuma. Sağlayıcı: varsayılan kapalı; Anthropic Messages API bağdaştırıcısı yapılandırmayla; geliştirme/test için etiketli test sağlayıcısı (`test-fixture`). Puanlar kodda hesaplanır; model puan döndürse de yok sayılır.

**Tech Stack:** Fastify 5, PostgreSQL 17 RLS, Vitest, `@anthropic-ai/sdk` (yeni bağımlılık, yalnız bağdaştırıcıda), pdf.js (mevcut), React 19 + Vite + Tailwind/shadcn, Playwright, SwiftUI.

**Spec:** `docs/analiz-v2.md` §3.2 (Oku, Tamamla ve doğrula, şablon uygunluğu ve hukuk incelemesi), §3.9, §5 (`contract_extractions`, `contract_reviews`), §7 öneri 2, 3 ve 9; Figma web `4:1253` 08 Oku/tamamla, `5:141` 09 İncele ve gönder, `5:371` 10 Detay İnceleme, `5:3581` 23 Yönetim – Yapay zekâ; iOS `4:2175` Doğrulama, `4:2264` Sözleşme onayı. Kararlar D93–D107, Faz 3 planı (`2026-11-17-v2-faz3-sozlesme.md`, D108) — bu plan onun arayüzlerini tüketir: `contractIntake.ts` (`POST /contract-drafts`, `PUT /contracts/:familyId/fields`, `GET /contracts/:familyId/v2`, `approval-preview`, `submit`), `contractV2.ts`, `contract_template_versions`, `app_is_contract_approver`, `ContractWizard.tsx`, `ContractLifecycle.tsx` İnceleme sekmesi, iOS `ContractFieldsView.swift`, `ContractApprovalView.swift`.

## Global Constraints

- Sıfır gerileme: v1 yapay zekâ işlevleri aynen kalır — Yapay zekâ sayfasındaki görev matrisi, son çalıştırmalar ve "Yeniden dene", kiracı politikası (düzenle/kaldır), kullanım, model kaydı; belge girişinde fatura alanı okuma (AI02) ve `GET /document-versions/:id/ai-fields`; `extracted_fields` tablosu. `apps/api/test/ai.test.ts` değişmeden geçer. Faz 3'ün elle giriş akışı yapay zekâ kapalıyken aynen çalışır (Oku adımı dürüst durum gösterip 3. adıma geçer).
- Gerçek sağlayıcı ücretli ve dış kaynaktır: **bağlanmaz, çalıştırılmaz**. Varsayılan `AI_PROVIDER=none`. Test sağlayıcısı her ekranda "Test sağlayıcısı — gerçek değil" etiketiyle görünür; çıktısı gerçek okuma ya da gerçek doğruluk olarak raporlanmaz. Gerçek sağlayıcı kontrolleri doğrulama görevinde NOT_RUN.
- KVKK: sözleşme metni kurum dışına yalnız gerçek bağdaştırıcıyla çıkar ve o kapalıdır. Defterde (`ai_runs`) istem ve belge metni saklanmaz; günlüğe (`console`) metin yazılmaz.
- Yapay zekâ karar vermez: tutar, para birimi, tarihler, VKN, onay, puan ve ödeme kararını insan/kod verir. Okunan hiçbir değer `contract_terms`'e ya da aileye otomatik yazılmaz; yalnız kullanıcının Faz 3 alan kaydıyla girer. Puan onayı vermez, engellemez.
- Model kimliği tek ayar: `AI_MODEL_ID` (varsayılan `claude-sonnet-5-5`); sözleşme görevleri (AI06/AI14/AI15) yalnız bu `model_id`'li katalog satırına yönlenir.
- Kiracı bağlamı yalnız `withTenant`; `sp_app`; her yeni tablo `tenant_id` + RLS + en dar GRANT; sözleşmeye bağlı tablolarda departman ve onaycı görünürlüğü 048'deki `contract_versions` politikasıyla aynı ifade (aile departmanı `OR app_is_contract_approver(family_id)`). Uygulanmış migration düzenlenmez; yeni dosya `049_`.
- Ekran metni Türkçe; tarih/sayı tr-TR; test verisi sentetik (`syntheticPdf`, `syntheticVkn`); demo faturalar ANB2026000101, ANB2026000102, EGE2026000877'e dokunulmaz.
- Değiştirilen eski test dosyalarının başına `// v2 Faz 4 (D109): <neden>`. Commit görev başına, yerel; push yok.

## Rulings (plan yazarı; kullanıcı aksini söylerse değişir)

- R1 Sağlayıcı yapılandırması (`config.ai`): `AI_PROVIDER` = `none` (varsayılan) | `test` | `anthropic`; `AI_MODEL_ID` (varsayılan `claude-sonnet-5-5`). `test` üretimde (`NODE_ENV=production`) başlangıçta reddedilir (Faz 2 `DIRECTORY_PROVIDER=test` deseni). `anthropic` için `ANTHROPIC_API_KEY` zorunlu (yoksa başlangıç hatası, anahtarsız asla etkin olmaz); üretimde ayrıca `AI_EXTERNAL_TRANSFER_APPROVED=true` (KVKK/kurum onayı bayrağı) yoksa reddedilir. `registerAiProvider` "test-" önekli sağlayıcıyı `NODE_ENV=production` dışında kabul eder (önceden yalnız `test`; gevşetme, gerileme değil).
- R2 Yönlendirme kapıları v1'le aynı ve hepsi gerekir: katalog satırı etkin + bağdaştırıcı kurulu + kiracı politikası sağlayıcıyı ve bölgeyi izinli kılmış + bütçe/günlük sınır. Aylık bütçe dolunca (mevcut `WAIT_QUOTA`) yeni çağrı bekler, ekranda sebebi görünür, elle akış sürer. 049 kataloğa `anthropic/claude-sonnet-5-5` satırını ekler (görevler AI06, AI14, AI15; yetenek `structuredOutput`, `vision`; bölge kodu `anthropic-api`; `trains_on_customer_data=false`; tarife TOKEN_1M giriş `2.00` çıkış `10.00` USD, `verified_at NULL` — yorum: "Anthropic fiyat tablosu, etkinleştirmeden önce platform operasyonu doğrular"). Test sağlayıcısı satırı (`test-fixture`, bölge `local`, tarife CALL `0.010000` USD "test tarifesi") migration'da değil, yalnız `NODE_ENV≠production` seed'inde ve test kurulumunda eklenir.
- R3 Defter: `ai_runs`'a `prompt_version`, `input_tokens`, `output_tokens`, `response_model` eklenir; kim (`requested_by`), hangi belge sürümü (`document_version_id`), hangi model (`model_ref` + `response_model`), hangi istem sürümü, token ve ücret her çağrıda yazılır (çalışmayan istek de sebebiyle). İstem sürümleri kodda sabit: `PROMPT_VERSIONS = { AI06: 'sozlesme-alan-2026-11-v1', AI14: 'sozlesme-inceleme-2026-11-v1', AI15: 'kanit-okuma-2026-11-v1' }`.
- R4 Okuma çıktısı alan başına: değer (normalize), kaynak sayfa, alıntı (kanıt), güven (`HIGH`/`MEDIUM`/`LOW`/`MISSING`), işaretler, `requires_human`, karar (`PENDING`/`CONFIRMED`/`CORRECTED`/`REJECTED`), karar veren ve zamanı. Güveni **kod** belirler: metin katmanlı sayfada alıntı sayfada bulunmuyor ya da değer alıntıdan türetilemiyorsa (tarih/tutar/VKN tr-TR ayrıştırıcıyla) değer NULL + `MISSING` (uydurma kaynak kullanıcıya çıkmaz); doğrulanmış alıntıda modelin beyan ettiği güven ≥0,85 → HIGH, ≥0,60 → MEDIUM, değilse LOW. Metin katmanı olmayan (taranmış) sayfada değer LOW + `UNVERIFIED_SCAN` öneri olarak kalır, asla önceden doldurulmaz.
- R5 Kritik alanlar `amount`, `currency`, `signedOn`, `startDate`, `endDate`, `supplierVkn`: her zaman `requires_human=true`; form alanına önceden yazılmaz, yanında "Öneri: … (s. 3)" ve "Öneriyi kullan" düğmesi çıkar (açık insan eylemi); Faz 3'ün "Tutar, tarih ve VKN'yi belgeyle karşılaştırdım." onay kutusu sürer. Kritik olmayan HIGH/MEDIUM alanlar "Yapay zekâ" etiketiyle önceden doldurulur ama kayıt yine kullanıcının "Kaydet"iyle olur; LOW/MISSING alanlar boş ve "Sorulan alan" işaretli gelir. VKN önerisi sağlama basamağından geçmezse NULL; tedarikçi kartı eşleşmesi VKN'yle kesin veritabanı aramasıdır (yapay zekâ eşleştirmez).
- R6 Kararlar Faz 3 alan kaydında aynı işlemde yazılır: `PUT /contracts/:familyId/fields` gövdesine isteğe bağlı `aiDecisions: { extractionId, decision }[]`; `CONFIRMED` yalnız kaydedilen değer öneriye eşitse kabul (aksi 422 `decision_mismatch`; sunucu farkı `CORRECTED` olarak da yazabilir). Gönderim (`submit`) güncel belge sürümünün kritik alan önerilerinde `PENDING` kalan varsa 422 `ai_suggestions_pending` (alan listesiyle); okuma yoksa ya da çalışmadıysa engel yoktur.
- R7 İnceleme: tek AI14 çağrısı sözleşme PDF'i + türüne uyan güncel şablon sürümünün .docx metniyle. Model bulgu döndürür (kategori, tür `MISSING_CLAUSE`/`MODIFIED_CLAUSE`/`UNFAVORABLE`/`EXTRA_CLAUSE`/`LEGAL_RISK`, önem `HIGH`/`MEDIUM`/`LOW`/`INFO`, başlık, alıntı, sayfa, şablon atfı, öneri) ve bir paragraf genel yorum. Alıntı denetimi: `MISSING_CLAUSE` alıntısı şablon metninde, diğerleri sözleşmenin belirtilen sayfasında aranır; bulunmayan bulgu `verified=false`, "kaynak doğrulanamadı" etiketiyle gösterilir ve puana girmez. Modelin döndürdüğü puan/karar anahtarları yok sayılır (`IGNORED_KEY`).
- R8 Puan kuralı `inceleme-puan-2026-v1` (kod): kategoriler `TEMPLATE` (şablon uygunluğu) + hukuk başlıkları `LIABILITY` (sorumluluk sınırı), `PENALTY` (cezai şart), `TERMINATION` (fesih), `TERM_RENEWAL` (süre ve yenileme), `CONFIDENTIALITY` (gizlilik/KVKK), `IP` (fikri haklar), `JURISDICTION` (yetkili mahkeme), `FORCE_MAJEURE` (mücbir sebep), `PAYMENT` (ödeme koşulları), `UNILATERAL_CHANGE` (tek taraflı değişiklik). Kategori puanı = max(0, 100 − Σ ceza), ceza HIGH 35, MEDIUM 15, LOW 5, INFO 0 (yalnız doğrulanmış bulgular). Toplam = round(0,4 × TEMPLATE + 0,6 × hukuk ortalaması); şablon yoksa (tür OTHER ya da güncel şablon yok) TEMPLATE null, toplam = hukuk ortalaması ve ekranda "Şablon yok; yalnız hukuk incelemesi". Aynı bulgular her zaman aynı puanı verir.
- R9 İnceleme kaydı değişmez: puan, alt puanlar, bulgular, yorum, `model_id` (yanıttaki), istem sürümü, puan kuralı sürümü, şablon sürümü, belge sürümü. Yeni belge sürümü ya da yeni şablon sürümü eski incelemeyi "güncel değil" yapar (silinmez, geçmişte görünür); idempotent anahtar `AI14:{versionId}:{templateVersionId|none}:{promptVersion}`. "Yeniden incele" yalnız bekleyen/başarısız iş için yeni çağrı açar (v1 kuralı: çalışmış iş tekrar ücret yaratmaz).
- R10 Eşik: kiracı ayarı `contract_ai_settings.review_threshold` (varsayılan 60, 0–100; Yönetici değiştirir). Puan < eşik → İncele ve gönder adımında "Puan eşiğin altında; ek onaycı (ör. kurumun hukuk danışmanı) eklemeniz önerilir." ve Faz 3 "Onaycı ekle" kısayolu; zorlama yok, gönderim engellenmez, denetim olayı `contract.review_below_threshold_acknowledged` gönderimde yazılır. Onaycılar puanı ve bulguları (web Onaylar/İnceleme, iOS Sözleşme onayı) bilgi olarak görür.
- R11 Tetikleme ve zamanlama: Faz 3 taslak oluşturma (`POST /contract-drafts`) ve yeni ana sürüm yüklemesi okumayı (AI06) otomatik ister (idempotent `AI06:{versionId}:{promptVersion}`); "Yeniden oku" bekleyen/başarısız işi yeniden yönlendirir. İnceleme sihirbazın 4. adımına girişte ya da detaydaki "İncele" ile istenir. İkisi de eşzamansız `ai.run` işi; ekran 3 sn aralıkla durum sorar, en çok 2 dk sonra "Okuma sürüyor, alanları elle girebilirsiniz" der.
- R12 Bağdaştırıcı: `@anthropic-ai/sdk` `client.messages.create`; PDF `document` içerik bloğu (base64), şablon metni ve talimat `text` bloğu; yapılandırılmış çıktı `output_config.format` (JSON şeması, `additionalProperties:false`); `temperature` gönderilmez; düşünme varsayılan; `max_tokens` 16000; `maxRetries: 0` (ücretli çağrı en çok bir kez, v1 ilkesi); 32 MB / 600 sayfa sınırı çağrıdan önce denetlenir (aşarsa iş FAILED "belge sınırı aşıldı"). `stop_reason` `refusal` ya da `max_tokens` → FAILED, sebep Türkçe. Sunucu tarafı model yedeği (`fallbacks`) **kullanılmaz**: tek model ayarı ve defterdeki model kaydı bozulmasın diye (bilinçli karar). Ücret = yanıt token'ları × katalog tarifesi. Yalnız PDF desteklenir; başka tür FAILED "desteklenmeyen belge türü".
- R13 Doğruluk ölçümü (öneri 9): değerlendirme düzeneği (`npm run ai:eval -w @sp/api`) etiketli klasördeki (`<ad>.pdf` + `<ad>.labels.json`) sözleşmeleri yapılandırılmış sağlayıcıyla okur, alan bazında doğruluk ve kritik alan doğruluğunu hesaplar, raporu repo dışına yazar. Repoda yalnız 5 sentetik etiketli sözleşme vardır ve test sağlayıcısıyla koşulur ("düzenek sınaması — gerçek ölçüm değil"). 20–30 gerçek sözleşmeyle ölçüm NOT_RUN; ölçülmeden "okuyor" denmez, Yönetim ekranı da bunu yazar.
- R14 Kanıt belgesi okuma (Faz 7 altyapısı): `requestEvidenceReading(tx, ctx, { documentVersionId, purpose, questions: { id, text }[] })` → AI15; sonuç soru başına `answer` `YES`/`NO`/`UNCLEAR`, alıntı, sayfa, açıklama; alıntı doğrulanmazsa `UNCLEAR`'a düşer. Ekran ve uç yok; Faz 7 kural motoru tüketir. Puan yine kodda.
- R15 İzinler: `contract.ai.request` [PROCUREMENT, DEPARTMENT_USER] (okuma/inceleme isteme; departman kapsamı RLS'te), `contract.review.read` [ADMIN, PROCUREMENT, DEPARTMENT_USER, AUDITOR] (+ onaycı görünürlüğü RLS'ten), eşik ayarı mevcut `ai.policy.manage` [ADMIN], defter okuma mevcut `ai.read`.

## Review Focus

1. Hiçbir yolda model çıktısı insan kaydı olmadan `contract_terms`/`contract_families`'e yazılmamalı; kritik alanın önerisi formda önceden dolu gelmemeli.
2. Modelin döndürdüğü `score`, `approve`, `actions` gibi anahtarlar yok sayılmalı; puan yalnız `reviewScore` ile ve yalnız doğrulanmış bulgulardan hesaplanmalı; düşük puan gönderimi engellememeli.
3. `AI_PROVIDER=test` üretimde, `anthropic` anahtarsız ya da üretimde onay bayrağısız asla başlamamalı; test sağlayıcısının sonucu hiçbir ekranda etiketsiz görünmemeli.
4. Bütçe dolunca yeni çağrı kuyruğa girmemeli, sebep görünmeli, sihirbaz elle devam edebilmeli; eşzamanlı istekler bütçeyi birlikte aşmamalı (mevcut danışma kilidi).
5. Başka departmanın kullanıcısı okuma/inceleme kayıtlarını görmemeli; o sözleşmede onay adımına atanan görmeli (R6/048).

---

### Task 1: Domain — okuma denetimi, inceleme puanı, yönlendirme genişlemesi

**Files:** Create `packages/domain/src/contractAi.ts`, `packages/domain/test/contractAi.test.ts`; Modify `packages/domain/src/aiRouter.ts`, `packages/domain/test/aiRouter.test.ts` (yalnız ekleme), `packages/domain/src/index.ts`, `packages/domain/src/roles.ts`.

**Interfaces — Produces:**
- `AiTask` birliğine `AI14` ("Sözleşme incelemesi (şablon + hukuk)") ve `AI15` ("Kanıt belgesi okuma") eklenir; `routeTask(task, models, policy, usage, workload, opts?: { modelId?: string })` — `opts.modelId` verilirse yalnız o `modelId`'li satırlar aday (yoksa sebep "`<modelId>` için kayıtlı ve etkin model yok"). Eski çağrılar değişmez.
- `CONTRACT_AI_FIELDS` (title, contractType, supplierName, supplierVkn, signedOn, startDate, endDate, indefinite, noticePeriodDays, amount, currency, limitBasis, autoRenewal, contractNo, paymentTermDays, guarantee, slaPenalty, kvkkClause, governingCourt, priceEscalation), `FIELD_KIND` (date/money/vkn/currency/enum/int/bool/text), `CRITICAL_AI_FIELDS`, `AI_FIELD_TR`.
- `parseTrDate(s): string|null` ("31 Aralık 2028", "31.12.2028" → `2028-12-31`), `parseTrAmount(s): string|null` ("1.250.000,00 TL" → `"1250000.00"`).
- `checkContractExtraction(raw: unknown, pages: string[]): { fields: CheckedContractField[]; flags: string[] }` — R4/R5; `CheckedContractField = { field; value; page; evidence; confidence; flags; requiresHuman; prefill }`.
- `REVIEW_CATEGORIES`, `REVIEW_CATEGORY_TR`, `REVIEW_RUBRIC_VERSION = 'inceleme-puan-2026-v1'`, `checkReviewOutput(raw, contractPages, templateText|null): { findings: CheckedFinding[]; summary: string|null; flags: string[] }`, `reviewScore(findings, hasTemplate): { score: number; subScores: Record<ReviewCategory, number|null> }` — R7/R8.
- `belowThreshold(score, threshold): boolean`, `AI_DISCLAIMER = 'Yapay zekâ ön incelemesidir, hukuki görüş değildir.'`.
- `checkEvidenceOutput(raw, pages, questionIds)` — R14. `extractionAccuracy(expected: Record<string,string|null>, got: Record<string,string|null>): { perField: Record<string, boolean>; overall: number; critical: number }` — R13.
- İzinler R15.

- [ ] **Step 1: Testler** — kanıtla doğrulanan tutar `"1250000.00"` HIGH; kanıt sayfada yok → NULL + MISSING; değer kanıttan türetilemiyor (`VALUE_NOT_IN_SOURCE`); taranmış (boş) sayfa → LOW + `UNVERIFIED_SCAN`, `prefill=false`; kritik alan her güvende `requiresHuman=true`, `prefill=false`; kritik olmayan MEDIUM `prefill=true`; hatalı VKN NULL; izinsiz anahtar (`approve`, `actions`) yok sayılıp işaretlenir. `reviewScore`: bulgusuz 100; 1 HIGH TEMPLATE + 1 MEDIUM PAYMENT → TEMPLATE 65, PAYMENT 85, toplam round(0,4·65 + 0,6·((9·100+85)/10)) = 85; şablonsuz → TEMPLATE null; doğrulanmamış bulgu puana girmez; modelin `score` alanı yok sayılır. `MISSING_CLAUSE` alıntısı şablon metninden doğrulanır. `routeTask` `modelId` süzgeci; mevcut aiRouter testleri değişmeden geçer. `extractionAccuracy` örnek.
- [ ] **Step 2–4:** RED → yaz → GREEN (`npm test -w @sp/domain`, `npm run typecheck`). **Step 5: Commit.**

### Task 2: Şema (049) — defter alanları, okuma, inceleme, kanıt, eşik

**Files:** Create `apps/api/migrations/049_v2_contract_ai.sql`, `apps/api/test/contractAiSchema.test.ts`.

**Interfaces — Produces:**
- `ai_runs.task` CHECK `^AI(0[1-9]|1[0-5])$`; yeni sütunlar `prompt_version text`, `input_tokens int`, `output_tokens int`, `response_model text`; GRANT UPDATE yalnız bu sütunlara (+ mevcutlar).
- `ai_models` R2 Anthropic satırı (`ON CONFLICT DO NOTHING`).
- `contract_extractions(id, tenant_id, family_id, document_version_id, ai_run_id, field CHECK IN (…), value, page, evidence, confidence CHECK IN ('HIGH','MEDIUM','LOW','MISSING'), flags jsonb, requires_human bool, decision CHECK IN ('PENDING','CONFIRMED','CORRECTED','REJECTED') DEFAULT 'PENDING', decided_by, decided_at, created_at, UNIQUE(ai_run_id, field))`; GRANT SELECT, INSERT, UPDATE (decision, decided_by, decided_at).
- `contract_reviews(id, tenant_id, family_id, document_version_id, template_version_id NULL, ai_run_id UNIQUE, model_id, prompt_version, rubric_version, score int CHECK 0–100, sub_scores jsonb, summary text, created_at)` ve `contract_review_findings(id, tenant_id, review_id, category, kind, severity, title, quote, page, template_ref, suggestion, verified bool, ord int)`; ikisinde de yalnız SELECT, INSERT (değişmez, R9).
- `ai_evidence_readings(id, tenant_id, company_id NULL, document_version_id, ai_run_id UNIQUE, purpose text, question_set jsonb, result jsonb, created_at)`; SELECT, INSERT; RLS kiracı + belge görünürlüğü (belge sürümüne FK, `document_versions` politikası).
- `contract_ai_settings(tenant_id PK, review_threshold int NOT NULL DEFAULT 60 CHECK 0–100, updated_by, updated_at)`; SELECT, INSERT, UPDATE (review_threshold, updated_by, updated_at).
- RLS: hepsinde `tenant_id = app_tenant_id()`; sözleşme tablolarında 048 `contract_versions` RESTRICTIVE departman ifadesi + `OR app_is_contract_approver(family_id)`.

- [ ] **Step 1: Testler** — başka kiracı göremez; BT departman kullanıcısı İK sözleşmesinin okuma/incelemesini göremez, onay adımına atanınca görür; inceleme ve bulgu UPDATE/DELETE yetkisi yok (izin hatası); `AI14`/`AI15` görev kodu kabul, `AI16` red; eşik 101 red.
- [ ] **Step 2–4.** `npm run migrate -w @sp/api`, `npm test -w @sp/api` (eski testler değişmeden). **Step 5: Commit.**

### Task 3: Sağlayıcı katmanı — yapılandırma, Anthropic bağdaştırıcısı, test sağlayıcısı, metin çıkarma

**Files:** Create `apps/api/src/ai/anthropic.ts`, `apps/api/src/ai/testProvider.ts`, `apps/api/src/ai/prompts.ts`, `apps/api/src/ai/register.ts`, `apps/api/test/aiProviders.test.ts`; Modify `apps/api/src/config.ts`, `apps/api/src/ai/provider.ts`, `apps/api/src/ai/text.ts`, `apps/api/src/index.ts`, `apps/api/src/worker.ts`, `apps/api/src/seed.ts`, `apps/api/src/devdata.ts`, `apps/api/package.json`, `.env.example`.

**Interfaces — Produces:**
- `Config['ai'] = { provider: 'none'|'test'|'anthropic'; modelId: string; apiKey?: string; externalTransferApproved: boolean }` ve `loadAi(env)` — R1 reddetmeleri.
- `AiInput` genişler (geriye uyumlu): `document?: { bytes: Buffer; mimeType: string; pageCount: number }`, `templateText?: string|null`, `questions?: {id,text}[]`, `promptVersion?: string`; `AiResult.usage` + `model?: string`.
- `anthropicProvider(cfg): AiProvider` (`name: 'anthropic'`) — R12; JSON şemaları `prompts.ts`'te görev başına (`EXTRACTION_SCHEMA`, `REVIEW_SCHEMA`, `EVIDENCE_SCHEMA`) ve Türkçe sistem talimatları (belgedeki talimatlar veri sayılır, eylem yok, puan üretme). Uygulayıcı SDK kullanımını `claude-api` skill'inin TypeScript belgesinden doğrular (yapılandırılmış çıktı, PDF bloğu, tipli hatalar).
- `testFixtureProvider(): AiProvider` (`name: 'test-fixture'`): sentetik sözleşme sayfalarındaki etiketli satırlardan ("Sözleşme Bedeli:", "Başlangıç Tarihi:", "Yüklenici VKN:" …) deterministik okuma; inceleme için şablon başlıklarıyla sözleşme başlıklarını karşılaştırıp deterministik bulgu; kanıt soruları için anahtar kelime eşleşmesi. Token sabit, `actualCost` tarifeden.
- `registerConfiguredAiProvider(cfg)` — API ve worker başlangıcında; `hasAiProviders()` mevcut davranışla.
- `docxText(buf): string` (`text.ts`, `readZip` ile `word/document.xml`, paragraf sonları korunur).
- `syntheticContractPdf(opts)` (devdata) ve seed: `NODE_ENV≠production` ve `AI_PROVIDER=test` iken `test-fixture` katalog satırı + demo kiracı politikası (`test-fixture`, bölge `local`, bütçe `5.00 USD`).

- [ ] **Step 1: Testler** — `loadConfig`: production + `AI_PROVIDER=test` hata; `anthropic` anahtarsız hata; production + anthropic + onay bayrağı yok hata; varsayılan `none`, `modelId='claude-sonnet-5-5'`. Bağdaştırıcı istek biçimi SDK istemcisi taklitle (ağ yok): model `AI_MODEL_ID`, `document` bloğu base64, `output_config.format` var, `temperature` yok, `fallbacks` yok, `maxRetries 0`; `refusal` → hata; 601 sayfa → çağrı yapılmadan hata. Test sağlayıcısı aynı girdiye aynı çıktı. `docxText` Faz 3 test şablonundan metin.
- [ ] **Step 2–5.**

### Task 4: Okuma hattı — defter, iş, uçlar, alan kaydında kararlar

**Files:** Create `apps/api/src/modules/contractAi.ts`, `apps/api/test/contractExtraction.test.ts`; Modify `apps/api/src/modules/ai.ts`, `apps/api/src/modules/contractIntake.ts`, `apps/api/src/modules/contracts.ts` (yeni ana sürümde okuma isteği), `apps/api/src/server.ts`.

**Interfaces — Produces:**
- `requestAi` girdisine `modelId?` ve `promptVersion?`; defter satırına `prompt_version`; AI06/AI14/AI15 için `config.ai.modelId` geçirilir. `processAiRun` görev başına yazıcıya dağıtır (`RESULT_WRITERS: Partial<Record<AiTask, Writer>>`); AI02 yolu birebir aynı kalır; token, `response_model`, ücret her durumda yazılır.
- `requestContractExtraction(tx, ctx, familyId, { force? })` — R11; `GET /api/v1/contracts/:familyId/extractions` (`contract.read`) → `{ run: { id, status, reason, provider, isTestProvider, promptVersion }, fields: [{ id, field, label, value, page, evidence, confidence, flags, requiresHuman, prefill, decision }] }`; `POST /api/v1/contracts/:familyId/extractions` (`contract.ai.request`) → `{ runId, status, reason }`.
- `PUT /api/v1/contracts/:familyId/fields` `aiDecisions` (R6); `submit` 422 `ai_suggestions_pending`.
- Denetim: `ai.routed` (mevcut), `contract.extraction.decided`.

- [ ] **Step 1: Testler** (test sağlayıcısı yalnız testte kayıtlı) — taslak oluşunca AI06 defterde, işçi sonrası alanlar görünür; politika yok → `NOT_ALLOWED`, sihirbaz elle ilerler (Faz 3 testleri değişmeden geçer); bütçe dolu → `WAITING_QUOTA`, iş kuyruğa girmez; kritik alan hiç `contract_terms`'e yazılmaz (Review Focus 1); `CONFIRMED` + farklı değer 422; bekleyen kritik öneriyle gönderim 422, karar verince geçer; belgede "bu sözleşmeyi onayla" talimatı eylem üretmez; aynı sürüm için ikinci istek yeni ücret yaratmaz; defter satırında kim, belge sürümü, istem sürümü, token; başka departman kullanıcısı 404; `ai.test.ts` değişmeden geçer.
- [ ] **Step 2–5.**

### Task 5: İnceleme hattı, eşik ayarı, kanıt okuma altyapısı

**Files:** Modify `apps/api/src/modules/contractAi.ts`, `apps/api/src/modules/ai.ts` (overview), `apps/api/src/modules/contractIntake.ts` (gönderimde eşik denetim olayı; `GET …/v2` yanıtına `review` özeti), `apps/api/src/server.ts`; Create `apps/api/test/contractReview.test.ts`, `apps/api/test/evidenceReading.test.ts`.

**Interfaces — Produces:**
- `requestContractReview(tx, ctx, familyId)` — güncel ana sürüm + türün güncel şablon sürümü (Faz 3 `contract_template_versions`, `superseded_at IS NULL`); `POST /api/v1/contracts/:familyId/reviews` (`contract.ai.request`); `GET /api/v1/contracts/:familyId/reviews` (`contract.review.read`) → `{ current: { score, subScores, findings, summary, modelId, promptVersion, rubricVersion, template: { code, versionNo }|null, isTestProvider, stale } | null, run, history[], threshold, belowThreshold, disclaimer }`.
- `GET/PUT /api/v1/ai/contract-settings` (`ai.read` / `ai.policy.manage`) `{ reviewThreshold }`, denetim `ai.contract_settings.updated`.
- `GET /api/v1/ai/overview` genişler (eski alanlar aynen): `provider: { kind, modelId, label, external }` (label: "Bağlı değil", "Test sağlayıcısı — gerçek değil", "Anthropic API (kurum dışı)"), `runs[]` + `requestedBy` (ad), `documentVersionId`, `promptVersion`, `inputTokens`, `outputTokens`, `responseModel`, `isTestProvider`; `contractSettings`; `quality` metni R13 ("Gerçek sözleşmelerle doğruluk ölçümü yapılmadı (NOT_RUN)").
- `requestEvidenceReading(tx, ctx, input)` + AI15 yazıcısı → `ai_evidence_readings` (R14); `evidenceReadings(tx, documentVersionId)` okuma işlevi.

- [ ] **Step 1: Testler** — inceleme şablonla ve şablonsuz; puan `reviewScore` ile birebir; modelin `score: 100` döndürmesi yok sayılır; doğrulanmamış bulgu `verified=false`, puana girmez; yeni belge sürümü → eski `stale: true`; eşik altı puanla gönderim **engellenmez**, denetim olayı yazılır; Departman kullanıcısı eşiği değiştiremez (403); başka departman göremez, onaycı görür; overview'da defter sütunları; kanıt okuması alıntı doğrulanmazsa `UNCLEAR`; başka kiracı göremez.
- [ ] **Step 2–5.**

### Task 6: Doğruluk ölçüm düzeneği

**Files:** Create `apps/api/scripts/ai-eval.ts`, `apps/api/test/fixtures/ai-eval/` (5 sentetik `*.labels.json`; PDF'ler testte `syntheticContractPdf` ile üretilir), `apps/api/test/aiEval.test.ts`; Modify `apps/api/package.json` (`"ai:eval": "tsx --env-file-if-exists=../../.env scripts/ai-eval.ts"`).

**Interfaces — Produces:** `runEval({ dir, provider, modelId, out }): Promise<EvalReport>` (`EvalReport = { provider, isTestProvider, modelId, promptVersion, documents, perField: Record<field, { correct, total }>, overall, critical, createdAt }`); komut satırı `--dir <klasör> --out <dosya>`; sağlayıcı yapılandırmadan; çıktı repo dışına (varsayılan `~/ai-eval-raporlari/`); rapor başlığında test sağlayıcısıysa "Düzenek sınaması — gerçek ölçüm değil". Belge metni rapora yazılmaz.

- [ ] **Step 1: Testler** — sentetik set test sağlayıcısıyla koşar, rapor alanları dolu, `isTestProvider: true`; bir etiket bozulunca o alanın doğruluğu düşer.
- [ ] **Step 2–5.**

### Task 7: Web — Oku, Tamamla ve doğrula, İncele ve gönder, İnceleme sekmesi, Yönetim > Yapay zekâ

**Files:** Modify `apps/web/src/pages/ContractWizard.tsx`, `apps/web/src/pages/ContractLifecycle.tsx` (İnceleme ve Onaylar sekmeleri), `apps/web/src/pages/ContractOverview.tsx`, `apps/web/src/pages/EvaluationPages.tsx` (`AiPage`), `apps/web/playwright.config.ts` (API ortamına `AI_PROVIDER=test`); Create `apps/web/src/pages/ContractReview.tsx` (ortak inceleme kartı/bulgu listesi), `apps/web/e2e/contract-ai-v2.spec.ts`.

- Oku (Figma 08): iş durumu (Kuyrukta/Okunuyor/Tamamlandı/Bekliyor: sebep), alan listesi değer + "s. N" + güven etiketi (Yüksek/Orta/Düşük/Okunamadı) + alıntı; sayfa bağlantısı belge önizlemesini o sayfaya açar ve alıntıyı gösterir; test sağlayıcısı etiketi; "Yeniden oku"; sağlayıcı/politika/bütçe yoksa açık sebep + "Alanları elle girin" ile 3. adıma geçiş (Faz 3 davranışı).
- Tamamla ve doğrula: R5 (kritik alan önerisi + "Öneriyi kullan", "Sorulan alan" işareti, "Yapay zekâ" etiketi), kayıtta `aiDecisions`; `ai_suggestions_pending` hatası alan listesiyle.
- İncele ve gönder (Figma 09): Faz 3 boş durumu yerine inceleme kartı — puan, alt puanlar, bulgu sayıları önem derecesine göre, ilk 3 bulgu, yorum, model + istem + şablon sürümü, `AI_DISCLAIMER`; eşik altıysa öneri bandı + "Onaycı ekle" kısayolu; inceleme yoksa/çalışmadıysa dürüst durum, gönderim yine açık.
- Detay İnceleme (Figma 10): puan halkası, alt puan tablosu, bulgu listesi (önem süzgeci, tür, alıntı, sayfa bağlantısı Belge sekmesine, öneri, "kaynak doğrulanamadı"), yorum, geçmiş incelemeler ("güncel değil"), "İncele/Yeniden incele" (yetkiliye). Onaylar sekmesinde puan özeti onaycıya bilgi olarak.
- Yönetim > Yapay zekâ (Figma 23): üstte sağlayıcı durumu kartı + model kimliği (salt okunur, "tek ayar: AI_MODEL_ID"), bütçe ve kullanım (mevcut), çağrı defteri tablosu (Tarih, Kim, Görev, Belge sürümü, Model, İstem sürümü, Token giriş/çıkış, Ücret, Durum; test satırları etiketli), inceleme eşiği ayarı (Yönetici), doğruluk ölçümü bölümü (NOT_RUN metni). Mevcut görev matrisi, politika formu, model kaydı, yeniden dene aynen kalır.
- e2e (1440/1280/390): test sağlayıcısıyla ekle → Oku alanları → kritik öneriyi kullan → kaydet → incele kartı + uyarı → gönder; politika kaldırılınca elle akış; eşik altı öneri bandı ve gönderimin açık kalması; İnceleme sekmesi; Yönetim defter satırı; axe ve taşma. Veri değiştiren adımlar yalnız 1440.

- [ ] Adımlar: `impeccable` incelemesi, typecheck, build, yeni e2e + mevcut sözleşme/imza/navigasyon/a11y/governance spec'leri. Commit.

### Task 8: iOS — Doğrulama önerileri, Sözleşme onayında inceleme

**Files:** Modify `ios/Satinalma/Satinalma/Features/ContractFieldsView.swift`, `Features/ContractApprovalView.swift`, `Features/ContractsView.swift` (özet ekranında inceleme satırı), `Core/Models.swift`; Create `Features/ContractReviewView.swift`.

- Doğrulama (Figma iOS 3): tarama yüklenince okuma durumu; alanlarda öneri + sayfa + güven, kritik alanlarda "Öneriyi kullan" (önceden dolu değil), "Sorulan alan" işareti, test sağlayıcısı etiketi; kayıtta `aiDecisions`; yapay zekâ kapalıysa mevcut elle form aynen.
- Sözleşme onayı (Figma iOS 4): Faz 3 boş durumu yerine puan, en önemli 3 bulgu, `AI_DISCLAIMER`, "Tüm bulgular" → `ContractReviewView` (liste, önem, alıntı, sayfa, öneri). Karar düğmeleri değişmez; dokunuş sayısı artmaz.
- AX5 ve büyük yazı; `xcodebuild` 0 uyarı; simülatörde test sağlayıcılı yerel API ile uçtan uca.

### Task 9: Belgeler, doğrulama, inceleme

- [ ] Kararlar D109 (R1–R15), `docs/implementation-status.md` Faz 4 satırı: test sağlayıcısıyla PASS olanlar ayrı; gerçek Anthropic çağrısı, gerçek sözleşmelerle doğruluk ölçümü, KVKK/kanal kararı (analiz §9 Karar 3) NOT_RUN/BLOCKED; yapay zekâ işlev envanteri önce/sonra (web + iOS: v1 Yapay zekâ sayfası öğeleri, AI02 belge girişi, Faz 3 Oku/İnceleme boş durumları → yeni ekranlar).
- [ ] Tam koşu: `npm test -w @sp/domain`, `npm test -w @sp/api`, `npm run typecheck`, build, `npm run e2e -w @sp/web` (tam), `npm run ai:eval -w @sp/api` (sentetik, test sağlayıcısı), iOS derleme 0 uyarı.
- [ ] `persona-testci`: Departman kullanıcısı (web + iOS tarama) okuma → kritik alanları onaylama → inceleme → eşik altı öneri → gönderim; satınalma sorumlusu iOS'ta puanı görüp onaylar; Yönetici defteri, bütçeyi (dolunca bekleme) ve eşiği görür; yapay zekâ kapalıyken elle akış; Denetçi salt okur.
- [ ] Bütün dal incelemesi (`code-review` / `surgeon-reviewer`); bulgular tek düzeltme turunda.
