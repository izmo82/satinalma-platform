import { expect, test, type Page } from '@playwright/test';

// Lira Defteri (D80): kurallarla bulunan "masada unutulan para" ve kanıt zinciri. Sentetik demo verisi (npm run db:seed).
// Demo vakalarının durumu değiştirilmez (yaşam döngüsü API testinde); burada görünüm, rol sınırı ve tarama sınanır.
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}

test('finans: özet, bulgu listesi ve vaka dayanağı; talep yazısı taslağı', async ({ page }) => {
  await login(page, 'ferda.finans@example.test');
  await page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: /Lira Defteri/ }).click();
  await expect(page.getByRole('heading', { name: 'Lira Defteri' })).toBeVisible();
  for (const t of ['Geri alınabilir', 'Geri alınan', 'Önlenebilir kayıp', 'Risk altındaki teminat', 'Kanıtlı harcama', 'Kanıtsız harcama']) {
    await expect(page.getByText(t, { exact: true }).first()).toBeVisible();
  }
  const row = page.getByRole('row', { name: /EGEKF2026000031/ });
  await expect(row).toContainText('İzinsiz kur farkı');
  await expect(row).toContainText('186.400,00');
  await row.getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('İzinsiz kur farkı');
  await expect(page.getByText('Kur farkı uygulanmaz')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Talep yazısı taslağı' })).toHaveValue(/186\.400,00 TRY/);
  await expect(page.getByRole('link', { name: 'EGEKF2026000031' })).toHaveAttribute('href', /\/faturalar\//);
});

test('hesap dayanağı biçimli; tedarikçi ve yetkisiz rol defteri göremez; denetçi tarayamaz', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'rol sınırı tek projede yeterli');
  await login(page, 'deniz.denetci@example.test');
  await page.goto('/lira-defteri');
  await expect(page.getByRole('heading', { name: 'Lira Defteri' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Taramayı çalıştır' })).toHaveCount(0);
  // Demo vakası tahsil edilmiş olabilir (kapanan vakalar varsayılan "Açık işler" filtresinde görünmez).
  await page.getByRole('button', { name: /Tümü/ }).click();
  await page.getByRole('row', { name: /ANBKF2026000052/ }).getByRole('link').click();
  // Kur ve tutarlar Türkçe biçimde; ham "29850.00" görünmez.
  await expect(page.getByText('Fatura günü kuru')).toBeVisible();
  await expect(page.getByText(/40,9123 TRY \/ USD/)).toBeVisible();
  await expect(page.getByText('29850.00')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Doğrula' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Çıkış' }).last().click();
  await login(page, 'selin.guvenlik@example.test');
  await expect(page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: /Lira Defteri/ })).toHaveCount(0);
  await page.goto('/lira-defteri');
  await expect(page.getByText('Kayıt bulunamadı veya erişim yetkiniz yok').or(page.getByText(/yetkiniz yok/)).first()).toBeVisible();
});

test('satınalmacı taramayı çalıştırır; sonuç sayılarla bildirilir, aynı bulgu ikinci kez açılmaz', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  await login(page, 'alper.satinalma@example.test');
  await page.goto('/lira-defteri?sekme=bulgular');
  await page.getByRole('button', { name: 'Taramayı çalıştır' }).click();
  await expect(page.getByText(/Tarama tamamlandı: \d+ bulgu \(0 yeni/)).toBeVisible();
  await page.getByRole('button', { name: /Tümü/ }).click();
  await expect(page.getByRole('row', { name: /EGEKF2026000031/ })).toHaveCount(1);
});
