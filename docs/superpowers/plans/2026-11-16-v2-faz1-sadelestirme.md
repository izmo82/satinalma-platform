# v2 Faz 1: Sadeleştirme Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 12 rolü 5 role, 14 menü girişini 7'ye indirmek; proje, sözleşme, fatura ve risk değerlendirmesine departman alanı ve veritabanında (RLS) departman görünürlüğü eklemek; onaylı kaldırma listesini ekrandan ve yetkiden çıkarmak. Web + iOS birlikte.

**Architecture:** Roller yalnız API izin tablosunda (`packages/domain/src/roles.ts`) kullanılıyor; RLS rol bilmiyor. Bu yüzden tek boğaz noktası var: kayıtlı (eski veya yeni) roller `normalizeRoles` ile v2 rollerine çevrilir, izin tablosu yalnız v2 rollerini tanır. Departman görünürlüğü mevcut izin veren (permissive) politikalara dokunmadan, ek **RESTRICTIVE** politikalarla eklenir; alt tablolar ana kaydın RLS'ine `EXISTS` ile bağlanır. Kaldırma = rotayı, menüyü, düğmeyi ve yetkiyi kaldırmak; tablo, veri ve kod modülü yerinde kalır.

**Tech Stack:** Fastify 5, PostgreSQL 17 (RLS, elle SQL migration), React 19 + Vite + Tailwind 4/shadcn, SwiftUI (iOS 27), Vitest, Playwright.

**Spec:** `docs/analiz-v2.md` (onaylı), `docs/envanter-faz1.md` (işlev envanteri ve K maddeleri), `docs/decisions.md` D93–D95, Figma `V6jh1q5ZK11eRhVeKgHe6O` (onaylı ekranlar).

## Global Constraints

- v2 rol kodları: `ADMIN` (Yönetici), `PROCUREMENT` (Satınalma), `DEPARTMENT_USER` (Departman kullanıcısı), `SUPPLIER` (Tedarikçi), `AUDITOR` (Denetçi, salt okunur).
- Eski → yeni: TENANT_ADMIN, PLATFORM_OPS → ADMIN; BUYER, PROCUREMENT_MANAGER, MASTER_DATA, LEGAL, FINANCE → PROCUREMENT; REQUESTER, TECH_EVALUATOR, SECURITY → DEPARTMENT_USER; SUPPLIER → SUPPLIER; AUDITOR → AUDITOR. (LEGAL ve FINANCE işleri D95 ile Satınalma'ya geçti; SECURITY'nin değerlendirme işi iş birimine geçti.)
- v2 menüsü, bu sırayla: İşlerim · Projeler · Sözleşmeler · Tedarikçiler · Faturalar · Raporlar · Yönetim. Yönetim alt sekmeleri: Kullanıcılar ve Entra, Onaycılar, Şablonlar, Satınalma kuralları, Entegrasyonlar, Yapay zekâ, Denetim izi.
- Onaylı kaldırma listesi (D93) dışında hiçbir işlev kaldırılmaz. Karar verilmemiş K maddesi yerinde kalır.
- Hiçbir tablo, sütun veya satır silinmez. Kaldırılan uçlar 403 döner (izin hiçbir v2 rolünde yok); veri okunabilir kalır.
- Yeni tablo = RLS politikası + en dar GRANT. Kiracı bağlamı yalnız `withTenant`. Para decimal string.
- Departmanı boş (`NULL`) eski kayıt yalnız tüm departmanları gören rollere (ADMIN, PROCUREMENT, AUDITOR) görünür.
- Görev ayrılığı kişi bazında sürer: öneren/ekleyen kendi kaydını onaylayamaz, doğrulayamaz, kesinleştiremez (D95).
- Eski testler değiştirilmeden geçer; değiştirilen her test dosyasının başına `// v2 Faz 1 (D93/D95): <neden>` notu yazılır.
- Arayüz metni Türkçe; ham kod (rol kodu, izin kodu) kullanıcıya gösterilmez.
- Commit/push yalnız kullanıcı isteyince; plan adımlarındaki commit'ler kullanıcının görev başına onayıyla yapılır.

## Faz 1 için varsayılan K kararları (kullanıcı aksini demedikçe)

| K | Varsayılan | Gerekçe |
|---|---|---|
| K-02 kalemler | Kalır | Portal teklif formu kaleme dayanıyor |
| K-03 kiracı dışa aktarımı | Yönetim > Denetim izi sekmesinde; isteyen ADMIN, onaylayan PROCUREMENT (başka kişi) | Onaylayan Hukuk kalktı; D95'in Hukuk→Satınalma kuralı |
| K-04 tasarruf bazı | Kalır | Onaylı listede yok |
| K-06 proje içi kur | Kalır | Yalnız TCMB kur alma kalkıyor |
| K-07 CSV/XLSX/PDF | Kalır; ERP CSV Entegrasyonlar sekmesinde | Onaylı listede yok |
| K-08 tedarikçi onayı | Kişi bazında görev ayrılığı sürer | D95 ilkesi |
| K-09 sipariş | Web ve iOS sipariş ekranları kalkar; faturada sipariş referans numarası salt metin kalır | Onaylı liste |
| K-10 olaylar | Liste, durum makinesi, doğrulama kalır; menüde Tedarikçiler altında "Olaylar" sekmesi; iOS'ta Tedarikçiler sekmesinde | Onaylı listede yok |
| K-12 tatil listesi | API kalır, yetki ADMIN | Onaylı listede yok |
| K-13 zeyilname | Sözleşme detayında yerinde kalır | Onaylı listede yok |

## Review Focus

- Departman kullanıcısı, başka departmanın proje kimliğini adres çubuğuna yazarak teklif, değerlendirme veya sözleşme sürümü açabilmemeli (alt tablo sızıntısı) → Task 2 testi.
- Tedarikçi portal kullanıcısının departmanı yok; departman politikası portal okumalarını kırmamalı → Task 2 testi.
- Hem BUYER hem LEGAL gibi iki eski rolü olan kullanıcı tek PROCUREMENT olur; tek kişi artık iki adımı birden yapmamalı (görev ayrılığı kişi bazında) → Task 1 testi.
- Kaldırılan sayfanın eski adresi (yer imi, bildirim, arama sonucu) "sayfa bulunamadı" değil açıklayıcı bir ekrana gitmeli → Task 6 testi.
- Departmanı olmayan eski kayıt, departman kullanıcısının listesinde boş "departman" sütunuyla görünmemeli; hiç görünmemeli → Task 2 testi.

---

### Task 1: v2 rolleri ve izin tablosu (domain)

**Files:**
- Modify: `packages/domain/src/roles.ts`
- Test: `packages/domain/test/roles.test.ts` (yeni)

**Interfaces:**
- Produces: `V2_ROLES = ['ADMIN','PROCUREMENT','DEPARTMENT_USER','SUPPLIER','AUDITOR'] as const`; `type Role = (typeof V2_ROLES)[number]`; `LEGACY_ROLE_MAP: Record<string, Role>`; `normalizeRoles(stored: readonly string[]): Role[]` (tekilleştirilmiş, bilinmeyen kod düşer); `can(roles, permission)` imzası aynı; `SEES_ALL_DEPARTMENTS: readonly Role[] = ['ADMIN','PROCUREMENT','AUDITOR']`; `REMOVED_PERMISSIONS: readonly string[]`.

- [ ] **Step 1: Write the failing test** — `roles.test.ts`:
  - `normalizeRoles(['BUYER','LEGAL'])` → `['PROCUREMENT']`; `normalizeRoles(['REQUESTER','TECH_EVALUATOR'])` → `['DEPARTMENT_USER']`; `normalizeRoles(['TENANT_ADMIN'])` → `['ADMIN']`; `normalizeRoles(['PROCUREMENT'])` → `['PROCUREMENT']`; `normalizeRoles(['NOPE'])` → `[]`.
  - Her `REMOVED_PERMISSIONS` öğesi için hiçbir v2 rolü `can` ile true dönmez. Liste tam olarak: `approval.policy.manage`, `bank.change.decide`, `po.read`, `po.manage`, `receipt.record`, `invoice.approve`, `invoice.exception.approve`, `tolerance.manage`, `recovery.read`, `recovery.manage`, `recovery.settle`, `recovery.settings`, `retention.read`, `retention.manage`, `legal_hold.manage`, `disposal.propose`, `disposal.approve`.
  - `can(['AUDITOR'], p)` yalnız okuma izinlerinde true (`*.read`, `integration.reconcile`, `audit.read`, `report.read`, `ai.read`); hiçbir `manage/approve/decide/submit/record` izninde true değil.
  - Korunan işlevler: `can(['PROCUREMENT'], 'signature.finalize')`, `'contract.terms.verify'`, `'invoice.manage'`, `'integration.ingest'`, `'award.decide'`, `'project.publish.approve'`, `'supplier.activate'`, `'tenant.export.approve'` true; `can(['DEPARTMENT_USER'], 'project.manage')`, `'bid.score'`, `'contract.manage'`, `'assessment.manage'`, `'incident.report'` true; `can(['ADMIN'], 'tenant.export.request')`, `'ai.policy.manage'`, `'holiday.manage'`, `'audit.read'`, `'project.read'`, `'contract.read'`, `'invoice.read'` true.

- [ ] **Step 2: Run** `npm test -w @sp/domain -- roles` → FAIL (`normalizeRoles` tanımsız).

- [ ] **Step 3: Implement** — İzin tablosunu v2 rolleriyle yeniden yaz: her izin için yeni liste = eski listedeki rollerin `LEGACY_ROLE_MAP` görüntüsü, şu düzeltmelerle: `REMOVED_PERMISSIONS` boş liste; AUDITOR yalnız okuma izinlerinde; ADMIN'e `project.read`, `contract.read`, `invoice.read`, `document.read`, `supplier.read`, `assessment.read`, `incident.read`, `report.read` eklenir ("her şeyi görür"); `tenant.export.approve` → `['PROCUREMENT']` (K-03). Dosya başına eşleme tablosunu ve D93/D95 notunu yaz.

- [ ] **Step 4: Run** `npm test -w @sp/domain` → tümü PASS (eski domain testleri dahil; `approvalPolicy.test.ts` eski rol adlarıyla kalırsa `normalizeRoles` üzerinden geçmeli — kırılırsa yalnız rol kodlarını v2'ye çevir ve dosyaya neden notu yaz).

- [ ] **Step 5: Commit** (kullanıcı onayıyla) `v2 Faz 1: beş rol ve izin tablosu (D93)`.

### Task 2: Departmanlar, departman kapsamı ve RLS (migration 030 + API bağlamı)

**Files:**
- Create: `apps/api/migrations/030_v2_departments.sql`
- Modify: `apps/api/src/db.ts` (`TenantContext`, `withTenant`), `apps/api/src/auth.ts` (`Membership`, `identityFor`, `tenantContext`)
- Test: `apps/api/test/departments.test.ts` (yeni)

**Interfaces:**
- Consumes: Task 1 `normalizeRoles`, `SEES_ALL_DEPARTMENTS`.
- Produces: `TenantContext.departmentIds: string[]`, `TenantContext.allDepartments: boolean`, `TenantContext.roles` artık v2 rolleri; SQL `app_department_ok(dep uuid) RETURNS boolean`; tablo `departments(id, tenant_id, name, created_at, UNIQUE(tenant_id,name))`; `memberships.department_ids uuid[] NOT NULL DEFAULT '{}'`; `auth_memberships` ek sütun `department_ids`.

- [ ] **Step 1: Write the failing tests** — `departments.test.ts` (gerçek PostgreSQL, mevcut `harness.ts` ile):
  - `dept_user_sees_only_own_department`: BT departmanlı DEPARTMENT_USER, İK projesini `GET /projects/:id` ile 404 alır; listede görmez.
  - `child_tables_follow_parent`: aynı kullanıcı İK projesinin teklif, değerlendirme, kazanan ve sözleşme sürümü uçlarında 404/boş liste alır; SQL düzeyinde `SELECT count(*) FROM bids WHERE project_id = <İK>` → 0.
  - `null_department_hidden_from_dept_user`: `department_id IS NULL` proje DEPARTMENT_USER'a görünmez, PROCUREMENT, ADMIN ve AUDITOR'a görünür.
  - `supplier_portal_unaffected`: departmansız tedarikçi kullanıcısı davet edildiği turu ve kendi teklifini portal uçlarından okumaya devam eder.
  - `write_check`: DEPARTMENT_USER başka departmana proje oluşturamaz (RLS WITH CHECK → 403/409, kayıt yok).
  - `legacy_roles_normalized`: `memberships.roles = {BUYER,LEGAL}` olan kullanıcı için `/me` → `roles: ['PROCUREMENT']`.

- [ ] **Step 2: Run** `npm test -w @sp/api -- departments` → FAIL.

- [ ] **Step 3: Migration 030** — sırayla:
  1. `departments` tablosu; RLS `tenant_id = app_tenant_id()`; `GRANT SELECT, INSERT, UPDATE ON departments TO sp_app` (silme yok).
  2. `memberships.department_ids`; `auth_memberships` dönüşüne eklenir (fonksiyon `CREATE OR REPLACE`, imza değişeceği için önce `DROP FUNCTION`).
  3. `memberships.roles` eski kodlarını v2'ye çeviren `UPDATE` (Task 1 eşlemesiyle aynı, `array(SELECT DISTINCT …)`); ikinci çalıştırmada değişiklik yapmaz.
  4. `department_id uuid NULL REFERENCES departments(id)` sütunu: `projects`, `contract_families`, `invoices`, `supplier_assessments`.
  5. `app_department_ok(dep uuid)`: `current_setting('app.department_scope', true) = 'ALL' OR coalesce(current_setting('app.supplier_id', true),'') <> '' OR dep = ANY(coalesce(nullif(current_setting('app.department_ids', true),''),'{}')::uuid[])`.
  6. RESTRICTIVE politika `dept` (FOR ALL, USING + WITH CHECK `app_department_ok(department_id)`): `projects`, `contract_families`, `invoices`, `supplier_assessments`.
  7. RESTRICTIVE politika `dept` (`EXISTS (SELECT 1 FROM <parent> p WHERE p.id = <fk>)`): `project_lines`, `evaluation_criteria`, `rfq_rounds`, `rfq_invitations`, `bids`, `bid_lines`, `bid_costs`, `rfq_questions`, `bid_scores`, `project_fx_rates`, `evaluations`, `awards`, `award_lines` → `projects`; `contract_versions`, `contract_parties` ve imza tabloları → `contract_families` (fk sütununu migration yazarken her tabloda `\d` ile doğrula); `invoice_lines`, `invoice_allocations` → `invoices`; `assessment_answers` → `supplier_assessments`.
- [ ] **Step 4: Bağlam** — `tenantContext`: `roles = normalizeRoles(membership.roles)`, `allDepartments = roles.some(r => SEES_ALL_DEPARTMENTS.includes(r))`, `departmentIds = membership.departmentIds`. `withTenant`: `set_config('app.department_scope', allDepartments ? 'ALL' : 'LIST', true)` ve `app.department_ids`.
- [ ] **Step 5: Run** `npm test -w @sp/api` → departments PASS; kırılan eski testler Task 4'te ele alınır, listesini not et.
- [ ] **Step 6: Commit** (onayla) `v2 Faz 1: departman tablosu ve RLS kapsamı (030)`.

### Task 3: Departman alanı API'de (oluşturma, liste, süzgeç) ve departman uçları

**Files:**
- Modify: `apps/api/src/modules/sourcing.ts` (proje oluşturma/liste), `apps/api/src/modules/contracts.ts` (aile oluşturma/liste), `apps/api/src/modules/invoices.ts` (liste, detay), `apps/api/src/modules/supplierEval.ts` (değerlendirme oluşturma), `apps/api/src/server.ts`
- Create: `apps/api/src/modules/departments.ts`
- Test: `apps/api/test/departments.test.ts` (genişlet)

**Interfaces:**
- Produces: `GET /api/v1/departments` → `{ items: {id,name}[] }` (iç roller); `POST /api/v1/departments` (ADMIN) `{name}`; `PUT /api/v1/memberships/:userId/departments` (ADMIN) `{departmentIds: string[]}`; proje/sözleşme/değerlendirme oluşturmada `departmentId` (DEPARTMENT_USER için zorunlu ve kendi departmanlarından biri; diğerleri için zorunlu); liste ve detay yanıtlarında `departmentId`, `departmentName`; liste uçlarında `?departmentId=` süzgeci; `/me` yanıtında `departments: {id,name}[]`.
- Fatura departmanı eşleşen sözleşmeden devralınır (analiz 2.3): tahsis kaydedilince `invoices.department_id = contract_families.department_id`.

- [ ] **Step 1: Failing tests** — `create_requires_department` (departmansız proje oluşturma 422 `department_required`), `dept_user_cannot_pick_foreign_department` (403), `list_filter_by_department`, `invoice_inherits_department_from_contract`, `admin_assigns_membership_departments` (ADMIN olmayan 403), `me_returns_departments`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** uçları ve alanları; denetim izine `department.created`, `membership.departments.set`.
- [ ] **Step 4: Run** `npm test -w @sp/api -- departments` → PASS.
- [ ] **Step 5: OpenAPI** `npm run openapi -w @sp/api`; commit (onayla).

### Task 4: Kaldırılan işlevlerin API testleri ve sentetik veri

**Files:**
- Modify: `apps/api/src/devdata.ts`, `apps/api/src/seed.ts`, `apps/api/src/seedSourcing.ts` (v2 rolleri, üç departman: Bilgi Teknolojileri, İnsan Kaynakları, Tıbbi Cihaz; kullanıcılar ve demo kayıtlar departmanlı)
- Modify: kaldırılan işlevi sınayan testler: `invoices.test.ts`, `invoiceIntake.test.ts` (onay bölümleri), `recovery.test.ts`, `tcmb.test.ts`, `governance.test.ts` (saklama/imha bölümleri), `approvals.test.ts` (politika yönetimi), `integration.test.ts` (yalnız replay yetkisi değişirse)
- Create: `apps/api/test/removed-v1.test.ts`

**Interfaces:**
- Consumes: Task 1 `REMOVED_PERMISSIONS`.

- [ ] **Step 1: removed-v1 testi** — her kaldırılan uç (`POST /invoices/:id/approve`, `/invoices/:id/exceptions/*`, `/tolerance-rules*`, `/purchase-orders*`, `/receipts*`, `/recovery*`, `/fx-rates/tcmb`, `/retention*`, `/legal-holds*`, `/disposal*`, `/approval-policies*` yazma uçları, banka değişikliği kararı) PROCUREMENT, ADMIN ve AUDITOR ile 403 `forbidden` döner; tablolardaki satır sayısı test öncesi ve sonrası aynı.
- [ ] **Step 2: Eski testler** — kaldırılan işlevi pozitif sınayan `it` blokları silinmez, `it.skip` + `// v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; davranış removed-v1.test.ts ile 403 olarak korunur` olur. Kalan işlevleri sınayan bloklarda yalnız rol kodları v2'ye çevrilir (eski kodlar `normalizeRoles` ile çalışıyorsa hiç değiştirilmez). Görev ayrılığı testleri iki ayrı PROCUREMENT kullanıcısıyla geçmeli.
- [ ] **Step 3: Demo faturalar** — `ANB2026000101`, `ANB2026000102`, `EGE2026000877` için durum değiştiren hiçbir tohum/test adımı yok (grep ile doğrula).
- [ ] **Step 4: Run** `npm test -w @sp/api` → PASS; atlanan test sayısını ve listesini `docs/implementation-status.md`'ye yaz.
- [ ] **Step 5: Commit** (onayla).

### Task 5: Web kabuğu — 7 girişli menü, Yönetim merkezi, taşınan girişler

**Files:**
- Modify: `apps/web/src/App.tsx`, `apps/web/src/lib/labels.ts` (`roleLabel` v2), `apps/web/src/pages/NotYetPage.tsx` (kaldırılan sayfa metni)
- Create: `apps/web/src/pages/AdminPages.tsx` (Yönetim sekmeleri kabuğu; Kullanıcılar ve Entra sekmesinde Faz 1 için departman ataması; Onaycılar, Şablonlar, Satınalma kuralları "Faz 2/3/7" boş durumlu), `apps/web/src/pages/AuditPage.tsx` (`GET /audit-events` listesi + kiracı dışa aktarımı paneli, mevcut `GovernancePages` dışa aktarım bileşeni yeniden kullanılır)
- Test: `apps/web/e2e/navigation-v2.spec.ts` (yeni)

**Interfaces:**
- Rota eşlemesi: `/yonetim` → `/yonetim/kullanicilar`; `/yonetim/yapay-zeka` (mevcut `AiPage`), `/yonetim/entegrasyonlar` (mevcut `ErpReconciliationPage`), `/yonetim/denetim-izi` (yeni `AuditPage`); `/tedarikciler/olaylar`, `/tedarikciler/anketler`, `/tedarikciler/performans-agirliklari` (mevcut sayfalar, Tedarikçiler sayfasında alt çizgili sekme olarak); `/sozlesmeler/ekle` ve `/faturalar/yukle` mevcut `IntakePage`'i türü sabitlenmiş açar.
- Eski adresler kalıcı yönlendirme: `/yapay-zeka`, `/faturalar/erp-mutabakati`, `/olaylar`, `/olaylar/:id`, `/anketler`, `/performans-agirliklari`, `/belge-girisi` → yeni yerleri. Kaldırılan adresler (`/lira-defteri*`, `/siparisler*`, `/faturalar/tolerans`, `/projeler/onay-politikasi`, `/veri-yonetimi*`) → `NotYetPage` "Bu işlev v2 sadeleştirmesinde kaldırıldı; kayıtlar silinmedi" + İşlerim bağlantısı.

- [ ] **Step 1: Failing e2e** — her v2 rolü için menü tam olarak beklenen girişleri gösterir (ADMIN: 7; PROCUREMENT: 7; DEPARTMENT_USER: Yönetim hariç 6; AUDITOR: 7, Yönetim'de yalnız okunur sekmeler); eski adreslerin her biri yeni yerine yönlenir; kaldırılan adresler açıklama ekranını gösterir; kullanıcı rolü ham kodla görünmez.
- [ ] **Step 2: Run** `npm run e2e -w @sp/web -- navigation-v2` → FAIL.
- [ ] **Step 3: Implement**; dar ekran (390) yatay menü davranışı aynı kalır.
- [ ] **Step 4: Run** e2e + `npm run typecheck` → PASS. Commit (onayla).

### Task 6: Web sayfaları — kaldırılan denetimler ve departman alanı

**Files:**
- Modify: `PurchasingPages.tsx` (fatura onayı, istisna onayı, tolerans bağlantısı, sipariş bağlantıları ve sipariş tahsis seçenekleri kalkar; tahsis yalnız sözleşmeye; "Fatura gir" ve XML yükleme kalır), `ProjectsPage.tsx` (onay politikası düğmesi kalkar), `ProjectWizard.tsx` (departman alanı zorunlu), `ProjectWorkspace.tsx`, `ContractsPage.tsx`, `SuppliersPage.tsx` / `SupplierDetailPage.tsx` / `IntakePage.tsx` / `DocumentPage.tsx` (banka değişikliği karar arayüzü kalkar, uyarı metni kalır), `SearchPage.tsx` (sipariş sonuç grubu kalkar), `WorkPage.tsx` (`recovery_case`, `disposal_batch` hedefleri ve fatura onay görevleri listelenmez), `EvaluationPages.tsx` (olay detayındaki sipariş bağlantısı metne döner)
- Test: mevcut `purchasing.spec.ts`, `ledger.spec.ts`, `governance.spec.ts`, `projects.spec.ts`, `a11y.spec.ts`

- [ ] **Step 1:** Envanterin 6. bölümündeki her "dışarıdan gelen bağlantı" için e2e iddiası: bağlantı yok ve ölü bağlantı kalmadı.
- [ ] **Step 2:** Proje, sözleşme ve fatura listelerine "Departman" sütunu ve süzgeç çipi; sihirbaz ve sözleşme eklemede departman seçimi (DEPARTMENT_USER için yalnız kendi departmanları).
- [ ] **Step 3:** Kaldırılan işlevi pozitif sınayan e2e testleri `test.skip` + Task 4'teki neden notu; `ledger.spec.ts` ve veri yönetimi senaryoları bütünüyle atlanır, yerine Task 5 yönlendirme testi.
- [ ] **Step 4: Run** `npm run e2e -w @sp/web` (1440/1280/390) ve axe → PASS. Commit (onayla).

### Task 7: iOS

**Files:**
- Modify: `ios/Satinalma/Satinalma/Features/RootViews.swift` (sekmeler: İşlerim, Sözleşmeler, Tara, Tedarikçiler, Faturalar; "Daha fazla" içeriği — kullanıcı, kiracı seçimi, şirket kapsamı, bağlantı, bekleyen taslak, çıkış — İşlerim araç çubuğundaki profil düğmesinden açılır), `RecordsView.swift` (siparişler ve mal kabulü kalkar; olay listesi, bildirme, faaliyet tamamlama Tedarikçiler sekmesine taşınır), `InvoiceView.swift` (onay/ret kalkar, salt okunur; eşleşen sözleşme gösterilir), `SignatureView.swift` (Sözleşmeler sekmesinden erişilir), `Core/Models.swift` (`Labels.role` v2, `departments`), DEBUG kullanıcı listesi v2 rolleri
- Test: simülatör elle akış + ekran görüntüsü (XCUITest yok, mevcut durumla aynı)

- [ ] **Step 1:** Derleme `xcodebuild … -destination 'platform=iOS Simulator,name=iPhone 18 Pro' build` → uyarısız PASS.
- [ ] **Step 2:** Simülatörde her v2 rolüyle: beş sekme; profilden çıkış ve kiracı değiştirme; tarama → şifreli taslak → yükleme; olay bildirme; fatura salt okunur; imza kararı (PROCUREMENT). Önce/sonra işlev listesini envanterin 4. bölümüne işaretle.
- [ ] **Step 3:** Commit (onayla).

### Task 8: Doğrulama ve kapanış

- [ ] `npm test -w @sp/domain`, `npm test -w @sp/api`, `npm run typecheck`, `npm run e2e -w @sp/web` → hepsi PASS; sayılar `docs/implementation-status.md` v2 Faz 1 satırına.
- [ ] `docs/envanter-faz1.md` her satırın doğrulama kutusu tek tek işaretlenir; işaretlenemeyen satır varsa faz bitmemiştir.
- [ ] `persona-testci`: web (ADMIN, PROCUREMENT ×2 görev ayrılığı, BT ve İK departman kullanıcıları, AUDITOR, tedarikçi) ve iOS (PROCUREMENT, DEPARTMENT_USER). Rapor kanıt sayılmaz; bulgular elle doğrulanır.
- [ ] Commit öncesi `code-review` skill'i veya `surgeon-reviewer`; bulgular düzeltilir.
- [ ] `docs/decisions.md` (Faz 1 kararları: D96…), `docs/implementation-status.md`, `docs/devir-v2.md` güncellenir.
