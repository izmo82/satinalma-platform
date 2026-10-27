# Satınalma ve Sözleşme Platformu

Çok kiracılı, denetlenebilir satınalma ve sözleşme platformu (web + native iOS). Belirli bir sağlayıcıya bağlı değildir: kurum içi veri merkezinde, herhangi bir Kubernetes dağıtımında veya herhangi bir bulutta aynı imajlarla çalışır (`deploy/README.md`).
Gereksinim paketi: `project-specs/procurement/` (v1.2). Durum ve test kanıtı: `docs/implementation-status.md`.

- `packages/domain` — saf iş kuralları (VKN/TCKN/IBAN, roller/izinler, imza durumu türetme)
- `apps/api` — Fastify API + worker, PostgreSQL migration'ları (RLS), entegrasyon testleri
- `apps/web` — React web (tasarım tokenları, İşlerim, tedarikçi, belge girişi, sözleşme/imza çalışma alanı), Playwright E2E
- `ios/Satinalma` — SwiftUI uygulaması (Keychain oturum, İşlerim, imza durumu)
- `docs/` — mimari, kararlar, runbook, OpenAPI

Kurulum ve test komutları: `docs/runbook.md`. Tüm demo/test verisi sentetiktir.
