// v2 Faz 1 (D93/D95): onaylı kaldırma listesindeki işlevlere dışarıdan gelen bağlantılar (envanter §6) sayfalardan çıktı; ölü bağlantı kalmadı.
// Kalanlar yerinde: Fatura gir, XML yükleme, UBL denetimi, sözleşmeye tahsis, limit paneli. Demo faturalar yalnız okunur (değiştirilmez).
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}
/** Kaldırılan ekranlara giden her bağlantı (sipariş, Lira Defteri, veri yönetimi, tolerans, onay politikası). */
const REMOVED = 'a[href^="/siparisler"], a[href^="/lira-defteri"], a[href^="/veri-yonetimi"], a[href="/faturalar/tolerans"], a[href^="/projeler/onay-politikasi"]';
const noRemovedLinks = async (page: Page, where: string) => {
  await page.locator('main').waitFor();
  expect(await page.locator(REMOVED).count(), where).toBe(0);
};

test('Projeler: onay politikası düğmesi yok (Yönetici, Satınalma, Departman kullanıcısı)', async ({ page }) => {
  for (const email of ['tamer.yonetici@example.test', 'alper.satinalma@example.test', 'tolga.teknik@example.test']) {
    await login(page, email);
    await page.goto('/projeler');
    await expect(page.getByRole('heading', { name: 'Projeler', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Onay politikası' })).toHaveCount(0);
    await noRemovedLinks(page, `/projeler · ${email}`);
    await page.getByRole('button', { name: 'Çıkış' }).first().click();
  }
});

test('İşlerim: Lira Defteri, imha ve kaldırılan fatura bulgularının görevleri listelenmez; görev bağlantısı kaldırılan ekrana gitmez', async ({ page }) => {
  await login(page, 'ferda.finans@example.test');
  for (const view of ['Benden beklenen', 'Geciken', 'Rolümdeki tüm işler']) {
    await page.getByRole('tab', { name: new RegExp(view) }).click();
    await expect(page.getByRole('tab', { name: new RegExp(view) })).toHaveAttribute('aria-selected', 'true');
    await page.waitForLoadState('networkidle');
    await noRemovedLinks(page, `İşlerim · ${view}`);
    // Kaldırılan bulguların (kabul, sipariş, tolerans, sözleşmesiz istisna) görevleri listelenmez; korunan bulguların görevleri kalır
    // (API testi: invoiceIssueTasks). Görev başlığı bulgu mesajının ilk bölümüdür.
    await expect(page.locator('a[href^="/faturalar/"]').filter({ hasText: /kabul kaydı yok|sipariş miktarını|birim fiyat .*sipariş|sipariş birimi|siparişi iptal|sözleşme bağı yok/ })).toHaveCount(0);
    await expect(page.getByText(/finansa bildirin|istisna isteyin/i)).toHaveCount(0);
  }
});

test('Faturalar listesi: tolerans bağlantısı ve onay durumu süzgeci yok; eşleşme süzgeci var', async ({ page }) => {
  await login(page, 'ferda.finans@example.test');
  await page.goto('/faturalar');
  await expect(page.getByRole('heading', { name: 'Faturalar', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tolerans kuralları' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Onay durumu süzgeci' })).toHaveCount(0);
  for (const old of ['Karar bekliyor', 'Onaylandı', 'Engelli']) await expect(page.getByRole('button', { name: new RegExp(`^${old}`) })).toHaveCount(0);
  const match = page.getByRole('group', { name: 'Eşleşme süzgeci' });
  await expect(match.getByRole('button', { name: /^Eşleşmedi/ })).toBeVisible();
  await expect(match.getByRole('button', { name: /^Eşleşti/ })).toBeVisible();
  // Kalan işlevler yerinde.
  await expect(page.getByRole('button', { name: 'Fatura gir' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Fatura yükle' })).toBeVisible();
  await expect(page.getByText(/finans/i)).toHaveCount(0);
  await noRemovedLinks(page, '/faturalar');
});

test('Fatura detayı: onay, ret ve istisna denetimi yok; eski sipariş bağı numarasıyla metin olarak görünür (ANB2026000102, salt okunur)', async ({ page }) => {
  await login(page, 'nur.finansonay@example.test');
  await page.goto('/faturalar');
  await page.getByRole('link', { name: 'ANB2026000102' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('ANB2026000102');
  for (const b of ['Finans onayı', 'Reddet', 'İstisnayı onayla']) await expect(page.getByRole('button', { name: b })).toHaveCount(0);
  await expect(page.getByText(/İstisna gerekli|Onaya hazır|finans onayı bekliyor/)).toHaveCount(0);
  await expect(page.getByText(/kabul kaydı yok/)).toHaveCount(0); // üçlü eşleştirme bulgusu
  await expect(page.getByText(/Sipariş PO-\d{4}-\d+/).first()).toBeVisible();
  await expect(page.getByText(/finans/i)).toHaveCount(0);
  // Sözleşme limiti paneli ve UBL denetimi kalır.
  await expect(page.getByText('Kullanılabilir')).toBeVisible();
  await noRemovedLinks(page, 'fatura detayı');
  // Tahsis düzenleyicide sipariş kalemi yükleme yok. Düzeltme dalgası (I4): eski sipariş bağı kendi numarasıyla seçili kalır; kaldırılabilir
  // ya da sözleşmeye taşınabilir, yeni sipariş seçeneği yoktur (önce salt okunur metindi). Kaydedilmeden kapatılır (demo fatura değişmez).
  await page.getByRole('button', { name: 'Tahsisi düzenle' }).click();
  await expect(page.getByRole('button', { name: /kalemlerini yükle/ })).toHaveCount(0);
  const target = page.getByLabel('Satır 1 hedef');
  await expect(target.locator('option:checked')).toHaveText(/^Sipariş PO-\d{4}-\d+.*\(eski sipariş bağı\)$/);
  await expect(target.locator('option', { hasText: 'Bağı kaldır' })).toHaveCount(1);
  expect((await target.locator('option').allInnerTexts()).filter((o) => o.startsWith('Sipariş ')).length).toBe(1);
  await page.getByRole('button', { name: 'Vazgeç' }).click();
});

test('Arama ve olay detayı: sipariş sonuç grubu ve sipariş bağlantısı yok', async ({ page }) => {
  await login(page, 'alper.satinalma@example.test');
  await page.goto('/ara?q=PO-');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('PO-');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Siparişler' })).toHaveCount(0);
  await noRemovedLinks(page, 'arama');
  await page.goto('/tedarikciler/olaylar');
  await expect(page.getByRole('heading', { name: 'Tedarikçi olayları' })).toBeVisible();
  const first = page.getByRole('table').getByRole('link').first();
  if (await first.count()) {
    await first.click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await noRemovedLinks(page, 'olay detayı');
  }
});

test('Belge detayı: satıcı kimliği formunda IBAN alanı yok (banka değişikliği doğrulaması kaldırma listesinde, W-15-08)', async ({ page }) => {
  await login(page, 'leyla.hukuk@example.test');
  await page.getByRole('tab', { name: /Rolümdeki tüm işler/ }).click();
  await page.getByRole('link', { name: 'Fatura alanları girilmeli' }).filter({ visible: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Satıcı kimliğini girin' })).toBeVisible();
  await expect(page.getByLabel('Vergi kimliği')).toBeVisible();
  await expect(page.getByLabel(/IBAN/)).toHaveCount(0);
  await expect(page.getByText(/doğrulama görevi açılır/)).toHaveCount(0);
});
