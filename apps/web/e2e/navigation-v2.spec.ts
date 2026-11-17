// v2 Faz 5 (D110): Yönetim'e "Tedarikçi başvurusu" (Yönetici + Satınalma, R3) ve "E-posta kutusu" (yalnız Yönetici, R7) sekmeleri eklendi; beklenen sekme listeleri bu iki sekmeyle güncellendi, diğer denetimler aynen.
// v2 Faz 3 (D108+): Yönetim > Şablonlar artık gerçek şablon kütüphanesi (Figma 12); "Faz 3'te gelir" boş durumu kalktı. Sonraki faz boş durumu denetimi Satınalma kuralları için sürer; Şablonlar sekmesinin tablosu ve yükleme alanı denetlenir.
// v2 Faz 2 (D105): Denetçi Kullanıcılar ve Entra ile Onaycılar sekmelerini salt okunur görür (directory.read, approver.read); Onaycılar artık
// gerçek ekran ("Faz 2'de gelir" boş durumu kalktı); sekme açıklaması Entra bağlantı durumunu söyler.
// v2 Faz 1 (D93/D95): yedi girişli menü, Yönetim sekmeleri, taşınan girişlerin yeni yerleri ve kaldırılan adreslerin açıklama ekranı.
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}
const menu = (page: Page) => page.getByRole('navigation', { name: 'Ana menü' });
/** Menü girişlerinin adları (bekleyen iş sayacı ayıklanır). */
async function entries(page: Page, name: string) {
  const texts = await page.getByRole('navigation', { name }).getByRole('link').allInnerTexts();
  return texts.map((t) => t.replace(/\s*\d+\s*$/, '').trim());
}
// Sayfa yeniden yüklendiyse oturum açılırken kabuk henüz çizilmemiş olabilir: önce ana içerik beklenir.
const fits = async (page: Page) => (await page.locator('main').waitFor(), page.evaluate(() => {
  const m = document.querySelector('main')!;
  return document.documentElement.scrollWidth <= window.innerWidth + 1 && m.scrollWidth <= m.clientWidth + 1;
}));

const MENU = ['İşlerim', 'Projeler', 'Sözleşmeler', 'Tedarikçiler', 'Faturalar', 'Raporlar', 'Yönetim'];
const ALL_TABS = ['Kullanıcılar ve Entra', 'Onaycılar', 'Şablonlar', 'Satınalma kuralları', 'Tedarikçi başvurusu', 'Entegrasyonlar', 'E-posta kutusu', 'Yapay zekâ', 'Denetim izi'];
const ROLES: [string, string, string[], string[] | null][] = [
  ['Yönetici', 'tamer.yonetici@example.test', MENU, ALL_TABS],
  ['Satınalma', 'leyla.hukuk@example.test', MENU, ALL_TABS.filter((t) => t !== 'E-posta kutusu')],
  ['Denetçi', 'deniz.denetci@example.test', MENU, ['Kullanıcılar ve Entra', 'Onaycılar', 'Entegrasyonlar', 'Yapay zekâ', 'Denetim izi']],
  // Departman kullanıcısı rapor okumaz (report.read) ve Yönetim'i görmez: 5 giriş.
  ['Departman kullanıcısı', 'tolga.teknik@example.test', MENU.filter((m) => m !== 'Yönetim' && m !== 'Raporlar'), null],
];

for (const [role, email, expected, tabs] of ROLES) {
  test(`menü ve Yönetim sekmeleri: ${role}`, async ({ page }, info) => {
    await login(page, email);
    expect(await entries(page, 'Ana menü')).toEqual(expected);
    if (info.project.name !== 'narrow-390') {
      // Rol adı Türkçe görünür; ham rol kodu görünmez.
      const side = page.getByRole('complementary').first();
      await expect(side).toContainText(role);
      await expect(side).not.toContainText(/ADMIN|PROCUREMENT|DEPARTMENT_USER|AUDITOR|TENANT_ADMIN|BUYER|LEGAL|FINANCE/);
    }
    expect(await fits(page)).toBe(true);
    if (!tabs) {
      await page.goto('/yonetim');
      await expect(page.getByRole('heading', { name: 'Yönetim bölümü rolünüze açık değil' })).toBeVisible();
      return;
    }
    await menu(page).getByRole('link', { name: /^Yönetim/ }).click();
    await expect(page.getByRole('navigation', { name: 'Yönetim sekmeleri' })).toBeVisible();
    expect(await entries(page, 'Yönetim sekmeleri')).toEqual(tabs);
    // İlk görünen sekme açılır; rolün göremediği sekme adresi ilk sekmeye döner.
    await expect(page).toHaveURL(tabs[0] === 'Kullanıcılar ve Entra' ? /\/yonetim\/kullanicilar$/ : /\/yonetim\/entegrasyonlar$/);
    await page.goto('/yonetim/kullanicilar');
    await expect(page).toHaveURL(tabs.includes('Kullanıcılar ve Entra') ? /\/yonetim\/kullanicilar$/ : /\/yonetim\/entegrasyonlar$/);
    await expect(page.getByRole('navigation', { name: 'Yönetim sekmeleri' })).toBeVisible();
    expect(await fits(page)).toBe(true);
  });
}

test('Yönetim: departmanlar ve sonraki fazların boş durumları', async ({ page }) => {
  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/kullanicilar');
  await expect(page.getByRole('heading', { name: 'Kullanıcılar ve Entra', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Departmanlar' })).toBeVisible();
  await expect(page.getByText('Bilgi Teknolojileri').first()).toBeVisible();
  await expect(page.getByLabel('Departman adı')).toBeVisible();
  await expect(page.getByText(/Entra bağlantısı yapılandırılmadı|Microsoft Entra ID'den alınır/).first()).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Yönetim sekmeleri' });
  await tabs.getByRole('link', { name: 'Onaycılar' }).click();
  await expect(page.getByRole('heading', { name: 'Onaycılar', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Departman sorumluları' })).toBeVisible();
  await tabs.getByRole('link', { name: 'Şablonlar' }).click();
  await expect(page.getByRole('heading', { name: 'Şablonlar', level: 1 })).toBeVisible();
  await expect(page.getByText(/Faz 3'te gelir/)).toHaveCount(0);
  await expect(page.getByText('Yeni şablon ya da yeni sürüm için .docx dosyasını buraya bırakın')).toBeVisible();
  for (const [tab, phase] of [['Satınalma kuralları', 'Faz 7']] as const) {
    await tabs.getByRole('link', { name: tab }).click();
    await expect(page.getByRole('heading', { name: tab, level: 1 })).toBeVisible();
    await expect(page.getByText(new RegExp(phase)).first()).toBeVisible();
    // Sahte denetim yok (üst çubuktaki bildirim zili sayfa içeriği değildir).
    await expect(page.locator('main .page').getByRole('button')).toHaveCount(0);
  }
  await tabs.getByRole('link', { name: 'Denetim izi' }).click();
  await expect(page.getByRole('heading', { name: 'Denetim izi', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Kayıt kimliği')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Talepler' })).toBeVisible();
  expect(await fits(page)).toBe(true);
});

test('Yönetim: Satınalma departman ekleyemez; Denetçi yalnız okur', async ({ page }) => {
  await login(page, 'leyla.hukuk@example.test');
  await page.goto('/yonetim/kullanicilar');
  await expect(page.getByRole('heading', { name: 'Departmanlar' })).toBeVisible();
  await expect(page.getByText('Bilgi Teknolojileri').first()).toBeVisible();
  await expect(page.getByLabel('Departman adı')).toHaveCount(0);
  await page.goto('/yonetim/denetim-izi');
  await expect(page.getByRole('heading', { name: 'Talepler' })).toBeVisible();
  await expect(page.getByLabel('Kayıt kimliği')).toHaveCount(0);
  await page.getByRole('button', { name: 'Çıkış' }).first().click();
  await login(page, 'deniz.denetci@example.test');
  await page.goto('/yonetim/yapay-zeka');
  await expect(page.getByRole('heading', { name: 'Yapay zekâ', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Düzenle' })).toHaveCount(0);
});

test('eski adresler yeni yerine yönlenir', async ({ page }) => {
  await login(page, 'leyla.hukuk@example.test');
  const id = '00000000-0000-4000-8000-000000000000';
  const cases: [string, RegExp, string | null][] = [
    ['/yapay-zeka', /\/yonetim\/yapay-zeka$/, 'Yapay zekâ'],
    ['/faturalar/erp-mutabakati', /\/yonetim\/entegrasyonlar$/, 'ERP mutabakatı'],
    ['/olaylar', /\/tedarikciler\/olaylar$/, 'Tedarikçi olayları'],
    [`/olaylar/${id}`, new RegExp(`/tedarikciler/olaylar/${id}$`), null],
    ['/anketler', /\/tedarikciler\/anketler$/, 'Anket şablonları'],
    ['/performans-agirliklari', /\/tedarikciler\/performans-agirliklari$/, 'Performans ağırlıkları'],
    ['/belge-girisi', /\/sozlesmeler\/ekle$/, 'Sözleşme ekle'],
    ['/yonetim', /\/yonetim\/kullanicilar$/, 'Kullanıcılar ve Entra'],
    ['/veri-yonetimi?sekme=disa-aktarim', /\/yonetim\/denetim-izi$/, 'Denetim izi'],
  ];
  for (const [from, to, heading] of cases) {
    await page.goto(from);
    await expect(page, from).toHaveURL(to);
    if (heading) await expect(page.getByRole('heading', { name: heading, level: 1 }), from).toBeVisible();
  }
});

test('kaldırılan adresler açıklama ekranını gösterir', async ({ page }) => {
  await login(page, 'leyla.hukuk@example.test');
  const id = '00000000-0000-4000-8000-000000000000';
  for (const path of ['/lira-defteri', `/lira-defteri/${id}`, '/siparisler', `/siparisler/${id}`, '/faturalar/tolerans', '/projeler/onay-politikasi', '/veri-yonetimi', `/veri-yonetimi/imha/${id}`]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Bu işlev kaldırıldı', level: 1 }), path).toBeVisible();
    await expect(page.getByText('Bu işlev v2 sadeleştirmesinde kaldırıldı. Kayıtlar silinmedi; geçmiş veriler denetim izinde ve dışa aktarımda durur.'), path).toBeVisible();
    await expect(page.getByText('Sayfa bulunamadı')).toHaveCount(0);
  }
  await page.getByRole('link', { name: "İşlerim'e dön" }).click();
  await expect(page).toHaveURL(/\/islerim$/);
});

test('taşınan girişler: Tedarikçiler sekmeleri, Sözleşme ekle ve Fatura yükle', async ({ page }) => {
  await login(page, 'leyla.hukuk@example.test');
  await menu(page).getByRole('link', { name: /^Tedarikçiler/ }).click();
  const tabs = page.getByRole('navigation', { name: 'Tedarikçiler sekmeleri' });
  // Sekme çubuğu çizilmeden okunmaz (allInnerTexts beklemez; dar ekranda sayfa geçişi yavaş).
  await expect(tabs.getByRole('link', { name: 'Liste' })).toBeVisible();
  expect(await entries(page, 'Tedarikçiler sekmeleri')).toEqual(['Liste', 'Olaylar', 'Anketler', 'Performans ağırlıkları']);
  await tabs.getByRole('link', { name: 'Olaylar' }).click();
  await expect(page).toHaveURL(/\/tedarikciler\/olaylar$/);
  await expect(page.getByRole('heading', { name: 'Tedarikçi olayları' })).toBeVisible();
  await expect(menu(page).getByRole('link', { name: /^Tedarikçiler/ })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: 'Anketler' }).click();
  await expect(page.getByRole('heading', { name: 'Anket şablonları' })).toBeVisible();
  await tabs.getByRole('link', { name: 'Performans ağırlıkları' }).click();
  await expect(page.getByRole('heading', { name: 'Performans ağırlıkları', level: 1 })).toBeVisible();
  expect(await fits(page)).toBe(true);

  await menu(page).getByRole('link', { name: /^Sözleşmeler/ }).click();
  await page.getByRole('link', { name: 'Sözleşme ekle' }).click();
  await expect(page).toHaveURL(/\/sozlesmeler\/ekle$/);
  await expect(page.getByRole('heading', { name: 'Sözleşme ekle', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Belge türü')).toHaveValue('CONTRACT');
  // K-05: teklif ve diğer türler kalır; tür seçimi görünür.
  await expect(page.getByLabel('Belge türü').locator('option')).toHaveText(['Fatura', 'Sözleşme', 'Teklif', 'Diğer']);

  await menu(page).getByRole('link', { name: /^Faturalar/ }).click();
  await page.getByRole('link', { name: 'Fatura yükle' }).click();
  await expect(page).toHaveURL(/\/faturalar\/yukle$/);
  await expect(page.getByRole('heading', { name: 'Fatura yükle', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Belge türü')).toHaveValue('INVOICE');
  await page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: /^Sözleşmeler/ }).click();
  await page.getByRole('link', { name: 'Sözleşme ekle' }).click();
  await expect(page.getByLabel('Belge türü')).toHaveValue('CONTRACT');
});

test('Yönetim: Yönetici departman kullanıcısına departman atar; yenileyince kalır', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/kullanicilar');
  const selin = page.getByRole('group', { name: 'Selin Arslan departmanları' });
  const ik = selin.getByRole('checkbox', { name: 'İnsan Kaynakları' });
  await expect(selin.getByRole('checkbox', { name: 'Bilgi Teknolojileri' })).toBeChecked();
  // Tüm departmanları gören roller düzenlenmez; tedarikçi kullanıcısı listede yok.
  await expect(page.getByRole('group', { name: 'Leyla Demir departmanları' })).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'Leyla Demir' })).toContainText('Tüm departmanlar');
  await expect(page.getByRole('listitem').filter({ hasText: 'Leyla Demir' })).toContainText('Satınalma');
  await expect(page.getByText('Anadolu Bilişim Teklif Sorumlusu')).toHaveCount(0);
  const save = page.getByRole('button', { name: 'Selin Arslan departmanlarını kaydet' });
  const before = await ik.isChecked();
  await ik.setChecked(!before);
  await save.click();
  await expect(selin.getByText('Departmanlar kaydedildi.')).toBeVisible();
  await page.reload();
  await expect(ik).toBeChecked({ checked: !before });
  // Sentetik veriyi eski haline getir.
  await ik.setChecked(before);
  await save.click();
  await expect(selin.getByText('Departmanlar kaydedildi.')).toBeVisible();
  await page.reload();
  await expect(ik).toBeChecked({ checked: before });
});

// Düzeltme dalgası (Y5): Departman kullanıcısı /raporlar adresini yazarsa standart "rolünüze açık değil" ekranı; yarım sayfa
// (tarih süzgeci, CSV düğmesi) ve 403 isteği yok.
test('Departman kullanıcısı /raporlar: rolünüze açık değil ekranı', async ({ page }) => {
  const reportCalls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/v1/reports/')) reportCalls.push(r.url()); });
  await login(page, 'tolga.teknik@example.test');
  await page.goto('/raporlar');
  await expect(page.getByText('Raporlar rolünüze açık değil')).toBeVisible();
  await expect(page.getByRole('link', { name: "İşlerim'e dön" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'CSV indir' })).toHaveCount(0);
  await expect(page.getByLabel('Dönem başı')).toHaveCount(0);
  expect(reportCalls).toEqual([]);
  expect(await fits(page)).toBe(true);
});
