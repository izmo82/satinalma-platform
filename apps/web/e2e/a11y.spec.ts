// v2 Faz 1 (D93/D95): taşınan girişler yeni yerlerinden açılır (Olaylar → Tedarikçiler sekmesi, ERP mutabakatı → Yönetim > Entegrasyonlar, performans ağırlıkları → Tedarikçiler sekmesi). Kaldırılan ekranların senaryoları Görev 6'da.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Hareket azaltma tercihiyle: renk geçişi ortasında ölçüm yapılmaz (uygulama prefers-reduced-motion'a uyar).
test.use({ reducedMotion: 'reduce' });

// Faz 6 / T41: kritik ekranlarda otomatik erişilebilirlik denetimi (axe, WCAG 2.2 AA kuralları). Otomatik denetim gerçek ekran okuyucu
// oturumunun yerine geçmez; ciddi/kritik ihlal sıfır olmalıdır.
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
const nav = (page: Page, link: string) => page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: link }).first().click();

test('satınalma: işlerim, siparişler, tedarikçi sekmeleri, olaylar', async ({ page }) => {
  await login(page, 'alper.satinalma@example.test');
  await audit(page, 'İşlerim');
  await nav(page, 'Siparişler');
  await expect(page.getByRole('heading', { name: 'Siparişler' })).toBeVisible();
  await audit(page, 'Siparişler');
  await page.getByRole('table').getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('PO-');
  await audit(page, 'Sipariş detayı');
  await nav(page, 'Tedarikçiler');
  // Aynı ünvanlı, kimliği doğrulanmamış aday (T06) listede bulunabilir; kimliği doğrulanmış kayıt açılır (D82).
  await page.getByRole('link', { name: /Anadolu Bilişim/ }).filter({ hasNotText: 'doğrulanmadı' }).click();
  for (const tab of ['Değerlendirme ve risk', 'Olaylar', 'Performans karnesi']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForLoadState('networkidle');
    await audit(page, `Tedarikçi · ${tab}`);
  }
  await nav(page, 'Tedarikçiler');
  await page.getByRole('navigation', { name: 'Tedarikçiler sekmeleri' }).getByRole('link', { name: 'Olaylar' }).click();
  await expect(page.getByRole('heading', { name: 'Tedarikçi olayları' })).toBeVisible();
  await audit(page, 'Olaylar');
});

test('finans: faturalar, fatura detayı, raporlar', async ({ page }) => {
  await login(page, 'nur.finansonay@example.test');
  await nav(page, 'Faturalar');
  await expect(page.getByRole('heading', { name: 'Faturalar' })).toBeVisible();
  await audit(page, 'Faturalar');
  await page.getByRole('link', { name: 'ANB2026000102' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('ANB2026000102');
  await audit(page, 'Fatura detayı');
  await nav(page, 'Raporlar');
  await expect(page.getByText('Fatura istisna oranı')).toBeVisible();
  await audit(page, 'Raporlar');
});

test('hukuk: sözleşme imza çalışma alanı', async ({ page }) => {
  await login(page, 'leyla.hukuk@example.test');
  await nav(page, 'Sözleşmeler');
  await page.getByRole('link', { name: 'Nakliye Hizmet Sözleşmesi' }).first().click();
  await expect(page.getByRole('heading', { name: 'Nakliye Hizmet Sözleşmesi' })).toBeVisible();
  await audit(page, 'İmza çalışma alanı');
  await page.getByRole('tablist', { name: 'Sözleşme' }).getByRole('tab', { name: 'Fiyat, SLA ve teminat' }).click();
  await expect(page.getByRole('heading', { name: 'Fiyat revizyonu', exact: true })).toBeVisible();
  await audit(page, 'Fiyat, SLA ve teminat');
});

test('onay politikası ve proje istisnaları (Faz 2)', async ({ page }) => {
  await login(page, 'kerem.hukuk@example.test');
  await page.goto('/projeler/onay-politikasi');
  await expect(page.getByRole('heading', { name: 'Onay politikası' })).toBeVisible();
  await page.getByRole('button', { name: 'Yeni sürüm hazırla' }).click();
  await expect(page.getByRole('heading', { name: 'Yeni sürüm taslağı' })).toBeVisible();
  await audit(page, 'Onay politikası');
});

test('veri yönetimi ve ERP mutabakatı (Faz 7)', async ({ page }) => {
  await login(page, 'leyla.hukuk@example.test');
  await nav(page, 'Veri yönetimi');
  await expect(page.getByRole('heading', { name: 'Saklama politikası' })).toBeVisible();
  await audit(page, 'Veri yönetimi · saklama');
  await page.getByRole('tab', { name: 'Hukuki saklama' }).click();
  await audit(page, 'Veri yönetimi · hukuki saklama');
  await page.getByRole('tab', { name: 'Dışa aktarım' }).click();
  await expect(page.getByRole('heading', { name: 'Talepler' })).toBeVisible();
  await audit(page, 'Veri yönetimi · dışa aktarım');
  await page.getByRole('button', { name: 'Çıkış' }).first().click();
  await login(page, 'ferda.finans@example.test');
  await page.goto('/yonetim/entegrasyonlar');
  await expect(page.getByRole('heading', { name: 'Durum ve toplamlar' })).toBeVisible();
  await audit(page, 'ERP mutabakatı');
});

test('Faz 5: tedarikçi anket listesi/yanıt ekranı ve performans ağırlıkları', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: /teklif\.anadolu/ }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await nav(page, 'Anketler');
  await expect(page.getByRole('heading', { name: 'Anketler' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await audit(page, 'Portal anketler');
  const open = page.getByRole('table').getByRole('link').first();
  if (await open.count()) {
    await open.click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await audit(page, 'Portal anket yanıtı');
  }
  await page.getByRole('button', { name: 'Çıkış' }).click();
  await login(page, 'kerem.hukuk@example.test');
  await page.goto('/tedarikciler/performans-agirliklari');
  await expect(page.getByRole('heading', { name: 'Performans ağırlıkları' })).toBeVisible();
  await page.getByRole('button', { name: 'Kategori kuralı ekle' }).click();
  await audit(page, 'Performans ağırlıkları');
});

test('Lira Defteri: özet, bulgular, kanıtsız harcama, ayarlar ve vaka ayrıntısı (D80)', async ({ page }) => {
  await login(page, 'ferda.finans@example.test');
  await nav(page, 'Lira Defteri');
  await expect(page.getByRole('heading', { name: 'Lira Defteri' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await audit(page, 'Lira Defteri');
  for (const tab of ['Kanıtsız harcama', 'Kur ve ayarlar']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForLoadState('networkidle');
    await audit(page, `Lira Defteri · ${tab}`);
  }
  await page.getByRole('tab', { name: 'Geri alınacak para' }).click();
  await page.getByRole('table').getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('GRK-');
  await audit(page, 'Geri kazanım vakası');
});
