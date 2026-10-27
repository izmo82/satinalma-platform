import { expect, test, type Page } from '@playwright/test';

// Faz 5 kritik tarayıcı görevleri: olay (UX12, T19), değerlendirme ve kritik engel (T20), raporlar (UX13), AI yönetişimi (T23). Sentetik demo verisi.
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}
const logout = (page: Page) => page.getByRole('button', { name: 'Çıkış' }).click();
async function openSupplier(page: Page, name: string, tab: string) {
  await page.getByRole('link', { name: 'Tedarikçiler' }).click();
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await page.getByRole('tab', { name: tab }).click();
}

test('olay: bildirim iddiadır; bildiren doğrulayamaz; doğrulanınca puan etkisi ve zaman çizelgesi görünür (UX12, T19)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const tag = Date.now().toString().slice(-6);
  await login(page, 'alper.satinalma@example.test');
  await openSupplier(page, 'Kuzey Teknoloji', 'Olaylar');
  await page.getByRole('button', { name: 'Olay bildir' }).click();
  await page.getByLabel('Kategori').selectOption('DELAY');
  await page.getByLabel('Şiddet (bildirene göre)').selectOption('HIGH');
  await page.getByLabel('Başlık').fill(`Teslim gecikmesi ${tag}`);
  await page.getByLabel('Ne oldu').fill('Kurulum ekibi iki gün geç geldi (e2e sentetik).');
  await page.getByRole('button', { name: 'Bildir' }).click();
  // Aynı tedarikçi/kategoride yakın tarihli olay varsa önce olası mükerrer uyarısı gelir (otomatik birleştirilmez).
  const openNew = page.getByRole('button', { name: 'Olayı aç' });
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(tag) }).or(openNew)).toBeVisible();
  if (await openNew.isVisible()) { await expect(page.getByText(/olası mükerrer olay var/)).toBeVisible(); await openNew.click(); }
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Teslim gecikmesi ${tag}`);
  await expect(page.getByText('Puana yansımıyor')).toBeVisible();
  await expect(page.getByText('İddia; doğrulanmadı.')).toBeVisible();
  const url = page.url();
  await logout(page);

  await login(page, 'kerem.hukuk@example.test');
  await page.goto(url);
  await page.getByRole('button', { name: 'Ön incelemeyi başlat' }).click();
  await page.getByLabel('Gerekçe ve kanıt').fill('Kurulum tutanağı ve e-posta yazışması incelendi (e2e).');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Ön incelemeyi başlat: kaydedildi.')).toBeVisible();
  await page.getByRole('button', { name: 'Doğrula', exact: true }).click();
  await page.getByLabel('Doğrulanan şiddet').selectOption('MEDIUM');
  await page.getByLabel('Gerekçe ve kanıt').fill('Gecikme tutanakla doğrulandı; etki sınırlı (e2e).');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText(/Puan etkisi: −3/)).toBeVisible();
  await expect(page.getByText('Doğrulandı', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('list').filter({ hasText: 'Ön inceleme başladı' })).toContainText('Doğrulandı');
});

test('değerlendirme: kritik kontrolde "hayır" kritik engel gösterir; uyum oranı engeli aşmaz (T20)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  await login(page, 'alper.satinalma@example.test');
  await openSupplier(page, 'Kuzey Teknoloji', 'Değerlendirme ve risk');
  await page.getByRole('button', { name: 'Değerlendirme başlat' }).click();
  await page.getByLabel('Anket şablonu').selectOption({ index: 1 });
  await page.getByLabel('Hizmet kapsamı').fill('Uzak erişimli ağ bakımı (e2e)');
  await page.getByLabel('Veri hassasiyeti').selectOption('HIGH');
  await page.getByLabel('Erişim seviyesi').selectOption('HIGH');
  await page.getByRole('button', { name: 'Başlat' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Uzak erişimli ağ bakımı (e2e)');
  await expect(page.getByText('Kritik', { exact: true }).first()).toBeVisible();
  // Kritik soru yanıtsız = bilinmiyor = engel; içsel risk hassas veri + ayrıcalıklı erişim = kritik.
  await expect(page.getByText(/Kritik engel \(1\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Yanıt gir' }).first().click();
  await page.getByLabel('Yanıt').selectOption('NO');
  await page.getByRole('button', { name: 'Yanıtı kaydet' }).click();
  await expect(page.getByText(/kontrol uygulanmıyor/).first()).toBeVisible();
  await expect(page.getByText(/Kritik engel \(1\)/)).toBeVisible();
  await expect(page.getByRole('complementary').getByText('Kritik', { exact: true }).first()).toBeVisible();
});

test('raporlar: tanım ve kaynakla göstergeler; CSV aynı yetkiyle iner (UX13)', async ({ page }) => {
  await login(page, 'ferda.finans@example.test');
  await page.getByRole('link', { name: 'Raporlar' }).click();
  await expect(page.getByRole('heading', { name: 'Raporlar' })).toBeVisible();
  await expect(page.getByText('Fatura istisna oranı')).toBeVisible();
  await expect(page.getByText(/en pahalı teklif farkı tasarruf diye raporlanmaz/)).toBeVisible();
  await expect(page.getByText(/veri anı/).first()).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV indir' }).click();
  expect((await download).suggestedFilename()).toMatch(/^yonetim-gostergeleri-.*\.csv$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('AI: sağlayıcı yokken manuel akış; kalite ölçümü BLOCKED; politika yalnız kiracı yöneticisinde (T23)', async ({ page }) => {
  await login(page, 'tamer.yonetici@example.test');
  await page.getByRole('link', { name: 'Yapay zekâ' }).click();
  await expect(page.getByText('Etkin AI sağlayıcısı yok')).toBeVisible();
  await expect(page.getByText('Kalite ölçümü yapılamadı (engelli)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Düzenle' })).toBeVisible();
  await logout(page);
  await login(page, 'kerem.hukuk@example.test');
  await page.getByRole('link', { name: 'Yapay zekâ' }).click();
  await expect(page.getByText('Görev matrisi')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Düzenle' })).toHaveCount(0);
});

test('tedarikçi karnesi ve olay listesi yatay taşmaz; yetersiz veride puan verilmez', async ({ page }) => {
  await login(page, 'alper.satinalma@example.test');
  await openSupplier(page, 'Anadolu Bilişim', 'Performans karnesi');
  await expect(page.getByText(/performansı/).first()).toBeVisible();
  await expect(page.getByText(/Yetersiz veri|\/ 100/).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole('link', { name: 'Olaylar' }).first().click();
  await expect(page.getByRole('heading', { name: 'Tedarikçi olayları' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
