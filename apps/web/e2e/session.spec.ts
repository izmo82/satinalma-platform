import { expect, test, type Page } from '@playwright/test';

// Web oturumu sunucuda (BFF, D78): çerez sekmeler arasında ortak. Bir sekmede kullanıcı değişince öteki sekme eski kullanıcının
// adıyla yeni kullanıcının verisini göstermemeli; çıkıştan sonraki giriş önceki kullanıcının sayfasına inmemeli.
async function login(page: Page, email: string) {
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
}
const sidebarUser = (page: Page) => page.getByRole('complementary').first();

test('tarayıcıda token yok; çıkış + Geri sonrası başka kullanıcı İşlerim\'e iner; öteki sekme kullanıcı değişince kendini yeniler', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'oturum akışı tek projede yeterli');
  await page.goto('/');
  await login(page, 'alper.satinalma@example.test');
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
  expect(await page.evaluate(() => ({ s: Object.keys(sessionStorage).filter((k) => /token|oidc/i.test(k)), c: document.cookie }))).toEqual({ s: [], c: '' });

  const other = await context.newPage();
  await other.goto('/faturalar');
  await expect(other.getByRole('heading', { name: 'Faturalar' })).toBeVisible();
  await expect(sidebarUser(other)).toContainText('Alper Yıldız');

  await page.goto('/tedarikciler');
  await expect(page.getByRole('heading', { name: 'Tedarikçiler' })).toBeVisible();
  await page.getByRole('button', { name: 'Çıkış' }).last().click();
  await expect(page.getByRole('button', { name: 'Oturum aç' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Oturum aç' })).toBeVisible();
  await login(page, 'nur.finansonay@example.test');
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
  await expect(page).toHaveURL(/\/islerim$/);
  await expect(sidebarUser(page)).toContainText('Nur Aydın');

  // Öteki sekme Alper'in adıyla kalmaz: yeniden kurulur ve Nur'u gösterir (ya da giriş ekranı); asla "Alper" + Nur verisi değil.
  await expect(sidebarUser(other)).toContainText('Nur Aydın');
  await expect(sidebarUser(other)).not.toContainText('Alper Yıldız');
});

test('kiracı değişince kayıt detayından modül listesine dönülür; tedarikçi iç sayfa adresinde portala döner', async ({ page }) => {
  await page.goto('/');
  await login(page, 'ece.cokkiracili@example.test');
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
  await page.goto('/tedarikciler');
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  await expect(page).toHaveURL(/\/tedarikciler\/[0-9a-f-]{36}$/);
  const tenant = page.getByLabel('Aktif kiracı');
  const before = await tenant.inputValue();
  const other = await tenant.locator('option').evaluateAll((os, v) => (os as HTMLOptionElement[]).find((o) => o.value !== v)!.value, before);
  await tenant.selectOption(other);
  await expect(page).toHaveURL(/\/tedarikciler$/);
  await expect(page.getByRole('heading', { name: 'Tedarikçiler' })).toBeVisible();
  await expect(page.getByText('Kayıt bulunamadı')).toHaveCount(0);
  await tenant.selectOption(before);
  // Belge detayının kendi listesi yok: belge girişine dönülür ("Sayfa bulunamadı" değil).
  await expect(page.getByRole('heading', { name: 'Tedarikçiler' })).toBeVisible();
  await page.goto('/belgeler/00000000-0000-4000-8000-000000000000');
  await tenant.selectOption(other);
  await expect(page).toHaveURL(/\/belge-girisi$/);
  await expect(page.getByText('Sayfa bulunamadı')).toHaveCount(0);
  await tenant.selectOption(before);

  await page.getByRole('button', { name: 'Çıkış' }).last().click();
  await login(page, 'teklif.ege@example.test');
  await expect(page.getByRole('heading', { name: 'Teklif davetleri' })).toBeVisible();
  await page.goto('/faturalar');
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole('heading', { name: 'Teklif davetleri' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Faturalar' })).toHaveCount(0);
});
