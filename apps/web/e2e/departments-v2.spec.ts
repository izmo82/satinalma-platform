// v2 Faz 1 (D93): departman alanı ve süzgeci. Departman kullanıcısı yalnız kendi departmanını seçer (tek seçenek önceden seçili);
// Satınalma süzgeçte bütün departmanları görür; süzgeç adreste durur, yeniden yüklemede korunur. Veri değiştiren adım yalnız 1440'ta.
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}
const DEPARTMENTS = ['Bilgi Teknolojileri', 'Tıbbi Cihaz', 'İnsan Kaynakları'];

test('departman kullanıcısı proje açar: yalnız kendi departmanı sunulur ve önceden seçilidir; proje başlığında departman görünür', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const title = `E2E departman projesi ${Date.now().toString(36)}`;
  await login(page, 'tolga.teknik@example.test');
  await page.goto('/projeler/yeni');
  const dept = page.getByLabel('Departman');
  await expect(dept.locator('option')).toHaveText(['Bilgi Teknolojileri']);
  await expect(dept).toHaveValue(/.+/);
  await page.getByLabel('Proje adı').fill(title);
  await page.getByLabel('Kategori').fill('BT hizmetleri');
  await page.getByRole('button', { name: 'Devam' }).click();
  await page.getByRole('textbox', { name: 'Kalem 1', exact: true }).fill('Sunucu bakımı');
  await page.getByLabel('Birim').fill('ay');
  await page.getByLabel('Miktar').fill('12');
  await page.getByRole('button', { name: 'Devam' }).click();
  await page.getByLabel('Bütçe', { exact: true }).fill('120000');
  await page.getByRole('button', { name: 'Devam' }).click();
  await page.getByRole('button', { name: 'Devam' }).click();
  await expect(page.getByText('Bilgi Teknolojileri')).toBeVisible();
  await page.getByRole('button', { name: 'Projeyi oluştur' }).click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await expect(page.getByText('Departman: Bilgi Teknolojileri')).toBeVisible();
});

test('sihirbaz: departman seçilmeden ilerlenmez (Satınalma, tüm departmanlar sunulur)', async ({ page }) => {
  await login(page, 'alper.satinalma@example.test');
  await page.goto('/projeler/yeni');
  const dept = page.getByLabel('Departman');
  await expect(dept.locator('option')).toHaveCount(DEPARTMENTS.length + 1);
  await expect(dept.locator('option').first()).toHaveText('Seçin');
  for (const d of DEPARTMENTS) await expect(dept.locator('option', { hasText: d })).toHaveCount(1);
  await dept.selectOption('');
  await page.getByLabel('Proje adı').fill('E2E sentetik proje');
  await page.getByLabel('Kategori').fill('Test');
  await page.getByRole('button', { name: 'Devam' }).click();
  await expect(page.getByText('Formda düzeltilecek alanlar var')).toBeVisible();
  await expect(dept).toBeFocused();
  await page.getByRole('button', { name: 'Taslağı at' }).click();
});

test('Projeler: departman sütunu; süzgeç adreste durur ve yeniden yüklemede korunur', async ({ page }) => {
  await login(page, 'alper.satinalma@example.test');
  await page.goto('/projeler');
  const filter = page.getByRole('group', { name: 'Departman süzgeci' });
  for (const d of ['Tüm departmanlar', ...DEPARTMENTS]) await expect(filter.getByRole('button', { name: d, exact: true })).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) > 640) await expect(page.getByRole('columnheader', { name: 'Departman' })).toBeVisible();
  await filter.getByRole('button', { name: 'Bilgi Teknolojileri', exact: true }).click();
  await expect(page).toHaveURL(/departmentId=[0-9a-f-]{36}/);
  await page.reload();
  await expect(page.getByRole('group', { name: 'Departman süzgeci' }).getByRole('button', { name: 'Bilgi Teknolojileri', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Satırlar (tablo ya da dar ekran listesi) yalnız seçilen departmanın kayıtları; süzgeç çiplerindeki adlar sayılmaz.
  const list = page.locator('main table, main ul[aria-label="Projeler"]').filter({ visible: true });
  await expect(list.getByText('Bilgi Teknolojileri').first()).toBeVisible();
  await expect(list.getByText(/^(Departmansız|İnsan Kaynakları|Tıbbi Cihaz)$/)).toHaveCount(0);
});

test('Sözleşmeler ve Faturalar: departman sütunu ve süzgeci; Satınalma bütün departmanları görür', async ({ page }) => {
  await login(page, 'leyla.hukuk@example.test');
  const wide = (page.viewportSize()?.width ?? 0) > 640;
  for (const path of ['/sozlesmeler', '/faturalar']) {
    await page.goto(path);
    const filter = page.getByRole('group', { name: 'Departman süzgeci' });
    for (const d of DEPARTMENTS) await expect(filter.getByRole('button', { name: d, exact: true })).toBeVisible();
    if (wide || path === '/faturalar') await expect(page.getByRole('columnheader', { name: 'Departman' }).first()).toBeVisible();
    await filter.getByRole('button', { name: 'Bilgi Teknolojileri', exact: true }).click();
    await expect(page).toHaveURL(/departmentId=/);
    await page.reload();
    await expect(page.getByRole('group', { name: 'Departman süzgeci' }).getByRole('button', { name: 'Bilgi Teknolojileri', exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
});

test('departman kullanıcısı: tek departmanda süzgeç gösterilmez; listede yalnız kendi departmanının kayıtları', async ({ page }) => {
  await login(page, 'tolga.teknik@example.test');
  await page.goto('/projeler');
  await expect(page.getByRole('heading', { name: 'Projeler', level: 1 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Departman süzgeci' })).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main table, main ul[aria-label="Projeler"]').getByText(/^(Departmansız|İnsan Kaynakları|Tıbbi Cihaz)$/)).toHaveCount(0);
});
