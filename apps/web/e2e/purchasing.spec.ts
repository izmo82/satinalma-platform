import { expect, test, type Page } from '@playwright/test';

// Faz 4 kritik tarayıcı görevleri: sipariş, kabul, fatura tahsisi, görev ayrılığıyla onay (UX10). Sentetik demo verisi: npm run db:seed.
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}
const logout = (page: Page) => page.getByRole('button', { name: 'Çıkış' }).click();

test('sipariş → kabul → fatura → tahsis → ikinci finans onayı; tekrar gelen fatura yeni kayıt açmaz (T13, T17, UX10)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const tag = Date.now().toString().slice(-7);
  await login(page, 'alper.satinalma@example.test');
  await page.goto('/siparisler');
  await page.getByRole('button', { name: 'Sipariş ver' }).click();
  await page.getByLabel('Tedarikçi').selectOption({ label: 'Anadolu Bilişim Hizmetleri A.Ş. (SENTETİK)' });
  await page.getByLabel('Kalem 1', { exact: true }).fill(`Etiket yazıcı ${tag}`);
  await page.getByLabel('Miktar').fill('5');
  await page.getByLabel('Birim', { exact: true }).fill('adet');
  await page.getByLabel('Birim fiyat').fill('1200');
  await page.getByRole('button', { name: 'Siparişi kaydet' }).click();
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText('PO-');
  const poCode = (await heading.textContent())!.split(' · ')[0]!.trim();
  await page.getByRole('button', { name: 'Kabul kaydet' }).click();
  await page.getByLabel('Miktar').fill('5');
  await page.getByLabel('Not').fill('Teslim alındı (e2e)');
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByText('Kabul kaydedildi.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kabul kaydet' })).toHaveCount(0);

  await logout(page);
  await login(page, 'ferda.finans@example.test');
  await page.goto('/faturalar');
  const enter = async () => {
    await page.getByRole('button', { name: 'Fatura gir' }).click();
    await page.getByLabel('Tedarikçi').selectOption({ label: 'Anadolu Bilişim Hizmetleri A.Ş. (SENTETİK)' });
    await page.getByLabel('Fatura no').fill(`E2E${tag}`);
    await page.getByLabel('Fatura tarihi').fill('2026-10-21');
    await page.getByLabel('Satır 1', { exact: true }).fill('Etiket yazıcı');
    await page.getByLabel('Miktar').fill('5');
    await page.getByLabel('Birim', { exact: true }).fill('adet');
    await page.getByLabel('Birim fiyat').fill('1200');
    await page.getByRole('button', { name: 'Faturayı kaydet' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`E2E${tag}`);
  };
  await enter();
  const invoiceUrl = page.url();
  // Tahsis yokken bulgu ve çözen rol görünür.
  await expect(page.getByText('sipariş veya sözleşmeye tahsis edilmedi')).toBeVisible();
  await expect(page.getByText('Çözen: Finans').first()).toBeVisible();
  await page.getByRole('button', { name: 'Tahsisi düzenle' }).click();
  await page.getByRole('button', { name: `${poCode} kalemlerini yükle` }).click();
  await page.getByLabel('Satır 1 hedef').selectOption({ label: `${poCode} · Etiket yazıcı ${tag}` });
  await page.getByRole('button', { name: 'Tahsisi kaydet ve kontrol et' }).click();
  await expect(page.getByText('Onaya hazır')).toBeVisible();
  // Giren kişi onaylayamaz (görev ayrılığı).
  await expect(page.getByText('Faturayı siz girdiniz')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finans onayı' })).toHaveCount(0);
  // Aynı fatura ikinci kez girilirse mevcut kayıt açılır.
  await page.goto('/faturalar');
  await enter();
  expect(page.url()).toBe(invoiceUrl);
  await expect(page.getByText('1 kez tekrar geldi')).toBeVisible();

  await logout(page);
  await login(page, 'nur.finansonay@example.test');
  await page.goto(invoiceUrl);
  await page.getByRole('button', { name: 'Finans onayı' }).click();
  await expect(page.getByText('Finans onaylı')).toBeVisible();
  // ERP bağdaştırıcısı yoksa aktarım başarı gibi gösterilmez.
  await expect(page.getByText(/ERP bağlantısı yapılandırılmadı|ERP: aktarım bekliyor/).first()).toBeVisible();
  await page.goto('/siparisler');
  await page.getByRole('link', { name: poCode }).click();
  await expect(page.getByRole('row', { name: new RegExp(`Etiket yazıcı ${tag}`) })).toContainText('5 adet');
});

test('istisna gereken fatura: neden eşleşmedi ve kim çözer görünür; tek başına onaylanamaz (T14, UX10)', async ({ page }) => {
  await login(page, 'nur.finansonay@example.test');
  await page.goto('/faturalar');
  await page.getByRole('link', { name: 'ANB2026000102' }).click();
  await expect(page.getByText('İstisna gerekli').first()).toBeVisible();
  await expect(page.getByText(/kabul kaydı yok/)).toBeVisible();
  await expect(page.getByText('Çözen: Talep sahibi')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finans onayı' })).toBeDisabled();
  await expect(page.getByText('Kullanılabilir')).toBeVisible();
});

test('sipariş ve fatura ekranları yatay taşmaz', async ({ page }) => {
  await login(page, 'nur.finansonay@example.test');
  for (const path of ['/siparisler', '/faturalar']) {
    await page.goto(path);
    await expect(page.getByRole('table')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), path).toBe(true);
  }
  await page.getByRole('link', { name: 'ANB2026000102' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
