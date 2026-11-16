// v2 Faz 1 düzeltme dalgası (C1, D96): Yönetim > Kullanıcılar ve Entra > Departmansız kayıtlar. Satınalma departmansız eski kayda
// departman atar; atanan departmanın kullanıcısı kaydı görür. Yönetici'nin şirket kapsamı yok (kullanıcı kararı): dürüst açıklama görür.
// Veri değiştiren adım yalnız 1440'ta; yeni sentetik proje oluşturur, mevcut kayda dokunmaz.
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}
const logout = (page: Page) => page.getByRole('button', { name: 'Çıkış' }).first().click();
const fits = async (page: Page) => (await page.locator('main').waitFor(), page.evaluate(() => {
  const m = document.querySelector('main')!;
  return document.documentElement.scrollWidth <= window.innerWidth + 1 && m.scrollWidth <= m.clientWidth + 1;
}));

test('Satınalma departmansız projeyi BT\'ye atar; BT departman kullanıcısı projeyi açar', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const auth = async (email: string) => ({ authorization: `Bearer ${(await (await page.request.post('/api/v1/dev/token', { data: { email } })).json()).token}` });
  const buyer = await auth('kerem.hukuk@example.test');
  const me = await (await page.request.get('/api/v1/me', { headers: buyer })).json();
  const title = `E2E departmansız proje ${Date.now().toString(36)} (SENTETİK)`;
  const created = await page.request.post('/api/v1/projects', { headers: buyer, data: { companyId: me.companies[0].id, title, category: 'Eğitim',
    budget: '1000.00', currency: 'TRY', lines: [{ lot: 'L', description: 'Eğitim', unit: 'gün', quantity: '1' }], criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } });
  expect(created.status()).toBe(201);
  const proj = await created.json();

  await login(page, 'selin.guvenlik@example.test');
  await page.goto(`/projeler/${proj.id}`);
  await expect(page.getByText('Kayıt bulunamadı veya erişim yetkiniz yok').first()).toBeVisible();
  await logout(page);

  await login(page, 'kerem.hukuk@example.test');
  await page.goto('/yonetim/kullanicilar');
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Departmansız kayıtlar' }) });
  await expect(section.getByRole('heading', { name: /^Projeler/ })).toBeVisible();
  const projects = section.locator('section').filter({ has: page.getByRole('heading', { name: /^Projeler/ }) });
  await projects.getByRole('checkbox', { name: new RegExp(title.replace(/[()]/g, '\\$&')) }).check();
  await projects.getByRole('combobox', { name: /^Departman/ }).selectOption({ label: 'Bilgi Teknolojileri' });
  await projects.getByRole('button', { name: 'Departman ata (1)' }).click();
  await expect(projects.getByText('1 proje Bilgi Teknolojileri departmanına atandı.')).toBeVisible();
  await expect(projects.getByRole('checkbox', { name: new RegExp(title.replace(/[()]/g, '\\$&')) })).toHaveCount(0);
  await logout(page);

  await login(page, 'selin.guvenlik@example.test');
  await page.goto(`/projeler/${proj.id}`);
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await expect(page.getByText('Departman: Bilgi Teknolojileri')).toBeVisible();
});

test('Departmansız kayıtlar: Satınalma listeyi görür; Yönetici şirket kapsamı açıklamasını görür; sayfa taşmaz', async ({ page }) => {
  await login(page, 'kerem.hukuk@example.test');
  await page.goto('/yonetim/kullanicilar');
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Departmansız kayıtlar' }) });
  for (const h of [/^Projeler/, /^Sözleşmeler/, /^Tedarikçi değerlendirmeleri/]) await expect(section.getByRole('heading', { name: h })).toBeVisible();
  // Satınalma kullanıcı listesi Yönetici listesiyle aynı kapsamda: tedarikçi portalı kullanıcıları yok (Y4).
  await expect(page.getByText('Teklif Sorumlusu')).toHaveCount(0);
  await expect(page.getByText('Tedarikçi kullanıcıları bu listede yer almaz.')).toBeVisible();
  expect(await fits(page)).toBe(true);
  await logout(page);

  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/kullanicilar');
  await expect(page.getByText('Yönetici rolünün şirket kapsamı yok')).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Tedarikçi değerlendirmeleri/ })).toBeVisible();
  expect(await fits(page)).toBe(true);
});
