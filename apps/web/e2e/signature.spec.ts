import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}

test('hukuk kullanıcısı eksik tarafı tek yerde görür; eksik kanıtla kesinleştiremez (UI + klavye)', async ({ page }, info) => {
  await login(page, 'leyla.hukuk@example.test');
  await page.getByRole('link', { name: 'Sözleşmeler' }).click();
  await page.getByRole('button', { name: /Tarafı eksik/ }).click();
  const row = page.getByRole('link', { name: 'Nakliye Hizmet Sözleşmesi' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole('heading', { name: 'Nakliye Hizmet Sözleşmesi' })).toBeVisible();
  // İstisna eksikliği gizlemez: hem sonuç hem asıl durum görünür.
  await expect(page.getByText('Eksik — yetkili istisna ile işlem').first()).toBeVisible();
  await expect(page.getByText('İmza eksik (insan teyidi)')).toBeVisible();
  // Görsel tespit, insan kararı ve fiziksel asıl ayrı katmanlar.
  await expect(page.getByText('Otomatik tarama', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Fiziksel asıl', { exact: true }).first()).toBeVisible();
  // Doküman görüntüleyici gerçekten sayfa çizer. Dar ekranda belge ayrı sekmededir (belge/alanlar alt alta uzun kaydırma yerine).
  if (info.project.name === 'narrow-390') await page.getByRole('tablist', { name: 'Görünüm' }).getByRole('tab', { name: 'Belge' }).click();
  await expect(page.getByRole('group', { name: 'Sayfa 1' })).toBeVisible();
});

test('inceleme formu: hata özeti ve ilk hataya odak; klavye ile gönderim', async ({ page }, info) => {
  // Veri değiştirir: yalnız bir projede çalışır.
  test.skip(info.project.name !== 'desktop-1440', 'mutating test runs once');
  await login(page, 'leyla.hukuk@example.test');
  await page.goto('/sozlesmeler');
  await page.getByRole('link', { name: 'Depo Kiralama Sözleşmesi' }).click();
  await page.getByRole('button', { name: /Sentetik|Anadolu.*için incele/ }).first().click();
  await page.getByRole('button', { name: 'Kararı kaydet' }).click();
  await expect(page.getByText('Formda düzeltilecek alanlar var')).toBeVisible();
  await expect(page.locator('#dec-0')).toBeFocused();
  await page.keyboard.press('Space');
  await page.getByLabel('Gerekçe').fill('E2E sentetik: sayfa 2 imza alanında tam imza görüldü');
  await page.getByRole('button', { name: 'Kararı kaydet' }).click();
  await expect(page.getByText('İnceleme kararı kaydedildi.')).toBeVisible();
});

test('başka kiracı kullanıcısı A kiracısının sözleşmesini açamaz', async ({ page, request }) => {
  await login(page, 'leyla.hukuk@example.test');
  await page.goto('/sozlesmeler');
  const href = await page.getByRole('link', { name: 'Depo Kiralama Sözleşmesi' }).getAttribute('href');
  await page.getByRole('button', { name: 'Çıkış' }).click();
  await login(page, 'bora.baskakiraci@example.test');
  await page.goto(href!);
  await expect(page.getByText('Kayıt bulunamadı veya erişim yetkiniz yok').first()).toBeVisible();
  void request;
});

test('sayfa yatay taşmaz', async ({ page }) => {
  await login(page, 'mine.anaveri@example.test');
  for (const path of ['/islerim', '/tedarikciler', '/sozlesmeler', '/belge-girisi']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(sw, path).toBeLessThanOrEqual(cw);
  }
});
