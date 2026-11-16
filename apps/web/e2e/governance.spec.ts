// v2 Faz 1 (D93/D95): saklama, hukuki saklama ve imha onaylı kaldırma listesinde (atlanır); kiracı dışa aktarımı Yönetim > Denetim izi'nde (istek Yönetici, onay Satınalma, K-03) ve ERP mutabakatı Yönetim > Entegrasyonlar'da yeni adreslerinden sınanır.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Faz 7: ERP mutabakatı (CSV gidiş-dönüş), saklama/imha/hukuki saklama ve kiracı dışa aktarımı. Sentetik demo verisi;
// veri değiştiren adımlar yalnız 1440 projesinde. Dışa aktarım paketi için worker çalışıyor olmalı (bkz. docs/runbook.md).
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}
const logout = (page: Page) => page.getByRole('button', { name: 'Çıkış' }).first().click();
const nav = (page: Page, link: string) => page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: link }).first().click();

test('ERP mutabakatı: aktarım dosyası iner, sonuç dosyası önce denenir, yalnız tutan satır onaylanır', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  await login(page, 'ferda.finans@example.test');
  await nav(page, 'Faturalar');
  await page.getByRole('link', { name: 'ERP mutabakatı' }).click();
  await expect(page.getByRole('heading', { name: 'ERP mutabakatı' })).toBeVisible();
  await expect(page.getByText('ERP bağdaştırıcısı yapılandırılmadı')).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Aktarım dosyası (CSV)' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^erp-aktarim-.*\.csv$/);
  const lines = readFileSync(await dl.path()).toString('utf8').replace(/^﻿/, '').split('\r\n');
  const header = lines[0]!.split(';');
  expect(header).toEqual(['aktarim_anahtari', 'fatura_no', 'fatura_tarihi', 'tedarikci_vkn', 'tedarikci', 'sirket', 'para_birimi', 'net', 'odenecek', 'siparis', 'sozlesme', 'onay_tarihi']);
  const row = lines.slice(1).map((l) => l.split(';')).find((c) => c[0]?.startsWith('erp-invoice-') && !c.some((x) => x.startsWith('"')));
  test.skip(!row, 'aktarılacak onaylı fatura yok');
  const [key, invoiceNo, , , , , , , payable] = row!;
  const tag = Date.now().toString().slice(-6);
  const result = ['aktarim_anahtari;erp_kimligi;durum;odenecek;mesaj', `${key};MUH-E2E-${tag};OK;${payable};`, `yok-${tag};X;OK;1.00;`].join('\r\n');
  await page.getByLabel('Sonuç dosyası').setInputFiles({ name: 'erp-sonuc.csv', mimeType: 'text/csv', buffer: Buffer.from(result) });
  await page.getByRole('button', { name: 'Önce dene' }).click();
  await expect(page.getByText('Deneme mutabakatı hazır; henüz hiçbir kayıt değişmedi.')).toBeVisible();
  await expect(page.getByText(/Deneme sonucu · eşleşen 1/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Bilinmeyen anahtar' })).toBeVisible();
  const attention = page.locator('section', { has: page.getByRole('heading', { name: 'İlgilenilmesi gerekenler' }) });
  await expect(attention.getByRole('link', { name: invoiceNo! })).toBeVisible();
  await page.getByRole('button', { name: 'Sonuç dosyasını uygula' }).click();
  await expect(page.getByText('Sonuç dosyası uygulandı.')).toBeVisible();
  await expect(attention.getByRole('link', { name: invoiceNo! })).toHaveCount(0);
});

// v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; kaldırılan adres RemovedPage ile navigation-v2.spec.ts'de korunur
test.skip('saklama: politika dayanakla tanımlanır, imha önerisini öneren onaylayamaz, ikinci hukukçu reddeder; hukuki saklama başlar ve kalkar', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const tag = Date.now().toString().slice(-6);
  await login(page, 'leyla.hukuk@example.test');
  await nav(page, 'Veri yönetimi');
  await expect(page.getByRole('heading', { name: 'Veri yönetimi' })).toBeVisible();
  const quote = page.getByRole('row', { name: /^Teklif/ });
  await quote.getByRole('button', { name: /süresini (tanımla|düzenle)/ }).click();
  await page.getByLabel('Teklif: süre (ay)').fill('120');
  await page.getByLabel('Dayanak').fill('Kurum saklama politikası md. 4 (sentetik)');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Teklif için saklama süresi kaydedildi.')).toBeVisible();
  await expect(page.getByRole('row', { name: /^Teklif 120 ay/ })).toBeVisible();

  // İki hukukçunun da erişebildiği şirketteki bir arşiv teklifi (ret belgeyi korur; test tekrarlanabilir).
  const doc = page.getByRole('row', { name: /Arşiv teklif dosyası/ }).filter({ hasText: 'Üretim' }).first();
  const docTitle = (await doc.getByRole('checkbox').getAttribute('aria-label'))!.replace(/ seç$/, '');
  await expect(doc).toBeVisible();
  const box = doc.getByRole('checkbox');
  if (await box.isEnabled()) {
    await box.check();
    await page.getByLabel('İmha gerekçesi').fill(`Saklama süresi doldu, e2e ${tag} (sentetik).`);
    await page.getByRole('button', { name: 'Seçilen 1 belge için imha öner' }).click();
    await expect(page.getByText(/1 belge için imha önerildi/)).toBeVisible();
  }
  await page.getByRole('listitem').filter({ has: page.getByText('Onay bekliyor', { exact: true }) }).getByRole('link', { name: /1 belgelik imha partisi/ }).click();
  await expect(page.getByRole('heading', { name: 'İmha partisi' })).toBeVisible();
  await expect(page.getByText('Bu imhayı siz önerdiniz; onayı başka bir hukuk yetkilisi verir.')).toBeVisible();
  await logout(page);

  await login(page, 'kerem.hukuk@example.test');
  await nav(page, 'Veri yönetimi');
  await page.getByRole('listitem').filter({ has: page.getByText('Onay bekliyor', { exact: true }) }).getByRole('link', { name: /1 belgelik imha partisi/ }).click();
  await expect(page.getByRole('heading', { name: 'İmha partisi' })).toBeVisible();
  await expect(page.getByRole('cell', { name: new RegExp(docTitle.slice(0, 30).replace(/[()]/g, '.')) })).toBeVisible();
  await page.getByLabel('Karar notu').fill(`Sözleşme uyuşmazlığı ihtimali var, şimdilik saklansın (e2e ${tag}).`);
  await page.getByRole('button', { name: 'Reddet' }).click();
  await expect(page.getByText('İmha önerisi reddedildi.')).toBeVisible();
  await expect(page.getByText('Reddedildi').first()).toBeVisible();
  await logout(page);

  await login(page, 'leyla.hukuk@example.test');
  await nav(page, 'Veri yönetimi');
  await page.getByRole('tab', { name: 'Hukuki saklama' }).click();
  await page.getByLabel('Kapsam').selectOption('COMPANY');
  await page.getByLabel('Dosya / talep referansı').fill(`E2E-${tag}`);
  await page.getByLabel('Gerekçe').fill('Denetim talebi nedeniyle saklama (sentetik).');
  await page.getByRole('button', { name: 'Saklamayı başlat' }).click();
  await expect(page.getByText('Hukuki saklama başlatıldı; kapsamdaki belgeler imha edilemez.')).toBeVisible();
  const hold = page.getByRole('listitem').filter({ hasText: `E2E-${tag}` });
  await hold.getByRole('button', { name: 'Saklamayı kaldır' }).click();
  await page.getByLabel('Kaldırma gerekçesi').fill('Denetim kapandı (sentetik).');
  await page.getByRole('button', { name: 'Kaldır', exact: true }).click();
  await expect(page.getByText('Hukuki saklama kaldırıldı.')).toBeVisible();
  await expect(page.locator('section', { has: page.getByRole('heading', { name: 'Kaldırılanlar' }) }).getByText(`E2E-${tag}`)).toBeVisible();
});

test('dışa aktarım: yönetici ister, kendisi onaylayamaz; hukuk onaylar; paket yalnız talep edene iner', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  test.setTimeout(90_000);
  const tag = Date.now().toString().slice(-6);
  await login(page, 'tamer.yonetici@example.test');
  // v2: dışa aktarım Yönetim > Denetim izi sekmesinde.
  await page.goto('/yonetim/denetim-izi');
  await expect(page.getByRole('heading', { name: 'Talepler' })).toBeVisible();
  const reason = `Veri iadesi provası ${tag} (sentetik).`;
  await page.getByLabel('Gerekçe').fill(reason);
  await page.getByRole('button', { name: 'Dışa aktarım iste' }).click();
  // Önceki koşudan kalan bekleyen talep varsa yeni talep açılmaz (tek açık talep kuralı).
  await expect(page.getByText('Talep oluşturuldu; Satınalma onayı bekleniyor.').or(page.getByText('Bekleyen veya hazırlanan bir dışa aktarım var.'))).toBeVisible();
  await expect(page.getByText('Onayı başka bir kişi verir.').first()).toBeVisible();
  // Bu koşunun izleyeceği talep: tek açık talep (yeni ya da önceki koşudan kalan); gerekçe satırıyla tanınır.
  const pendingText = await page.getByRole('listitem').filter({ has: page.getByText('Onay bekliyor', { exact: true }) }).first().innerText();
  const pendingReason = pendingText.split('\n').find((l) => l.includes('(sentetik)'))!;
  expect(pendingReason).toBeTruthy();
  await logout(page);

  // Onay: Satınalma rolünden başka bir kişi (K-03).
  await login(page, 'leyla.hukuk@example.test');
  await page.goto('/yonetim/denetim-izi');
  const pending = page.getByRole('listitem').filter({ hasText: 'Onay bekliyor' }).first();
  await expect(pending).toBeVisible();
  await pending.getByLabel('Karar notu').fill(`Gerekçe uygun (e2e ${tag}).`);
  await pending.getByRole('button', { name: 'Onayla' }).click();
  await expect(page.getByText('Onaylandı; paket hazırlanıyor.')).toBeVisible();
  await expect(page.getByRole('button', { name: /paketi indir/ })).toHaveCount(0); // indirme yalnız talep edene
  await logout(page);

  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/denetim-izi');
  const ready = page.getByRole('listitem').filter({ hasText: pendingReason }).filter({ has: page.getByText('Hazır', { exact: true }) });
  await expect(async () => { await page.getByRole('button', { name: 'Yenile' }).click(); await expect(ready).toBeVisible({ timeout: 2000 }); }).toPass({ timeout: 60_000 });
  await expect(ready.getByText(/SHA-256/)).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), ready.getByRole('button', { name: /paketi indir/ }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^kiraci-disa-aktarim-.*\.zip$/);
  expect(readFileSync(await dl.path()).subarray(0, 2).toString()).toBe('PK');
});

test('dışa aktarım (Denetim izi) ve ERP mutabakatı yatay taşmaz (ana içerik alanı dahil)', async ({ page }) => {
  // Belge genişliği yetmez: taşma ana içerik alanının içinde de olabilir.
  const fits = () => page.evaluate(() => { const m = document.querySelector('main')!; return m.scrollWidth <= m.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1; });
  await login(page, 'leyla.hukuk@example.test');
  // v2: saklama ve hukuki saklama sekmeleri kaldırma listesinde; dışa aktarım Yönetim > Denetim izi'nde.
  await page.goto('/yonetim/denetim-izi');
  await expect(page.getByRole('heading', { name: 'Talepler' })).toBeVisible();
  expect(await fits(), 'denetim-izi').toBe(true);
  await logout(page);
  await login(page, 'ferda.finans@example.test');
  await page.goto('/yonetim/entegrasyonlar');
  await expect(page.getByRole('heading', { name: 'İlgilenilmesi gerekenler' })).toBeVisible();
  expect(await fits()).toBe(true);
});

test('kullanıcı değişince yeni kullanıcı önceki kullanıcının sayfasında açılmaz (sayfa yeniden yüklenmeden)', async ({ page }) => {
  await login(page, 'leyla.hukuk@example.test');
  await page.goto('/veri-yonetimi?sekme=disa-aktarim');
  await expect(page.getByRole('heading', { name: 'Talepler' })).toBeVisible();
  await logout(page);
  // Giriş ekranından doğrudan (page.goto yok): yönlendirici konumu sıfırlanmış olmalı.
  await page.getByRole('radio', { name: /ferda\.finans/ }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
  await expect(page.getByText(/tenant\.export\.request/)).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/islerim');
});
