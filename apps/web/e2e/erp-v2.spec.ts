// v2 Faz 8 (D113, Figma 22): Yönetim > Entegrasyonlar — Bağlantılar (7 ERP özelliği kartı) ve Fatura aktarım mutabakatı (değişmeden).
// Önkoşul: dev ortamında ERP_PROVIDER=taklit ve INTEGRATION_SECRET_KEY (taklit sağlayıcı: "Taklit Oracle (gerçek değil)"), işçi çalışıyor.
// Bütün sınama/çalışma sonuçları TAKLİT SAĞLAYICIYLA DENENDİ; gerçek Oracle kontrolleri NOT_RUN. Veri sentetik; veri değiştiren adımlar
// yalnız desktop-1440 projesinde.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}
async function audit(page: Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${name}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
const fits = (page: Page) => page.evaluate(() => { const m = document.querySelector('main')!; return m.scrollWidth <= m.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1; });
const detail = (page: Page) => page.locator('#erp-detail');
const openCard = async (page: Page, label: RegExp) => {
  await page.getByRole('button', { name: label }).first().click();
  await expect(detail(page).getByRole('heading', { level: 2 })).toBeVisible();
};

test('Yönetici: fatura kartı doldurulur, sır yalnız yazılır, taklitle sınanır, çalıştırılır; hata kaydı görünür', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  test.setTimeout(150_000);
  const secret = `e2e-SIR-${Date.now()}-q9Zx`;
  // Bütün API yanıtları toplanır: sır dizesi hiçbir yanıtta olmamalı.
  const bodies: Promise<string>[] = [];
  page.on('response', (res) => { if (res.url().includes('/api/')) bodies.push(res.text().catch(() => '')); });

  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/entegrasyonlar');
  // Yönetici varsayılan olarak Bağlantılar bölümünü görür.
  await expect(page.getByRole('heading', { name: 'Oracle ERP entegrasyonu', level: 1 })).toBeVisible();
  await expect(page.getByText('Sağlayıcı: Taklit Oracle (gerçek değil)')).toBeVisible();
  await expect(page.getByRole('heading', { name: '1. aşama — okuma' })).toBeVisible();
  await expect(page.getByRole('heading', { name: "2. aşama — ERP'ye yazma (kapalı varsayılan)" })).toBeVisible();

  await openCard(page, /^Fatura(?:\s|$)/);
  const d = detail(page);
  await expect(d.getByRole('heading', { name: 'Fatura', level: 2 })).toBeVisible();
  // Kartı doldur (taklit adres; bir satırın tutarı bozuk → hata kaydı oluşur).
  await d.getByLabel('Taban adres').fill('taklit://bozuk-tutar');
  await d.getByLabel('Kaynak yolu').fill('/ap/invoices');
  await d.getByLabel('Tür').selectOption('BASIC');
  await d.getByLabel('Kullanıcı adı').fill('e2e-okuyucu');
  if (await d.getByRole('button', { name: 'Değiştir' }).isVisible()) await d.getByRole('button', { name: 'Değiştir' }).click();
  const secretInput = d.getByLabel('Parola');
  await expect(secretInput).toHaveAttribute('type', 'password');
  await expect(secretInput).toHaveAttribute('autocomplete', 'off');
  await expect(secretInput).toHaveValue('');
  await secretInput.fill(secret);
  await d.getByRole('button', { name: 'EBS varsayılanını yükle' }).click();
  await d.getByRole('button', { name: 'Kaydet' }).click();
  await expect(d.getByText('Bağlantı ayarları kaydedildi.')).toBeVisible();

  // Yeniden yüklenince sır alanı "Ayarlı"; değer DOM'da yok.
  await page.reload();
  await expect(detail(page).getByTestId('secret-state')).toHaveText(/^Ayarlı · \d{1,2} \S+ \d{4}$/);
  expect(await page.content()).not.toContain(secret);
  expect(await page.evaluate((s) => [...document.querySelectorAll('input, textarea')].some((x) => (x as HTMLInputElement).value.includes(s)), secret)).toBe(false);

  // Özelliği aç (kapalıysa).
  const sw = detail(page).getByRole('switch', { name: 'Fatura özelliği' });
  if ((await sw.getAttribute('aria-checked')) !== 'true') {
    await sw.click();
    await expect(detail(page).getByText('Fatura açıldı.')).toBeVisible();
  }
  await expect(sw).toHaveAttribute('aria-checked', 'true');

  // Sına: taklit etiketiyle (gerçek başarı gibi gösterilmez). Yakın zamanda sınandıysa hız sınırı iletisi de kabul.
  await detail(page).getByRole('button', { name: 'Bağlantıyı sına' }).click();
  await expect(detail(page).getByText(/taklit sağlayıcıyla denendi|saniyede bir sınanabilir/).first()).toBeVisible();
  await expect(detail(page).getByText(/Son sınama .*taklit sağlayıcıyla denendi/)).toBeVisible();

  // Şimdi çalıştır → işçi okumayı bitirince çalışma ve hata kaydı görünür.
  await detail(page).getByRole('button', { name: 'Şimdi çalıştır' }).click();
  await expect(detail(page).getByText(/Okuma başlatıldı|bir çalışma sürüyor/)).toBeVisible();
  const runs = detail(page).getByRole('region', { name: /Son çalışmalar/ });
  const errBtn = runs.getByRole('button', { name: /^Hata kaydı \([1-9]\d*\)$/ }).first();
  await expect(errBtn).toBeVisible({ timeout: 90_000 });
  await expect(runs.getByText('Taklit').first()).toBeVisible();
  await expect(runs.getByText(/taklit sağlayıcıyla denendi — gerçek Oracle değil/).first()).toBeVisible();
  if ((await errBtn.getAttribute('aria-expanded')) !== 'true') await errBtn.click();
  const log = detail(page).getByRole('region', { name: 'Hata kaydı' });
  await expect(log.getByRole('listitem').first()).toBeVisible();
  // Ham kod değil, Türkçe ileti.
  await expect(log).not.toContainText(/invalid_decimal|supplier_not_matched|company_unresolved/);

  // Yazma açma iletişimi koşullar sağlanmadan reddeder (Sözleşme başlığı kapalı; istek atılmaz).
  await openCard(page, /^Sözleşme başlığı(?:\s|$)/);
  const sozSw = detail(page).getByRole('switch', { name: 'Sözleşme başlığı özelliği' });
  test.skip((await sozSw.getAttribute('aria-checked')) === 'true', 'Sözleşme başlığı bu ortamda açık; ret senaryosu kurulamaz');
  await detail(page).getByRole('button', { name: "ERP'ye yazmayı aç" }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('checkbox', { name: "ERP'ye kayıt yazılacağını anlıyorum" }).check();
  await dlg.getByRole('button', { name: 'Yazmayı aç' }).click();
  await expect(dlg.getByText('Önce özelliği açın.')).toBeVisible();
  await expect(dlg.getByText("Yazma açılmadı; hiçbir kayıt ERP'ye gönderilmedi.")).toBeVisible();
  await dlg.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(detail(page).getByText("Kapalı (varsayılan).", { exact: false })).toBeVisible();

  // Hiçbir API yanıtında sır yok.
  const all = await Promise.all(bodies);
  expect(all.length).toBeGreaterThan(5);
  expect(all.filter((b) => b.includes(secret))).toEqual([]);
});

test('Satınalma: mutabakat ilk ekranda (değişmeden), eski adres yönlenir, kartlar salt okunur, faturada kaynak etiketi', async ({ page }) => {
  await login(page, 'ferda.finans@example.test');
  await page.goto('/yonetim/entegrasyonlar');
  await expect(page.getByRole('heading', { name: 'ERP mutabakatı', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Durum ve toplamlar' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Entegrasyon bölümleri' }).getByRole('link', { name: 'Fatura aktarım mutabakatı' })).toHaveAttribute('aria-current', 'page');
  expect(new URL(page.url()).search).toBe('');
  expect(await fits(page)).toBe(true);

  await page.goto('/faturalar/erp-mutabakati');
  await expect(page).toHaveURL(/\/yonetim\/entegrasyonlar\?bolum=mutabakat$/);
  await expect(page.getByRole('heading', { name: 'ERP mutabakatı', level: 1 })).toBeVisible();

  await page.getByRole('navigation', { name: 'Entegrasyon bölümleri' }).getByRole('link', { name: 'Bağlantılar' }).click();
  await expect(page.getByRole('heading', { name: 'Oracle ERP entegrasyonu', level: 1 })).toBeVisible();
  await expect(page.getByText(/bu sayfa sizin için salt okunur/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Tedarikçi ana verisi|Departman \/ masraf merkezi|Satınalma talebi|Sözleşme başlığı|Sipariş|Fatura|Ödeme durumu)(?:\s|$)/ })).toHaveCount(7);
  await openCard(page, /^Fatura(?:\s|$)/);
  await expect(detail(page).getByTestId('secret-state')).toHaveText(/^(Ayarlı · \d{1,2} \S+ \d{4}|Ayarlı değil|Sır yeniden girilmeli.*)$/);
  await expect(detail(page).getByRole('switch')).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: /Kaydet|Bağlantıyı sına|Şimdi çalıştır|EBS varsayılanını yükle/ })).toHaveCount(0);
  await expect(detail(page).locator('input[type="password"]')).toHaveCount(0);
  await audit(page, 'Entegrasyonlar · Bağlantılar (Satınalma)');
  expect(await fits(page)).toBe(true);

  // Fatura listesinde kaynak etiketi (Elle / e-Fatura / Taklit Oracle (gerçek değil) / Oracle ERP).
  await page.goto('/faturalar');
  await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toBeVisible();
  await expect(page.getByText(/· (Elle|e-Fatura|Taklit Oracle \(gerçek değil\)|Oracle ERP)/).first()).toBeVisible();
});

test('Satınalma: demo faturada ödeme durumu değiştirilemez (409), kaynak satırı görünür', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'yazma denemesi; yalnız bir projede');
  await login(page, 'ferda.finans@example.test');
  await page.goto('/faturalar');
  await expect(page.getByRole('columnheader', { name: 'Fatura no' })).toBeVisible();
  const link = page.getByRole('link', { name: 'ANB2026000101', exact: true });
  test.skip(!(await link.count()), 'demo fatura bu kullanıcıya görünmüyor');
  await link.first().click();
  const panel = page.getByRole('region', { name: 'Kaynak ve ERP' });
  await expect(panel.getByText('Kaynak', { exact: true })).toBeVisible();
  await expect(panel.getByText('ERP ödeme durumu')).toBeVisible();
  await panel.getByRole('button', { name: 'Ödeme durumunu gir' }).click();
  await panel.getByLabel('Ödeme durumu').selectOption('PAID');
  await panel.getByRole('button', { name: 'Kaydet' }).click();
  await expect(panel.getByText('Demo fatura değiştirilmez.')).toBeVisible();
});

test('Denetçi: mutabakat ilk ekranda, kartlar salt okunur', async ({ page }) => {
  await login(page, 'deniz.denetci@example.test');
  await page.goto('/yonetim/entegrasyonlar');
  await expect(page.getByRole('heading', { name: 'Durum ve toplamlar' })).toBeVisible();
  await page.goto('/yonetim/entegrasyonlar?bolum=baglantilar&ozellik=SUPPLIER');
  await expect(detail(page).getByRole('heading', { name: 'Tedarikçi ana verisi', level: 2 })).toBeVisible();
  await expect(detail(page).getByRole('switch')).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: /Kaydet|Bağlantıyı sına|Şimdi çalıştır|ERP'ye yazmayı aç/ })).toHaveCount(0);
  await expect(detail(page).getByText("Sınama ve çalıştırma Yönetici'ye açıktır.")).toBeVisible();
  await audit(page, 'Entegrasyonlar · kart (Denetçi)');
  expect(await fits(page)).toBe(true);
});

test('Yönetici: bağlantılar ve kart erişilebilir, taşmaz; mutabakat bölümünde açıklama', async ({ page }) => {
  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/entegrasyonlar');
  await expect(page.getByRole('heading', { name: 'Oracle ERP entegrasyonu', level: 1 })).toBeVisible();
  await audit(page, 'Entegrasyonlar · Bağlantılar (Yönetici)');
  expect(await fits(page)).toBe(true);
  await openCard(page, /^Tedarikçi ana verisi(?:\s|$)/);
  await expect(detail(page).getByText('Kapalıyken:', { exact: false }).or(detail(page).getByText('Özellik açıkken de elle giriş yolu kalır', { exact: false })).first()).toBeVisible();
  await expect(detail(page).getByRole('region', { name: /Son çalışmalar/ })).toBeVisible();
  await audit(page, 'Entegrasyonlar · kart (Yönetici)');
  expect(await fits(page)).toBe(true);
  await page.getByRole('navigation', { name: 'Entegrasyon bölümleri' }).getByRole('link', { name: 'Fatura aktarım mutabakatı' }).click();
  await expect(page.getByRole('heading', { name: 'ERP mutabakatı Satınalma ve Denetçi rollerine açık' })).toBeVisible();
});
