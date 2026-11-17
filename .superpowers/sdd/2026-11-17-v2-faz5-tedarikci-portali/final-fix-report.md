# v2 Faz 5 son inceleme düzeltmeleri (API/domain)

Kapsam: I1, M1, M2. apps/web ve ios değiştirilmedi. sourcing.ts'e dokunulmadı (başka ajanın kaydedilmemiş ERP değişikliği var); M1 tamamen `queueRoundInvites` içinde.

## I1 — süresi dolan tamamlama bağlantısı
- Domain `packages/domain/src/supplierPortal.ts`: `NEEDS_DOCUMENTS --REQUEST_DOCUMENTS--> NEEDS_DOCUMENTS` (yeniden gönderim). COMPLETE/REJECT aynen; APPROVE hâlâ geçersiz.
- API `apps/api/src/modules/supplierApplications.ts` `requestDocuments`: NEEDS_DOCUMENTS'ta çağrılınca yeniden gönderim. `documents` boş/verilmezse önceki `requested_documents` ve (not verilmediyse) önceki `requested_note` kullanılır. Yeni belirteç (eski özet ezilir → eski bağlantı 410), yeni 24 saat, e-posta kuyruğa (`none` kanalda dürüstçe NOT_CONFIGURED). Denetim olayı `supplier_application.link_resent` (geçmişte "Tamamlama bağlantısı yeniden gönderildi"); belirteç denetime yazılmaz.
- SUBMITTED'daki ilk istek davranışı değişmedi (liste zorunlu, `documents_required`).

### Web için alanlar (GET /api/v1/supplier-applications/:id)
- `completionTokenExpiresAt: string | null` — artık yalnız `status === 'NEEDS_DOCUMENTS'` iken dolu (önceden de pratikte yalnız o durumda doluydu).
- `completionLinkExpired: boolean` — YENİ; NEEDS_DOCUMENTS ve bağlantı süresi geçmiş (ya da yok) ise true.
- `can.resendLink: boolean` — YENİ; `supplier.application.review` izni ve `status === 'NEEDS_DOCUMENTS'`.
- Düğme "Bağlantıyı yeniden gönder": `POST /api/v1/supplier-applications/:id/decision` gövdesi `{ action: 'REQUEST_DOCUMENTS', expectedRowVersion }` (isteğe bağlı `note`, `documents`).
- Yanıt (karar ucu, REQUEST_DOCUMENTS): mevcut alanlara ek `completionTokenExpiresAt: string`, `resent: boolean`; `emails: [{ kind: 'documents_requested', status }]` (QUEUED | NOT_CONFIGURED).

## M1 — onay anında pasif tedarikçi
- `apps/api/src/modules/portal.ts` `queueRoundInvites`: `canInviteSupplier` olmayan davetliye e-posta yazılmaz; görev `kind: 'supplier_invite_ineligible'`, başlık `Davetli tedarikçi pasif: <unvan>`, Satınalma rolü, dedupe `round:<roundId>:ineligible:<supplierId>`. Dönüş `{ queued, missingUsers, ineligible }` → karar ucu yanıtında `invites.ineligible: string[]` (YENİ).
- `roundInviteEmails` (proje ayrıntısı `round.inviteEmails`): pasif tedarikçide etiket `Tedarikçi pasif; davet e-postası yazılmadı`.
- Web takibi: `WorkPage.tsx` görev yönlendirmesinde `supplier_invite_ineligible` varsayılan karta gider (özel sekme yok); istenirse eklenebilir.
- Not: davet satırı (rfq_invitations) silinmez; portalda pasif tedarikçinin teklif verip veremediği bu düzeltmenin kapsamı dışında, ayrıca denetlenmedi.

## M2 — e-posta kutusunda maske
- `apps/api/src/server.ts`: `maskTokens` artık `env !== 'development' && env !== 'test'` (önce yalnız `production`). Diğer kaydedilmemiş server.ts değişikliği yoktu (`git diff` boştu).

## Testler (PASS = çalıştırılıp geçti)
- `npm test -w @sp/domain`: 22 dosya, 389 test PASS (yeni: NEEDS_DOCUMENTS → REQUEST_DOCUMENTS).
- API (tek tek/birlikte): supplierApplyPublic, supplierReview (yeni: süresi dolmuş bağlantı → yeniden gönder → eski belirteç 410 → yeni belirteçle tamamla → SUBMITTED), portalV2 (yeni: talep–onay arasında askıya alınan tedarikçi), emailOutbox (yeni: NODE_ENV=staging maskeler), sourcing: 5 dosya, 66 test PASS.
- `npm run typecheck`: PASS (domain, api, web).
- Değişen eski test: portalV2 `queueRoundInvites` dönüşü `toEqual` ile karşılaştırılıyordu; dönüşe `ineligible` eklendiği için beklenene `ineligible: []` eklendi (davranış aynı).
- e2e ve persona yürüyüşü bu dalgada yapılmadı (web tarafı ayrı ajan).
