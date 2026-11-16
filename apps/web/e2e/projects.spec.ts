// v2 Faz 1 (D93/D95): yükümlülük ekleme formundaki rol seçicisi yalnız v2 rollerini (tekrarsız) sunar. Proje sihirbazı departman ister (her rolde zorunlu); adım doğrulaması testi önce departmanı seçer.
import { expect, test, type Page } from '@playwright/test';

// Faz 2 kritik tarayıcı görevleri (sentetik demo verisi: npm run db:seed).
async function login(page: Page, email: string, landing: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: landing })).toBeVisible();
}

test('tedarikçi portalda teklif verir; alındı zamanı ve sürüm sunucudan gelir (UX04)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  await login(page, 'teklif.ege@example.test', 'Teklif davetleri');
  await page.getByRole('row', { name: /Tesis temizlik hizmeti 2027/ }).getByRole('link').click();
  await expect(page.getByText(/Kalan süre \(sunucu saatine göre\)/)).toBeVisible();
  // Eksik fiyatla gönderim: hata özeti, sunucuya gitmez (önceki sürüm formu doldurmuş olabilir).
  const prices = page.getByLabel('Birim fiyat (TRY)');
  await prices.nth(0).fill('');
  await page.getByRole('button', { name: /Teklifi gönder|Yeni sürüm gönder/ }).click();
  await expect(page.getByText('Teklif formunda eksik alanlar var')).toBeVisible();
  // Önceki çalıştırmaların ekleri bu sürüme taşınmasın (yalnız yeni ek bağlanır).
  const checked = page.locator('input[type=checkbox]:checked');
  while (await checked.count()) await checked.first().uncheck();
  // Ek: gerçek dosya seçimi → sunucu kontrolü → bu sürüme bağlanır.
  await page.locator('#bid-file').setInputFiles({ name: 'teknik-foy-sentetik.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from(`%PDF-1.4\n% SENTETIK ${Date.now()}-${Math.random()}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`) });
  await expect(page.getByText(/teklife eklendi/)).toBeVisible();
  await prices.nth(0).fill('21500');
  await prices.nth(1).fill('18750.50');
  await page.getByRole('button', { name: /Teklifi gönder|Yeni sürüm gönder/ }).click();
  await expect(page.getByText(/Teklifiniz alındı: sürüm \d+/)).toBeVisible();
  await expect(page.getByText(/Alındı zamanı \(sunucu\)/)).toBeVisible();
  // Bütçe ve diğer teklifler portalda yok.
  await expect(page.getByText('620.000')).toHaveCount(0);
  await expect(page.getByText('Anadolu Bilişim')).toHaveCount(0);
});

test('alıcı karşılaştırmada eksik kapsamı ve onaylı bölünmüş tahsisi görür (T10, T12)', async ({ page }) => {
  await login(page, 'alper.satinalma@example.test', 'İşlerim');
  await page.getByRole('link', { name: 'Projeler' }).click();
  await page.getByRole('link', { name: 'BT altyapı bakım hizmeti 2027' }).first().click();
  await expect(page.getByRole('heading', { name: 'BT altyapı bakım hizmeti 2027' })).toBeVisible();
  await page.getByRole('tab', { name: 'Karşılaştırma' }).click();
  await expect(page.getByText('Birim farklı').first()).toBeVisible();
  await expect(page.getByText(/Karşılaştırılamıyor · 1 kalem/)).toBeVisible();
  await page.getByRole('tab', { name: 'Karar' }).click();
  await expect(page.getByRole('heading', { name: 'Onaylanan tahsis' })).toBeVisible();
  await expect(page.getByText(/Kurul kararı/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'XLSX rapor' }).first()).toBeVisible();
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF karar özeti' }).first().click()]);
  expect(pdf.suggestedFilename()).toMatch(/^PRJ-\d{4}-\d{4}-karar-ozeti-v\d+\.pdf$/);
});

test('proje sihirbazı: adım doğrulaması ve ilk hataya odak (UX03)', async ({ page }) => {
  await login(page, 'alper.satinalma@example.test', 'İşlerim');
  await page.goto('/projeler/yeni');
  // v2: departman her rolde zorunlu; Satınalma bütün departmanları görür, önceden seçili gelmez.
  await page.getByLabel('Departman').selectOption({ label: 'Bilgi Teknolojileri' });
  await page.getByLabel('Proje adı').fill('');
  await page.getByRole('button', { name: 'Devam' }).click();
  await expect(page.getByText('Formda düzeltilecek alanlar var')).toBeVisible();
  await expect(page.getByLabel('Proje adı')).toBeFocused();
  await page.getByLabel('Proje adı').fill('E2E sentetik proje');
  await page.getByLabel('Kategori').fill('Test');
  await page.getByRole('button', { name: 'Devam' }).click();
  await expect(page.getByRole('textbox', { name: 'Kalem 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Taslağı at' }).click();
});

test('proje ekranları yatay taşmaz', async ({ page }) => {
  await login(page, 'alper.satinalma@example.test', 'İşlerim');
  for (const path of ['/projeler', '/projeler/yeni']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(sw, path).toBeLessThanOrEqual(cw);
  }
});

test('İşlerim: kayıt no ve sekme sayıları', async ({ page }) => {
  await login(page, 'leyla.hukuk@example.test', 'İşlerim');
  await expect(page.getByRole('tab', { name: /Benden beklenen\s*\d+/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Geciken\s*\d+/ })).toBeVisible();
  await expect(page.getByText(/^SZL-\d{4}-\d{4}$/).filter({ visible: true }).first()).toBeVisible();
});

test('sözleşme: ihbar son günü bitişe değil ihbar kuralına göre; görev İşlerim\'de (T21, UX09)', async ({ page }) => {
  await login(page, 'kerem.hukuk@example.test', 'İşlerim');
  await expect(page.getByText(/İhbar son günü 30\.10\.2026/).filter({ visible: true }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Sözleşmeler' }).click();
  await page.getByRole('link', { name: /Yıllık Bakım Sözleşmesi 2026/ }).first().click();
  await expect(page.getByRole('tab', { name: 'İmza kontrolü' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Koşullar ve ihbar' }).click();
  await expect(page.getByText('30 Eki 2026')).toBeVisible();
  await expect(page.getByText(/önceki iş günü 30\.10\.2026/)).toBeVisible();
  await expect(page.getByText(/Hukuk doğruladı/)).toBeVisible();
  await page.getByRole('tab', { name: 'Yükümlülükler' }).click();
  await expect(page.getByRole('heading', { name: 'Yıllık sızma testi raporu' })).toBeVisible();
  await expect(page.getByText(/Sahipsiz/).first()).toBeVisible();
  // v2: takip eden rol seçicisi Sahipsiz + iki v2 rolü sunar; eski kodlar aynı adla tekrar etmez.
  await page.getByRole('button', { name: 'Yükümlülük ekle' }).click();
  await expect(page.getByLabel('Takip eden rol').locator('option')).toHaveText(['Sahipsiz', 'Satınalma', 'Departman kullanıcısı']);
  await page.getByRole('button', { name: 'Vazgeç' }).click();
});
