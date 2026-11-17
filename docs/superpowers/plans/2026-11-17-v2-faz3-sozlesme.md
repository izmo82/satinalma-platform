# v2 Faz 3 — Sözleşme: ekleme akışı, zorunlu alanlar, şablon kütüphanesi, üç onay, hatırlatıcılar — Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Departman kullanıcısı ve Satınalma, bir sözleşmeyi 4 adımda (Yükle → Oku → Tamamla ve doğrula → İncele ve gönder) projeye ve tedarikçi kartına bağlı olarak ekler. Sözleşme sırayla üç onaydan geçer (departman sorumlusu → satınalma sorumlusu → satınalma direktörü). Onaylanan sözleşme için bitişe 90/60/30/7 gün kala hatırlatıcılar kurulur. Kurumun .docx taslakları sürümlü bir kütüphanede tutulur. Web ve iOS birlikte.

**Architecture:** v2 sözleşmesi mevcut `contract_families` + güncel `contract_versions` + en son `contract_terms` üçlüsüdür; yeni alanlar aileye eklenir, var olan imza/koşul/yükümlülük/ticari altyapı aynen kalır. Durum saklanmaz, onay satırlarından ve alanlardan türetilir (proje kuralı: "durum türetilir"). Onay zinciri gönderim anında Faz 2 `currentApprovers` ile kişilere çözülür ve `contract_approvals` satırlarına sabitlenir; her adım bir görevdir. Hatırlatıcılar mevcut iş kuyruğuyla (`jobs`) zamanlanır. Yapay zekâ (alan okuma, şablon karşılaştırma, hukuk incelemesi) Faz 4'tür: bu fazda "Oku" adımı ve "İnceleme" sekmesi dürüst boş durum gösterir, alanlar elle girilir.

**Tech Stack:** Fastify 5, PostgreSQL 17 RLS, Vitest, React 19 + Vite + Tailwind/shadcn, Playwright, SwiftUI.

**Spec:** `docs/analiz-v2.md` §2.2 (onaycılar), §2.3 (departman görünürlüğü — "Onaycı, kendisine gelen kaydı departmanı farklı olsa da görür"), §3.1 (proje → sözleşme), §3.2 (sözleşme yönetimi); Figma web `4:999` 07 liste, `4:1253` 08 Oku/tamamla, `5:141` 09 İncele ve gönder, `5:371` 10 Detay İnceleme, `5:657` 11 Detay Özet, `5:934` 12 Taslaklar; iOS `4:2032` İşlerim, `4:2125` Tarama, `4:2175` Doğrulama, `4:2264` Sözleşme onayı (onaylı D94). Kararlar D93–D107 (özellikle D95 görev ayrılığı, D97, D105 R2/R5, D107 onaycı rolleri).

## Global Constraints

- Sıfır gerileme: mevcut sözleşme işlevlerinin hepsi kalır — liste imza süzgeci ve "daha fazla", sözleşme detayındaki İmza (SignatureWorkspace), Koşullar (kaydet/doğrula/ihbar), Yükümlülükler, Ticari sekmeleri, `/sozlesmeler/ekle` belge yüklemesi (yeni sihirbaz içinde aynı yükleme), iOS Sözleşmeler listesi → imza incelemesi, Tara. Yeni sekmeler eklenir, eskiler kaldırılmaz; taşınan girişin dokunuş sayısı artmaz.
- Eski sözleşmeler (proje/tür/sorumlu alanı boş) silinmez, görünür ve açılır; durumları "Eksik alan" olarak türetilir; zorunlu alanlar doldurulunca onaya gönderilebilir.
- Kiracı bağlamı yalnız `withTenant`; `sp_app`; her yeni tablo `tenant_id` + RLS (`tenant_id = app_tenant_id()`, şirket/departman kuralları mevcut desenle) + en dar GRANT. Uygulanmış migration düzenlenmez; ilk yeni dosya `048_`.
- Para decimal string; tutar, para birimi, tarihler ve VKN her durumda insan tarafından kaydedilir; LLM bu fazda hiç çağrılmaz (Faz 4).
- Yapay zekâ çıktısı yoksa ekran "Yapay zekâ okuması bağlı değil (Faz 4); alanları belgeden siz girin" gibi açık bir durum gösterir; sahte puan, sahte güven yüzdesi ya da örnek bulgu gösterilmez. "Yapay zekâ ön incelemesidir, hukuki görüş değildir." etiketi yalnız gerçek bir inceleme gösterildiğinde (Faz 4) kullanılır.
- E-posta: bu fazda `email_outbox` satırı yazılır; gerçek gönderim kanalı (Graph) bağlı değilse satır "gönderilmedi — e-posta kanalı yapılandırılmadı" durumunda kalır ve ekranda öyle görünür. Gönderilmiş gibi gösterilmez.
- Görev ayrılığı: kişi kendi eklediği sözleşmeyi onaylayamaz (vekile düşer); D95/D97 kuralları (koşul doğrulama, imza kesinleştirme) aynen sürer.
- Onaycı yalnız etkin, Satınalma ya da Departman kullanıcısı rolündeki kişidir (D107); sorumlusu atanmamış departmanın sözleşmesi onaya gönderilemez (Figma 21 dipnotu).
- Ekran metni Türkçe; tarih/sayı tr-TR; testlerdeki veri sentetik; demo faturalar ANB2026000101, ANB2026000102, EGE2026000877'e dokunulmaz.
- Değiştirilen eski test dosyalarının başına `// v2 Faz 3 (D108+): <neden>`.
- Commit görev başına, yerel; push yok.

## Rulings (plan yazarı; kullanıcı aksini söylerse değişir)

- R1 Durumlar (türetilir): `INCOMPLETE` "Eksik alan" (zorunlu alan eksik) → `DRAFT` "Taslak" (alanlar tam, gönderilmedi) → `IN_APPROVAL` "<Unvan> onayında" (açık zincir; sıradaki adımın unvanı) → `REJECTED` "Reddedildi" (son zincir red; ekleyene döner) → `APPROVED` "Onaylandı" / "Yürürlükte" (zincir tamam; bitiş geçmemiş ya da süresiz) → `EXPIRED` "Süresi doldu". Eski kayıt (Faz 3 öncesi, zinciri yok, alanları tam) `LEGACY` "Onay kaydı yok (eski kayıt)" olarak görünür ve "Yürürlükte" süzgecinde sayılır.
- R2 Zorunlu alanlar ve yeri: aileye `project_id`, `contract_type` (SERVICE/HARDWARE/MAINTENANCE/NDA/CONSULTING/OTHER), `owner_user_id` (sözleşme sorumlusu), `signed_on`, `template_version_id` (isteğe bağlı), `indefinite` (süresiz) eklenir; tutar, para birimi, KDV dahil/hariç (`limit_basis` GROSS/NET), başlangıç, bitiş, otomatik yenileme, ihbar süresi mevcut `contract_terms` revizyonunda kalır. Süresizse bitiş boş ve ihbar süresi zorunlu. İsteğe bağlı alanlar (sözleşme no, ödeme vadesi, teminat, SLA/ceza, KVKK maddesi, yetkili mahkeme, fiyat artış koşulu) koşul revizyonunda/aile alanlarında; teminat ve SLA mevcut ticari kayıtlarıyla.
- R3 Koşul revizyonu ekleme akışında ekleyenin adıyla yazılır; mevcut ikinci kişi doğrulaması (D95a) ayrı ve aynen kalır (ihbar hatırlatıcısı doğrulamaya bağlı kalır). Onay zinciri doğrulamanın yerine geçmez.
- R4 Onay zinciri gönderimde sabitlenir: [departman sorumlusu (ya da ekleyen seçerse vekili), satınalma sorumlusu, satınalma direktörü] + ekleyenin eklediği ek onaycılar (zincirin sonuna, sırayla; D107 rolleri). Adımdaki kişi ekleyen ise o adım vekile gider; vekil yoksa ya da vekil de ekleyense gönderim 409 `no_eligible_approver`. Adımda karar yetkisi: adıma sabitlenen kişi ya da o anki etkin vekili (Faz 2 askıya alma/devir ile uyumlu). Aynı kişi birden çok adımda olabilir; her adım ayrı karar ister.
- R5 Red gerekçelidir (≥10 karakter); zincir kapanır, sözleşme `REJECTED`, ekleyene görev. Ekleyen düzenler ve yeniden gönderir → yeni zincir (eski satırlar tarih olarak kalır). Gönderimden sonra belge (yeni sürüm) ya da zorunlu alan/koşul değişirse açık zincir iptal edilir ("içerik değişti, onay baştan") ve ekleyene yeniden gönder görevi açılır.
- R6 Görünürlük: onaycı, kendisine sabitlenmiş (ya da vekili olduğu) adım içeren sözleşmeyi departmanı farklı olsa da görür (aile, sürüm, koşullar ve belge salt okunur). RLS'de departman koşuluna `OR app_is_contract_approver(family_id)` (SECURITY DEFINER, yalnız bool döner, `search_path = public, pg_temp`).
- R7 Hatırlatıcılar onay tamamlandığında (ya da eski kayıtta koşullar doğrulandığında) kurulur: bitişten 90/60/30/7 gün önce; otomatik yenilemeli sözleşmede ayrıca ihbar son gününden 30 gün önce (mevcut ihbar hatırlatıcısı korunur, tekrar açılmaz). Alıcılar: sözleşme sorumlusu + departman sorumlusu; 30 ve 7 günde Satınalma rol kuyruğu da. Kanallar: görev (İşlerim) + `email_outbox`. Hatırlatıcı karar girilene kadar açık kalır; karar seçenekleri mevcut RENEW/TERMINATE/RENEGOTIATE + yeni `NEW_PROJECT` "Yeni proje açıldı". Süreler kiracı ayarıdır (Yönetici; varsayılan 90,60,30,7); değişiklik yalnız sonraki zamanlamaları etkiler.
- R8 Şablon kütüphanesi: `contract_templates` (kod, ad, tür) + `contract_template_versions` (sürüm no, .docx belge, geçerlilik tarihi, `superseded_at`); yeni sürüm öncekini "geçersiz" yapar, silinmez. Yükleme ve yeni sürüm: Yönetici ve Satınalma; indirme: bütün iç roller. .docx doğrulaması: ZIP imzası + `word/document.xml` varlığı + boyut sınırı (mevcut yükleme sınırı). "Yeni sözleşmede kullan" sihirbazı o tür ve sürümle açar; kullanım sayısı türetilir.
- R9 Aday tedarikçi kartı: okunan firma kayıtlı değilse ekleyen en az unvan + VKN (+ iletişim e-postası) ile `CANDIDATE` durumunda kart açar (VKN biçim/denetim basamağı doğrulanır, aynı VKN varsa o kart önerilir); Satınalma sonradan tamamlar. Mevcut tedarikçi onay/aktivasyon akışı aynen kalır.
- R10 Proje bağı: proje zorunlu; projenin departmanı sözleşmenin varsayılan departmanıdır (kullanıcı değiştirebilir, Departman kullanıcısı yalnız kendi departmanları). Proje detayına "Sözleşmeler" sekmesi eklenir (analiz §3.1).

## Review Focus

1. Ekleyen aynı zamanda departman sorumlusu ve satınalma sorumlusuysa: her iki adım da vekile gitmeli; vekil yoksa gönderim anlaşılır biçimde reddedilmeli, sözleşme kendi kendine onaylanamamalı.
2. Zincir ortasında onaycı Entra'dan askıya alınırsa (Faz 2 R5) görev vekile geçer; vekil karar verebilmeli, askıdaki kişinin eski görevi karar veremez olmalı.
3. Kısmen onaylanmış sözleşmeye yeni belge sürümü ya da tutar değişikliği gelirse onaylar düşmeli; eski onay yeni içerik için sayılmamalı.
4. Başka departmandaki onaycı sözleşmeyi görebilmeli ama departmanın diğer sözleşmelerini görmemeli; onay bittikten sonra da kendi onayladığı kaydı görebilmeli.
5. Eski (Faz 3 öncesi) sözleşmeler listede, detayda, imza/koşul/yükümlülük sekmelerinde aynen çalışmalı; "Eksik alan" olarak görünmeli ama erişilemez olmamalı.

---

### Task 1: Alan kuralları (domain)

**Files:** Create `packages/domain/src/contractV2.ts`, `packages/domain/test/contractV2.test.ts`; Modify `packages/domain/src/index.ts`, `packages/domain/src/roles.ts`.

**Interfaces — Produces:**
- `CONTRACT_TYPES = ['SERVICE','HARDWARE','MAINTENANCE','NDA','CONSULTING','OTHER'] as const`, `CONTRACT_TYPE_TR` (Hizmet, Donanım, Bakım-destek, Gizlilik, Danışmanlık, Diğer).
- `missingRequired(c: ContractFields): RequiredField[]` — R2 listesi; süresizde bitiş yerine ihbar süresi; Türkçe etiketler `REQUIRED_FIELD_TR`.
- `contractStatus(input: { missing: RequiredField[]; chains: ChainSummary[]; legacy: boolean; endDate: string|null; indefinite: boolean; today: string }): { code: ContractStatus; label: string }` — R1; `IN_APPROVAL` etiketi sıradaki adımın unvanıyla ("Departman sorumlusu onayında").
- `planChain(input: { creatorId; approvers: { head; deputy; lead; leadDeputy; director; directorDeputy } (Person|null); useDeputyForHead: boolean; extras: string[] }): { steps: { order; kind: 'DEPARTMENT_HEAD'|'PROCUREMENT_LEAD'|'PROCUREMENT_DIRECTOR'|'EXTRA'; userId; viaDeputy: boolean }[] } | { error: 'department_head_missing'|'lead_missing'|'director_missing'|'no_eligible_approver'; kind }` — R4.
- `canDecide(step, actorId, activeDeputyId): boolean`.
- `reminderDates(input: { endDate: string|null; indefinite: boolean; autoRenewal: boolean; noticeDeadline: string|null; offsets: number[] }): { offset: number; date: string; kind: 'END'|'NOTICE'; includeProcurement: boolean }[]` — R7 (geçmiş tarih: yalnız en yakın gelecek olmayan tek hatırlatıcı hemen).
- İzinler: `contract.approve` [PROCUREMENT, DEPARTMENT_USER] (karar ucu; kişi kontrolü kodda), `template.read` [ADMIN, PROCUREMENT, DEPARTMENT_USER, AUDITOR], `template.manage` [ADMIN, PROCUREMENT], `reminder.settings` [ADMIN], `supplier.candidate.create` [PROCUREMENT, DEPARTMENT_USER].

- [ ] **Step 1: Testler** — `missingRequired`: tam kayıt → `[]`; süresiz + ihbar yok → `['noticePeriod']`; proje yok → `['project']`. `contractStatus`: her R1 durumu ve eski kayıt; IN_APPROVAL etiketi "Satınalma sorumlusu onayında". `planChain`: normal üç adım; ekleyen = sorumlu → vekil (`viaDeputy:true`); ekleyen = sorumlu ve vekil yok → `no_eligible_approver`; sorumlu atanmamış → `department_head_missing`; ek onaycı sona; ekleyen ek onaycı olarak eklenemez. `reminderDates`: bitiş 2028-12-31 → 2028-10-02, 11-01, 12-01, 12-24 (Figma 11 örneği), 30 ve 7'de `includeProcurement`; otomatik yenilemede ihbar-30 eklenir; süresizde yalnız ihbar; özel offsetler.
- [ ] **Step 2–4:** RED → yaz → GREEN (`npm test -w @sp/domain`, `npm run typecheck`). **Step 5: Commit.**

### Task 2: Şema (048) — alanlar, onay, şablon, hatırlatıcı, e-posta kuyruğu, onaycı görünürlüğü

**Files:** Create `apps/api/migrations/048_v2_contracts.sql`, `apps/api/test/contractSchema.test.ts`.

**Interfaces — Produces:**
- `contract_families` + `project_id` (FK tenant-composite projects), `contract_type`, `owner_user_id`, `signed_on date`, `template_version_id`, `indefinite bool DEFAULT false`, `contract_no text`, `governing_court text`, `kvkk_clause bool`, `price_escalation text`; GRANT UPDATE yalnız bu sütunlara.
- `contract_template(s)`: `contract_templates(id, tenant_id, code, name, contract_type, created_by, created_at, UNIQUE(tenant_id, code))`, `contract_template_versions(id, tenant_id, template_id, version_no, document_version_id, valid_from, superseded_at, uploaded_by, created_at, UNIQUE(template_id, version_no))`; `documents.kind` CHECK'ine `TEMPLATE` eklenir (mevcut CHECK'i genişlet).
- `contract_approval_chains(id, tenant_id, family_id, version_id, terms_id, submitted_by, submitted_at, note, closed_at, outcome CHECK IN ('APPROVED','REJECTED','CANCELLED'), cancel_reason)` ve `contract_approval_steps(id, tenant_id, chain_id, step_order, kind, assigned_user_id, via_deputy, decided_by, decided_at, decision CHECK IN ('APPROVED','REJECTED'), reason)` — karar sütunları yalnız bir kez yazılır (tetikleyici), satır silinmez.
- `contract_reminders(id, tenant_id, family_id, terms_id, kind END/NOTICE, offset_days, due_on, task_ids uuid[], created_at)` ve `tenant_settings`'e (yoksa yeni tablo `contract_reminder_settings(tenant_id PK, offsets int[] NOT NULL DEFAULT '{90,60,30,7}', updated_by, updated_at)`).
- `renewal_decisions.decision` CHECK'ine `NEW_PROJECT`.
- `email_outbox(id, tenant_id, to_user_id, to_email, subject, body_text, related_type, related_id, status CHECK IN ('QUEUED','NOT_CONFIGURED','SENT','FAILED'), created_at, sent_at, error)`; uygulama yalnız INSERT ve SELECT; durum güncellemesi yalnız gönderici sütunlarına.
- `app_is_contract_approver(family uuid) RETURNS boolean` SECURITY DEFINER (`search_path = public, pg_temp`, REVOKE PUBLIC, GRANT sp_app): çağıranın (`app.user_id`) bu ailenin herhangi bir zincirinde atanmış kişi ya da şu an etkin vekil olduğu adım varsa true. `contract_families`, `contract_versions`, `contract_terms`, `documents`/`document_versions` (sözleşme belgesi) RESTRICTIVE departman politikalarına `OR app_is_contract_approver(...)` eklenir (R6). Şirket kapsamı kuralı değişmez.

- [ ] **Step 1: Testler** — her yeni tabloda RLS (başka kiracı göremez); onay kararı ikinci kez yazılamaz; BT departman kullanıcısı İK sözleşmesini göremez, aynı sözleşmede onay adımına atanınca görür, İK'nın başka sözleşmesini yine göremez (Review Focus 4); `NEW_PROJECT` kararı yazılabilir; `TEMPLATE` belge türü kabul.
- [ ] **Step 2–4.** `npm run migrate -w @sp/api`, `npm test -w @sp/api` (eski testler değişmeden). **Step 5: Commit.**

### Task 3: Şablon kütüphanesi API'si

**Files:** Create `apps/api/src/modules/templates.ts`, `apps/api/test/templates.test.ts`; Modify `apps/api/src/server.ts`.

**Interfaces — Produces:** `GET /api/v1/contract-templates` (`template.read`; güncel sürüm, sürüm geçmişi, kullanım sayısı), `POST /api/v1/contract-templates` (multipart: .docx + code, name, contractType, validFrom; `template.manage`; aynı kod varsa 409 `template_exists` — yeni sürüm ayrı uç), `POST /api/v1/contract-templates/:id/versions` (multipart .docx, validFrom), `GET /api/v1/contract-template-versions/:id/download` (`template.read`; `Content-Disposition` dosya adı). Denetim: `template.created`, `template.version_added`.

- [ ] **Step 1: Testler** — docx kabul, ZIP olmayan / `word/document.xml` olmayan dosya 422 `invalid_docx`; yeni sürüm öncekini `superseded_at` ile kapatır, eski sürüm indirilebilir; Departman kullanıcısı indirir ama yükleyemez (403); kullanım sayısı sözleşme ekleyince artar (Task 4 sonrası testte); başka kiracı 404.
- [ ] **Step 2–5.**

### Task 4: Ekleme akışı API'si — taslak, alanlar, aday tedarikçi, gönderim

**Files:** Create `apps/api/src/modules/contractIntake.ts`, `apps/api/test/contractIntake.test.ts`; Modify `apps/api/src/server.ts`, `apps/api/src/modules/contracts.ts` (createContract'ı yeniden kullan), `apps/api/src/modules/suppliers.ts`.

**Interfaces — Produces:**
- `POST /api/v1/contract-drafts` (`contract.manage`) `{ documentVersionId, projectId, templateVersionId? }` → aile + MAIN sürüm (stage DRAFT) oluşturur; aynı belge (sha256) başka sözleşmede varsa yanıtta `duplicateOf` uyarısı (engellemez).
- `PUT /api/v1/contracts/:familyId/fields` (`contract.manage`; yalnız ekleyen ya da Satınalma; açık zincir varsa R5 iptal) — R2 alanları; koşul alanları yeni `contract_terms` revizyonu olarak (`saveTerms` yeniden kullanılır; değişiklik gerekçesi akış içinde otomatik "Sözleşme ekleme akışı").
- `GET /api/v1/contracts/:familyId/v2` → `{ fields, missing, status, chain, reminders, template, project, supplier, document, can: { edit, submit, decide } }`.
- `POST /api/v1/suppliers/candidates` (`supplier.candidate.create`) `{ legalName, vkn, contactEmail? }` → R9.
- `GET /api/v1/contracts/:familyId/approval-preview` → `planChain` sonucu kişilerle (Figma 09 "Onaycılar").
- `POST /api/v1/contracts/:familyId/submit` (`contract.manage`; yalnız ekleyen ya da Satınalma) `{ useDeputyForHead?, extraApproverIds?, note? }` → eksik alan 422 `missing_fields` (liste), zincir hatası 409, aksi halde zincir + ilk adım görevi (`contract_approval`, `assignee_user_id`).
- `GET /api/v1/contracts` yanıtına (eski alanlar aynen) `status`, `statusLabel`, `project`, `endDate`, `amount`, `currency` eklenir; süzgeç `status` (Tümü/Onayda/Yürürlükte/90 gün içinde biten/Eksik alan) — eski `signature` süzgeci kalır.

- [ ] **Step 1: Testler** — projesiz taslak 422; Departman kullanıcısı başka departman projesine sözleşme ekleyemez; aday tedarikçi açılır (VKN hatalı 422, var olan VKN → mevcut kart döner); tam alanlarla gönderim → zincir 3 adım; ekleyen = departman sorumlusu → vekil; vekil yok → 409; eksik alanda 422 listeli; aynı belge uyarısı; eski sözleşme `INCOMPLETE` görünür, alanları doldurulunca gönderilebilir; liste süzgeçleri.
- [ ] **Step 2–5.**

### Task 5: Onay kararı API'si

**Files:** Create `apps/api/src/modules/contractApprovals.ts`, `apps/api/test/contractApprovals.test.ts`; Modify `apps/api/src/server.ts`, `apps/api/src/modules/directory.ts` (askıya almada açık onay adımı görevinin vekile geçmesi — mevcut `handOffOpenTasks` ile; yeni kod gerekmiyorsa yalnız test), `apps/api/src/modules/contractTerms.ts`/`contracts.ts` (içerik değişince R5 iptal).

**Interfaces — Produces:**
- `POST /api/v1/contract-approval-steps/:id/decision` (`contract.approve`) `{ decision: 'APPROVED'|'REJECTED', reason? }` → `canDecide`; sıradaki adım görevi; son adımda zincir `APPROVED` ve Task 6 `scheduleContractReminders` çağrısı; red → zincir `REJECTED`, ekleyene `contract_rejected` görevi (gerekçe metinde). Kendi eklediği sözleşmeyi onaylamaya çalışan 403 `segregation_of_duties`.
- `GET /api/v1/contract-approvals/mine` → bekleyen adımlar (iOS İşlerim ve web İşlerim için; görev listesiyle tutarlı).
- İçerik değişimi (yeni sürüm, alan/koşul değişikliği) açık zinciri `CANCELLED` yapar, açık adım görevlerini kapatır, ekleyene "Yeniden onaya gönderin" görevi.

- [ ] **Step 1: Testler** — sıralı ilerleme ve görevler; yanlış kişi 403; vekil karar verebilir; Review Focus 1, 2, 3; red gerekçesiz 422, gerekçeli → REJECTED, yeniden gönderim yeni zincir; onaycı başka departmandan görür (R6, onaydan sonra da); denetim kayıtları.
- [ ] **Step 2–5.**

### Task 6: Hatırlatıcılar ve e-posta kuyruğu

**Files:** Create `apps/api/src/modules/contractReminders.ts`, `apps/api/test/contractReminders.test.ts`; Modify `apps/api/src/worker.ts`, `apps/api/src/modules/contractTerms.ts` (decideRenewal: `NEW_PROJECT`, hatırlatıcı kapatma), `apps/api/src/server.ts`.

**Interfaces — Produces:** `scheduleContractReminders(tx, ctx, familyId)` (R7; idempotent `reminder:{terms}:{kind}:{offset}`), iş türü `contract.end_reminder` → görevler (sorumlu, departman sorumlusu, 30/7'de Satınalma kuyruğu) + `email_outbox` (kanal yoksa `NOT_CONFIGURED`); karar girilince açık hatırlatıcı görevleri kapanır; `GET/PUT /api/v1/settings/contract-reminders` (`reminder.settings`; 1–365 arası, tekrarsız, en çok 6 değer); `GET /api/v1/contracts/:familyId/reminders` (planlanan tarihler, gönderim durumları). Eski kayıtta koşul doğrulanınca da kurulur (R7).

- [ ] **Step 1: Testler** — Figma 11 tarihleri; işçi görevi açar, e-posta satırı `NOT_CONFIGURED`; karar (her dört seçenek) görevleri kapatır, `NEW_PROJECT` kabul; ayar değişikliği yalnız sonraki zamanlamayı etkiler; mevcut ihbar hatırlatıcısı testleri değişmeden geçer.
- [ ] **Step 2–5.**

### Task 7: Web — liste, ekleme sihirbazı, detay, şablonlar, proje sekmesi, ayar

**Files:** Modify `apps/web/src/pages/ContractsPage.tsx`, `apps/web/src/pages/ContractLifecycle.tsx`, `apps/web/src/App.tsx`, `apps/web/src/pages/AdminPages.tsx` (TemplatesTab), `apps/web/src/pages/ProjectWorkspace.tsx`; Create `apps/web/src/pages/ContractWizard.tsx`, `apps/web/src/pages/ContractOverview.tsx`, `apps/web/src/pages/TemplatesPage.tsx`, `apps/web/e2e/contracts-v2.spec.ts`.

- Liste (Figma 07): açıklama, "Şablonlar" ve "Sözleşme ekle" düğmeleri, durum süzgeçleri sayılarıyla, sütunlar Sözleşme(+kod)/Tedarikçi/Proje/Departman/Bitiş/Tutar/Durum; eski imza süzgeci ve daha fazla yükle kalır.
- Sihirbaz `/sozlesmeler/ekle` (Figma 08, 09): adım göstergesi 1–4; Yükle (mevcut yükleme bileşeni; proje seçimi zorunlu; şablondan gelindiyse tür/sürüm dolu); Oku (yapay zekâ bağlı değil açıklaması, doğrudan 3'e geçer); Tamamla ve doğrula (sol: belge önizlemesi; sağ: alanlar, eksik sayısı, aday tedarikçi açma, "Tutar, tarih ve VKN'yi belgeyle karşılaştırdım." onay kutusu zorunlu); İncele ve gönder (özet, kullanılan taslak, hatırlatıcı tarihleri, onaycılar listesi + vekil seçimi + "Onaycı ekle", gönderim notu, "Taslağı kaydet", "Onaya gönder"; ön inceleme kartı yerine "Yapay zekâ ön incelemesi Faz 4'te" boş durumu).
- Detay (Figma 10, 11): başlık (kod · ad, tedarikçi · proje · departman, durum, "Belgeyi indir"); sekmeler Özet (bilgiler, onay zinciri, hatırlatıcılar, tedarikçi kartı özeti, eşleşen faturalar ve kullanım çubuğu), Belge, İnceleme (Faz 4 boş durumu), Onaylar (zincir geçmişi, karar düğmeleri yalnız yetkiliye, red gerekçesi), İmzalar (mevcut SignatureWorkspace), Koşullar, Yükümlülükler, Ticari (mevcut), Hatırlatıcılar (tarihler, e-posta durumu, karar girme), Geçmiş (denetim olayları). Eski sekme adresleri (`?sekme=imza` vb.) çalışmaya devam eder.
- Şablonlar (Figma 12): Yönetim > Şablonlar ve Sözleşmeler > Şablonlar aynı sayfa; tablo Kod/Taslak/Tür/Sürüm/Güncelleme/Kullanım, İndir, Yeni sözleşmede kullan, .docx sürükle-bırak (yalnız yetkili), dipnot.
- Proje detayı: "Sözleşmeler" sekmesi (bağlı sözleşmeler + "Bu projeye sözleşme ekle").
- Yönetim: hatırlatıcı süreleri ayarı (Yönetici).
- e2e (1440/1280/390): tam ekleme → gönderim → üç kullanıcıyla sırayla onay (farklı oturumlar) → Onaylandı + hatırlatıcı tarihleri; red ve yeniden gönderim; eski sözleşmenin imza sekmesi aynen; şablon yükle/indir; axe ve taşma. Veri değiştiren adımlar yalnız 1440.

- [ ] Adımlar: typecheck, build, yeni e2e + mevcut sözleşme/imza/navigasyon/a11y spec'leri. Commit.

### Task 8: iOS — İşlerim onay görevi, sözleşme onayı ekranı, tarama → alanlar → gönderim

**Files:** Modify `ios/Satinalma/Satinalma/Features/ContractsView.swift`, `ScanView.swift`, `RootViews.swift` (İşlerim yönlendirmesi), `Core/Models.swift`; Create `Features/ContractApprovalView.swift`, `Features/ContractFieldsView.swift`.

- İşlerim (Figma iOS 1): "Sözleşme onayı" görevine dokununca Sözleşme onayı ekranı (Figma iOS 4): tutar, süre, proje, departman, ön inceleme alanı (Faz 4 boş durumu), onay zinciri ("· siz"), Reddet (gerekçe sayfası) / Onayla.
- Tara (Figma iOS 2, 3): Sözleşme türünde tarama bitince "Alanları doğrula" formu (proje seçimi zorunlu, tedarikçi, tarihler, tutar, departman, karşılaştırma onay kutusu) → İncele ve gönder özeti → gönderim. Yarım kalan taslak web'de açılabilir.
- Sözleşmeler listesi: durum etiketi; satır → yeni özet ekranı, imza incelemesi oradan (dokunuş artışı yok: mevcut satır → imza yolu korunur ya da özet ekranında ilk eylem).
- AX5 ve büyük yazı; `xcodebuild` 0 uyarı; simülatörde uçtan uca.

### Task 9: Belgeler, doğrulama, inceleme

- [ ] Kararlar D108 (R1–R10), `docs/implementation-status.md` Faz 3 satırı (yapay zekâ ve e-posta gönderimi NOT_RUN / Faz 4–5), sözleşme işlev envanteri önce/sonra (web + iOS).
- [ ] Tam koşu: domain, api, typecheck, build, tam e2e, iOS derleme.
- [ ] `persona-testci`: Departman kullanıcısı ekler → departman sorumlusu → satınalma sorumlusu → direktör onaylar; red ve yeniden gönderim; başka departmandaki onaycı görünürlüğü; şablon; eski sözleşme; iOS'ta onay ve tarama.
- [ ] Bütün dal incelemesi; bulgular tek düzeltme turunda.
