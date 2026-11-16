// v2 Faz 1 (D93/D95): Yapay zekâ Yönetim sekmesine, Olaylar ve performans ağırlıkları Tedarikçiler sekmelerine taşındı; testler yeni yerlerden açar. Sorumlu rol seçicisi yalnız v2 rollerini (tekrarsız) sunar.
import { expect, test, type Page } from '@playwright/test';

// Faz 5 kritik tarayıcı görevleri: olay (UX12, T19), değerlendirme ve kritik engel (T20), raporlar (UX13), AI yönetişimi (T23). Sentetik demo verisi.
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}
const logout = (page: Page) => page.getByRole('button', { name: 'Çıkış' }).click();
/** Yapay zekâ: Yönetim > Yapay zekâ sekmesi (v2). */
async function openAi(page: Page) {
  await page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: /^Yönetim/ }).click();
  await page.getByRole('navigation', { name: 'Yönetim sekmeleri' }).getByRole('link', { name: 'Yapay zekâ' }).click();
}
async function openSupplier(page: Page, name: string, tab: string) {
  await page.getByRole('link', { name: 'Tedarikçiler' }).click();
  // Aynı ünvanlı, kimliği doğrulanmamış aday (T06) listede bulunabilir; kimliği doğrulanmış kayıt açılır (D82).
  await page.getByRole('link', { name: new RegExp(name) }).filter({ hasNotText: 'doğrulanmadı' }).click();
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
  await page.getByRole('button', { name: 'Bildir', exact: true }).click();
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
  // v2: düzeltici faaliyetin sorumlu rolü yalnız iki v2 rolü; eski kodlar aynı adla tekrar etmez.
  await expect(page.getByLabel('Sorumlu rol').locator('option')).toHaveText(['Satınalma', 'Departman kullanıcısı']);
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
  await openAi(page);
  await expect(page.getByText('Etkin AI sağlayıcısı yok')).toBeVisible();
  await expect(page.getByText('Kalite ölçümü yapılamadı (engelli)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Düzenle' })).toBeVisible();
  await logout(page);
  await login(page, 'kerem.hukuk@example.test');
  await openAi(page);
  await expect(page.getByText('Görev matrisi')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Düzenle' })).toHaveCount(0);
});

test('tedarikçi karnesi ve olay listesi yatay taşmaz; yetersiz veride puan verilmez', async ({ page }) => {
  await login(page, 'alper.satinalma@example.test');
  await openSupplier(page, 'Anadolu Bilişim', 'Performans karnesi');
  await expect(page.getByText(/performansı/).first()).toBeVisible();
  await expect(page.getByText(/Yetersiz veri|\/ 100/).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: /^Tedarikçiler/ }).click();
  await page.getByRole('navigation', { name: 'Tedarikçiler sekmeleri' }).getByRole('link', { name: 'Olaylar' }).click();
  await expect(page.getByRole('heading', { name: 'Tedarikçi olayları' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('portal anketi: kurum gönderir, tedarikçi yanıtlayıp gönderir, kurum yanıtı görür; tedarikçi inceleme görmez (Faz 5)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const scope = `Portal anketi e2e ${Date.now().toString(36)}`;
  await login(page, 'alper.satinalma@example.test');
  await openSupplier(page, 'Anadolu Bilişim', 'Değerlendirme ve risk');
  await page.getByRole('button', { name: 'Değerlendirme başlat' }).click();
  await page.getByLabel('Anket şablonu').selectOption({ index: 1 });
  await page.getByLabel('Hizmet kapsamı').fill(scope);
  await page.getByRole('button', { name: 'Başlat' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(scope);
  await page.getByRole('button', { name: 'Tedarikçiye gönder' }).click();
  await expect(page.getByText('Anket tedarikçiye gönderildi.')).toBeVisible();
  const assessmentUrl = page.url();
  await logout(page);

  await page.getByRole('radio', { name: /teklif\.anadolu/ }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Anketler' }).click();
  await page.getByRole('row', { name: new RegExp(scope) }).getByRole('link', { name: 'Yanıtla' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(scope);
  await expect(page.getByRole('button', { name: 'Kuruma gönder' })).toBeDisabled();
  const forms = page.locator('form').filter({ has: page.getByRole('button', { name: 'Yanıtı kaydet' }) });
  const total = await forms.count();
  // İlk soru "uygulanamaz": gerekçe zorunlu; diğerleri "evet".
  await forms.first().getByRole('radio', { name: 'Uygulanamaz' }).check();
  await expect(forms.first().getByRole('button', { name: 'Yanıtı kaydet' })).toBeDisabled();
  await forms.first().getByLabel('Neden uygulanamaz?').fill('Hizmet kapsamında uzak erişim yok (e2e).');
  await forms.first().getByRole('button', { name: 'Yanıtı kaydet' }).click();
  for (let left = total - 1; left > 0; left--) {
    await expect(forms).toHaveCount(left);
    await forms.first().getByRole('radio', { name: 'Evet' }).check();
    await forms.first().getByRole('button', { name: 'Yanıtı kaydet' }).click();
  }
  await expect(forms).toHaveCount(0);
  await page.getByRole('button', { name: 'Kuruma gönder' }).click();
  await page.getByRole('button', { name: 'Evet, gönder' }).click();
  await expect(page.getByText('Yanıtlarınız kuruma iletildi')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Değiştir' })).toHaveCount(0);
  await logout(page);

  await login(page, 'selin.guvenlik@example.test');
  await page.goto(assessmentUrl);
  await expect(page.getByText(/Tedarikçi yanıtları gönderdi/)).toBeVisible();
  await expect(page.getByText(/Hizmet kapsamında uzak erişim yok \(e2e\)/)).toBeVisible();
});

test('performans ağırlığı ve tasarruf bazı: yönetici kategori ağırlığını değiştirir; baz önerilir, öneren onaylayamaz (Faz 5)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const cat = `E2E kategori ${Date.now().toString(36)}`;
  await login(page, 'kerem.hukuk@example.test');
  await page.goto('/tedarikciler/performans-agirliklari');
  await page.getByRole('button', { name: 'Kategori kuralı ekle' }).click();
  await page.getByLabel('Kategori', { exact: true }).fill(cat);
  await page.getByLabel('Kalite (%)').fill('40');
  await expect(page.getByText('Toplam %110 · 100 olmalı')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yürürlüğe al' })).toBeDisabled();
  await page.getByLabel('Ticari uyum (%)').fill('5');
  await page.getByLabel('Gerekçe').fill('Kalite bu kategoride belirleyici (e2e).');
  await page.getByRole('button', { name: 'Yürürlüğe al' }).click();
  await expect(page.getByRole('row', { name: new RegExp(cat) })).toContainText('%40');
  await logout(page);

  // Taslak proje API ile (sentetik); arayüz akışı baz önerisi ve görev ayrılığı.
  const auth = async (email: string) => ({ authorization: `Bearer ${(await (await page.request.post('/api/v1/dev/token', { data: { email } })).json()).token}` });
  const buyer = await auth('alper.satinalma@example.test');
  const me = await (await page.request.get('/api/v1/me', { headers: buyer })).json();
  const proj = await (await page.request.post('/api/v1/projects', { headers: buyer, data: { companyId: me.companies[0].id, title: `Tasarruf e2e ${Date.now().toString(36)}`, category: 'BT',
    budget: '420000.00', currency: 'TRY', lines: [{ lot: 'L', description: 'Bakım', unit: 'ay', quantity: '12' }], criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } })).json();
  await login(page, 'alper.satinalma@example.test');
  await page.goto(`/projeler/${proj.id}`);
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Tasarruf bazı' }) });
  await panel.getByRole('button', { name: 'Baz öner' }).click();
  await expect(panel.getByLabel(/Baz tutarı/)).toHaveValue('420000.00');
  await panel.getByLabel('Baz türü').selectOption('MARKET');
  await panel.getByLabel(/Baz tutarı/).fill('400000.00');
  await panel.getByLabel('Kaynak').fill('Üç firmadan alınan piyasa fiyatı ortalaması (e2e).');
  await panel.getByRole('button', { name: 'Onaya gönder' }).click();
  await expect(panel.getByText('Baz onaya gönderildi.')).toBeVisible();
  await expect(panel.getByText('Onay bekliyor')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Bazı onayla' })).toHaveCount(0);
  await logout(page);
  await login(page, 'kerem.hukuk@example.test');
  await page.goto(`/projeler/${proj.id}`);
  await panel.getByRole('button', { name: 'Bazı onayla' }).click();
  await expect(panel.getByText('Baz onaylandı.')).toBeVisible();
  await expect(panel.getByText('Onaylandı', { exact: true })).toBeVisible();
});
