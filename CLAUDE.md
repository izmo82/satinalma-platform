# Proje talimatları

- Gereksinimler `project-specs/procurement/` altında; bağlayıcı ayrıntı 06 (imza) ve 09 (kabul testleri). Bu dosyaları değiştirme.
- Devam ederken önce `docs/implementation-status.md`, `docs/decisions.md` oku; tamamlanmış işi tekrarlama.
- Durum dili: PASS yalnız çalıştırılıp geçen kontrol. Mock/test sağlayıcısını gerçek başarı gibi gösterme.
- Kiracı bağlamı yalnız `withTenant` ile; uygulama `sp_app` rolüyle çalışır. Yeni tablo = RLS politikası + en dar GRANT.
- İmza durumu saklanmaz; `packages/domain/src/signature.ts` ile türetilir.
- Para için decimal string; LLM'e para/VKN/onay/ödeme kararı verilmez.
- Testler: `npm test -w @sp/domain`, `npm test -w @sp/api`, `npm run typecheck`, `npm run e2e -w @sp/web`.

## Araçlar (coachos ile aynı set)
- Arayüz tasarımı ve inceleme: `impeccable` skill'i (hook'lar `.claude/settings.json`'da); bileşenler için shadcn MCP (`.mcp.json`).
- "Bitti" demeden önce sentetik personayla uçtan uca: `persona-testci` ajanı (web + iOS).
- Commit öncesi inceleme: `code-review` skill'i veya `surgeon-reviewer`; mimari iyileştirme: `improve-codebase-architecture`.
- Ajan raporu kanıt değildir; sonucu ve diff'i kendin kontrol et.
