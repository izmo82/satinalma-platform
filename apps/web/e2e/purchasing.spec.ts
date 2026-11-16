// v2 Faz 1 (D93/D95): sipariş/kabul, fatura finans onayı, istisna onayı ve tolerans onaylı kaldırma listesinde (atlanır). Kalanlar yeni yollarından sınanır: Fatura gir ve tekrar gelen fatura, sözleşmeye tahsis (eşleştirme), e-Fatura XML yükleme (/faturalar/yukle), fatura ekranlarının taşmaması. Bulgu metni v2 dilinde ("sözleşmeye tahsis edilmedi").
import { expect, test, type Page } from '@playwright/test';
import { syntheticVkn } from '../../../packages/domain/src/taxId.ts';

// Faz 4 kritik tarayıcı görevleri: sipariş, kabul, fatura tahsisi, görev ayrılığıyla onay (UX10). Sentetik demo verisi: npm run db:seed.
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}
const logout = (page: Page) => page.getByRole('button', { name: 'Çıkış' }).click();

// v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; kaldırılan adres RemovedPage ile navigation-v2.spec.ts'de korunur
test.skip('sipariş → kabul → fatura → tahsis → ikinci finans onayı; tekrar gelen fatura yeni kayıt açmaz (T13, T17, UX10)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const tag = Date.now().toString().slice(-7);
  await login(page, 'alper.satinalma@example.test');
  await page.goto('/siparisler');
  await page.getByRole('button', { name: 'Sipariş ver' }).click();
  await page.getByLabel('Tedarikçi', { exact: true }).selectOption({ label: 'Anadolu Bilişim Hizmetleri A.Ş. (SENTETİK)' });
  await page.getByLabel('Kalem 1', { exact: true }).fill(`Etiket yazıcı ${tag}`);
  await page.getByLabel('Miktar').fill('5');
  await page.getByLabel('Birim', { exact: true }).fill('adet');
  await page.getByLabel('Birim fiyat').fill('1200');
  await page.getByRole('button', { name: 'Siparişi kaydet' }).click();
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText('PO-');
  const poCode = (await heading.textContent())!.split(' · ')[0]!.trim();
  await page.getByRole('button', { name: 'Kabul kaydet' }).click();
  await page.getByLabel('Miktar').fill('5');
  await page.getByLabel('Not').fill('Teslim alındı (e2e)');
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByText('Kabul kaydedildi.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kabul kaydet' })).toHaveCount(0);

  await logout(page);
  await login(page, 'ferda.finans@example.test');
  await page.goto('/faturalar');
  const enter = async () => {
    await page.getByRole('button', { name: 'Fatura gir' }).click();
    await page.getByLabel('Tedarikçi', { exact: true }).selectOption({ label: 'Anadolu Bilişim Hizmetleri A.Ş. (SENTETİK)' });
    await page.getByLabel('Fatura no').fill(`E2E${tag}`);
    await page.getByLabel('Fatura tarihi').fill('2026-10-21');
    await page.getByLabel('Satır 1', { exact: true }).fill('Etiket yazıcı');
    await page.getByLabel('Miktar').fill('5');
    await page.getByLabel('Birim', { exact: true }).fill('adet');
    await page.getByLabel('Birim fiyat').fill('1200');
    await page.getByRole('button', { name: 'Faturayı kaydet' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`E2E${tag}`);
  };
  await enter();
  const invoiceUrl = page.url();
  // Tahsis yokken bulgu ve çözen rol görünür.
  await expect(page.getByText('sipariş veya sözleşmeye tahsis edilmedi')).toBeVisible();
  await expect(page.getByText('Çözen: Finans').first()).toBeVisible();
  await page.getByRole('button', { name: 'Tahsisi düzenle' }).click();
  await page.getByRole('button', { name: `${poCode} kalemlerini yükle` }).click();
  await page.getByLabel('Satır 1 hedef').selectOption({ label: `${poCode} · Etiket yazıcı ${tag}` });
  await page.getByRole('button', { name: 'Tahsisi kaydet ve kontrol et' }).click();
  await expect(page.getByText('Onaya hazır')).toBeVisible();
  // Giren kişi onaylayamaz (görev ayrılığı).
  await expect(page.getByText('Faturayı siz girdiniz')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finans onayı' })).toHaveCount(0);
  // Aynı fatura ikinci kez girilirse mevcut kayıt açılır.
  await page.goto('/faturalar');
  await enter();
  expect(page.url()).toBe(invoiceUrl);
  await expect(page.getByText('1 kez tekrar geldi')).toBeVisible();

  await logout(page);
  await login(page, 'nur.finansonay@example.test');
  await page.goto(invoiceUrl);
  await page.getByRole('button', { name: 'Finans onayı' }).click();
  await expect(page.getByText('Finans onaylı')).toBeVisible();
  // ERP bağdaştırıcısı yoksa aktarım başarı gibi gösterilmez.
  await expect(page.getByText(/ERP bağlantısı yapılandırılmadı|ERP: aktarım bekliyor/).first()).toBeVisible();
  await page.goto('/siparisler');
  await page.getByRole('link', { name: poCode }).click();
  await expect(page.getByRole('row', { name: new RegExp(`Etiket yazıcı ${tag}`) })).toContainText('5 adet');
});

// v2: elle fatura girişi (K-05, Satınalma), tahsis yalnız sözleşmeye (eşleştirme) ve tekrar gelen fatura yeni kayıt açmaz (T17). Sipariş adımı kaldırma listesinde.
test('Fatura gir → sözleşmeye tahsis → eşleşti; onay denetimi yok; tekrar gelen fatura yeni kayıt açmaz (T17, UX10)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const tag = Date.now().toString().slice(-7);
  await login(page, 'ferda.finans@example.test');
  await page.goto('/faturalar');
  const enter = async () => {
    await page.getByRole('button', { name: 'Fatura gir' }).click();
    await page.getByLabel('Şirket').selectOption({ label: 'Örnek Holding Üretim A.Ş.' });
    await page.getByLabel('Tedarikçi', { exact: true }).selectOption({ label: 'Anadolu Bilişim Hizmetleri A.Ş. (SENTETİK)' });
    await page.getByLabel('Fatura no').fill(`E2E${tag}`);
    await page.getByLabel('Fatura tarihi').fill('2026-10-21');
    await page.getByLabel('Satır 1', { exact: true }).fill('Etiket yazıcı');
    await page.getByLabel('Miktar').fill('5');
    await page.getByLabel('Birim', { exact: true }).fill('adet');
    await page.getByLabel('Birim fiyat').fill('1200');
    await page.getByRole('button', { name: 'Faturayı kaydet' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`E2E${tag}`);
  };
  await enter();
  const invoiceUrl = page.url();
  // Tahsis yokken bulgu ve çözen rol (v2 adıyla) görünür; eşleşmedi.
  await expect(page.getByText('sözleşmeye tahsis edilmedi')).toBeVisible();
  await expect(page.getByText('Çözen: Satınalma').first()).toBeVisible();
  await expect(page.getByText('Eşleşmedi', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Tahsisi düzenle' }).click();
  // Tahsis yalnız sözleşmeye: sipariş kalemi yükleme ve sipariş seçeneği yok.
  await expect(page.getByRole('button', { name: /kalemlerini yükle/ })).toHaveCount(0);
  const target = page.getByLabel('Satır 1 hedef');
  const contract = 'Sözleşme · Yazılım Lisans ve Destek Sözleşmesi (SENTETİK)';
  await expect(target.locator('option', { hasText: contract })).toHaveCount(1);
  const options = await target.locator('option').allInnerTexts();
  expect(options.filter((o) => o !== 'Seçin').every((o) => o.startsWith('Sözleşme · ')), options.join(' | ')).toBe(true);
  await target.selectOption({ label: contract });
  await page.getByRole('button', { name: 'Tahsisi kaydet ve kontrol et' }).click();
  await expect(page.getByText('Sözleşme: Yazılım Lisans ve Destek Sözleşmesi (SENTETİK)')).toBeVisible();
  await expect(page.getByText('Eşleşti', { exact: true }).first()).toBeVisible();
  for (const b of ['Finans onayı', 'Reddet', 'İstisnayı onayla']) await expect(page.getByRole('button', { name: b })).toHaveCount(0);
  // Aynı fatura ikinci kez girilirse mevcut kayıt açılır.
  await page.goto('/faturalar');
  await enter();
  expect(page.url()).toBe(invoiceUrl);
  await expect(page.getByText('1 kez tekrar geldi')).toBeVisible();
});

// v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; kaldırılan adres RemovedPage ile navigation-v2.spec.ts'de korunur
test.skip('istisna gereken fatura: neden eşleşmedi ve kim çözer görünür; tek başına onaylanamaz (T14, UX10)', async ({ page }) => {
  await login(page, 'nur.finansonay@example.test');
  await page.goto('/faturalar');
  await page.getByRole('link', { name: 'ANB2026000102' }).click();
  await expect(page.getByText('İstisna gerekli').first()).toBeVisible();
  await expect(page.getByText(/kabul kaydı yok/)).toBeVisible();
  await expect(page.getByText('Çözen: Talep sahibi')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finans onayı' })).toBeDisabled();
  await expect(page.getByText('Kullanılabilir')).toBeVisible();
});

// v2: sipariş ekranı kaldırma listesinde; fatura listesi ve detayı (departman sütunu ve eşleşme süzgeciyle) taşmaz.
test('fatura ekranları yatay taşmaz', async ({ page }) => {
  await login(page, 'nur.finansonay@example.test');
  await page.goto('/faturalar');
  await expect(page.getByRole('table')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '/faturalar').toBe(true);
  await page.getByRole('link', { name: 'ANB2026000102' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

// Sentetik demo kimlikleri (createSyntheticWorld): satıcı Anadolu Bilişim, alıcı Örnek Holding Üretim.
const efatura = (no: string, lineTax: string, payable: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>${no}</cbc:ID><cbc:UUID>${crypto.randomUUID()}</cbc:UUID><cbc:IssueDate>2026-10-22</cbc:IssueDate><cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
  <cbc:Note>SENTETİK TEST FATURASI</cbc:Note>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="VKN">${syntheticVkn('930000001')}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>Anadolu Bilişim Hizmetleri A.Ş. (SENTETİK)</cbc:Name></cac:PartyName></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="VKN">${syntheticVkn('910000001')}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>Örnek Holding Üretim A.Ş.</cbc:Name></cac:PartyName></cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="TRY">${lineTax}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="TRY">${lineTax}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="TRY">${payable}</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="HUR">4</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="TRY">10000.00</cbc:LineExtensionAmount>
    <cac:TaxTotal><cbc:TaxAmount currencyID="TRY">${lineTax}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="TRY">${lineTax}</cbc:TaxAmount><cbc:Percent>20</cbc:Percent><cac:TaxCategory><cac:TaxScheme><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
    <cac:Item><cbc:Name>Saha danışmanlığı</cbc:Name></cac:Item><cac:Price><cbc:PriceAmount currencyID="TRY">2500</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`, 'utf8');

test('e-Fatura XML yüklenince fatura satırlardan açılır; KDV tutmazsa sorumlusuyla engellenir', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  await login(page, 'ferda.finans@example.test');
  const upload = async (no: string, tax: string, payable: string) => {
    await page.goto('/faturalar/yukle');
    await page.getByLabel('Belge türü').selectOption('INVOICE');
    await page.locator('input[type=file]').setInputFiles({ name: `${no}.xml`, mimeType: 'application/xml', buffer: efatura(no, tax, payable) });
    await page.getByRole('button', { name: 'Yükle' }).click();
    await expect(page.getByText('Fatura kaydı e-Fatura satırlarından açıldı.')).toBeVisible();
    await page.getByRole('link', { name: 'Faturayı aç' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(no);
  };
  const tag = Date.now().toString().slice(-7);
  await upload(`XML${tag}A`, '2000.00', '12000.00');
  await expect(page.getByText('4 saat ×')).toBeVisible();
  await expect(page.getByText('KDV %20 · belgede')).toBeVisible();
  await expect(page.getByText('KDV', { exact: true })).toBeVisible();
  await expect(page.getByText(/KDV .* yazıyor/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Kaynak e-Fatura' })).toBeVisible();
  await upload(`XML${tag}B`, '1800.00', '11800.00');
  await expect(page.getByText(/Satır 1: KDV 1800.00 TRY yazıyor; 10000.00 × %20 = 2000.00/)).toBeVisible();
  await expect(page.getByText('Çözen: Satınalma').first()).toBeVisible();
});

// v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; kaldırılan adres RemovedPage ile navigation-v2.spec.ts'de korunur
test.skip('sipariş değişikliği gerekçeyle kaydedilir; kısmi kabul sonrası kapatılır ve yeni kabul kapanır', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const tag = Date.now().toString().slice(-7);
  await login(page, 'alper.satinalma@example.test');
  await page.goto('/siparisler');
  await page.getByRole('button', { name: 'Sipariş ver' }).click();
  await page.getByLabel('Tedarikçi', { exact: true }).selectOption({ label: 'Anadolu Bilişim Hizmetleri A.Ş. (SENTETİK)' });
  await page.getByLabel('Kalem 1', { exact: true }).fill(`Toner ${tag}`);
  await page.getByLabel('Miktar').fill('10');
  await page.getByLabel('Birim', { exact: true }).fill('adet');
  await page.getByLabel('Birim fiyat').fill('300');
  await page.getByRole('button', { name: 'Siparişi kaydet' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('PO-');
  await page.getByRole('button', { name: 'Siparişi değiştir' }).click();
  await page.getByLabel(`Toner ${tag} miktar`).fill('12');
  await page.getByLabel('Değişiklik gerekçesi').fill('Talep sahibi iki adet ek istedi (e2e)');
  await expect(page.getByText(/Tutar farkı \(yaklaşık\): \+/)).toBeVisible();
  await page.getByRole('button', { name: 'Değişikliği kaydet' }).click();
  await expect(page.getByText('özgün 10')).toBeVisible();
  await expect(page.getByText(/Değişiklik 1 · tutar farkı \+₺600,00/)).toBeVisible();
  await page.getByRole('button', { name: 'Kabul kaydet' }).click();
  await page.getByLabel('Miktar').fill('5');
  await page.getByLabel('Not').fill('Kısmi teslim (e2e)');
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByText('Kabul kaydedildi.')).toBeVisible();
  await page.getByRole('button', { name: 'Kapat / iptal et' }).click();
  await expect(page.getByRole('heading', { name: 'Siparişi kapat' })).toBeVisible();
  await page.getByLabel('Gerekçe').fill('Kalan toner artık gerekmiyor (e2e)');
  await page.getByRole('button', { name: 'Kapat', exact: true }).click();
  await expect(page.getByText('Sipariş kapatıldı')).toBeVisible();
  await expect(page.getByText(/serbest kalan ₺2\.100,00/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kabul kaydet' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Siparişi değiştir' })).toHaveCount(0);
});

// v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; kaldırılan adres RemovedPage ile navigation-v2.spec.ts'de korunur
test.skip('tolerans kuralı: finans ekler, geçerli eşik açıkça yazılır, kaldırınca sıfır', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  await login(page, 'ferda.finans@example.test');
  await page.goto('/faturalar');
  await page.getByRole('link', { name: 'Tolerans kuralları' }).click();
  await page.getByRole('button', { name: 'Kural ekle' }).click();
  await page.getByLabel('Para birimi').fill('GBP');
  await page.getByLabel('Tutar eşiği').fill('100');
  await page.getByLabel('Yüzde eşiği').fill('1');
  await expect(page.getByText(/Geçerli tolerans: %1 ve .*100,00 eşiklerinden düşük olanı/)).toBeVisible();
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('GBP genel kuralı kaydedildi.')).toBeVisible();
  const row = page.getByRole('row', { name: /GBP/ });
  await row.getByRole('button', { name: 'Kaldır' }).click();
  await row.getByRole('button', { name: 'Kaldır' }).click();
  await expect(page.getByText('GBP genel kuralı kaldırıldı; kategori kuralı olmayan alımlarda tolerans sıfır.')).toBeVisible();
  await expect(page.getByRole('row', { name: /GBP/ })).toHaveCount(0);
});

// v2 Faz 1 (D93): işlev onaylı kaldırma listesinde; kaldırılan adres RemovedPage ile navigation-v2.spec.ts'de korunur
test.skip('satınalma tolerans kuralını görür ama değiştiremez; yeni ekranlar yatay taşmaz', async ({ page }) => {
  await login(page, 'alper.satinalma@example.test');
  await page.goto('/faturalar/tolerans');
  await expect(page.getByRole('heading', { name: 'Tolerans kuralları' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kural ekle' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.goto('/siparisler');
  await page.getByRole('table').getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('PO-');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

// Düzeltme dalgası (I4): eski sipariş bağı (D84 öncesi, başka tedarikçinin siparişine) taşıyan faturada her kayıt 422 dönüyordu; bağ
// tahsis düzenleyicide kaldırılabilir ya da sözleşmeye yeniden bağlanabilir. Yeni sipariş bağı seçeneği yoktur. Demo faturalara
// dokunulmaz: sentetik fatura API ile açılır, eski bağ v1 verisini taklit etmek için doğrudan veritabanına yazılır (yalnız yerel geliştirme).
test('eski sipariş bağı uyuşmazlıkta: bağ kaldırılır ve sözleşmeye yeniden bağlanır; yeni sipariş seçeneği yok', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const { execFileSync } = await import('node:child_process');
  const db = process.env.E2E_DATABASE_OWNER_URL ?? 'postgres://sp_owner:local_owner_only@localhost:5544/satinalma';
  const sql = (q: string) => execFileSync('psql', [db, '-At', '-c', q], { encoding: 'utf8' }).trim();
  const auth = { authorization: `Bearer ${(await (await page.request.post('/api/v1/dev/token', { data: { email: 'kerem.hukuk@example.test' } })).json()).token}` };
  // Anadolu Bilişim'in eski sipariş kalemi; fatura başka tedarikçiye (Ege) açılır → SUPPLIER_MISMATCH.
  const [poLine, companyId, tenantId, poCode] = sql(`SELECT pl.id || '|' || po.company_id || '|' || po.tenant_id || '|' || po.code FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
    WHERE po.code = 'PO-2026-0001' ORDER BY pl.line_no LIMIT 1`).split('|');
  const opts = await (await page.request.get('/api/v1/supplier-options', { headers: { ...auth, 'x-tenant-id': tenantId! } })).json();
  const ege = (opts.items as { id: string; label: string }[]).find((x) => /^Ege Sistem/.test(x.label))!;
  const no = `I4E2E${Date.now().toString(36).toUpperCase()}`;
  const inv = await page.request.post('/api/v1/invoices', { headers: { ...auth, 'x-tenant-id': tenantId! }, data: { companyId, supplierId: ege.id, kind: 'INVOICE', invoiceNo: no,
    issueDate: '2026-11-10', currency: 'TRY', lines: [{ description: 'Sentetik hizmet (I4)', quantity: '1', unit: 'adet', unitPrice: '100', netAmount: '100.00' }] } });
  expect(inv.status(), await inv.text()).toBe(201);
  const invoiceId = (await inv.json()).id as string;
  const creator = sql(`SELECT created_by FROM invoices WHERE id = '${invoiceId}'`);
  sql(`INSERT INTO invoice_allocations (tenant_id, company_id, invoice_id, line_no, po_line_id, contract_version_id, quantity, amount, created_by)
    VALUES ('${tenantId}', '${companyId}', '${invoiceId}', 1, '${poLine}', NULL, 1, 100.00, '${creator}')`);

  await login(page, 'kerem.hukuk@example.test');
  await page.goto(`/faturalar/${invoiceId}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(no);
  await expect(page.getByText('Eşleşmedi', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Tahsisi düzenle' }).click();
  const target = page.getByLabel('Satır 1 hedef');
  await expect(target.locator('option', { hasText: `Sipariş ${poCode}` })).toHaveCount(1);
  await expect(target.locator('option', { hasText: 'Bağı kaldır' })).toHaveCount(1);
  // Yeni sipariş bağı seçeneği yok: sipariş seçeneği yalnız kayıtlı eski bağ.
  expect((await target.locator('option').allInnerTexts()).filter((o) => o.startsWith('Sipariş ')).length).toBe(1);
  await target.selectOption({ label: 'Bağı kaldır' });
  await page.getByRole('button', { name: 'Tahsisi kaydet ve kontrol et' }).click();
  await expect(page.getByRole('button', { name: 'Tahsisi düzenle' })).toBeVisible();
  expect(sql(`SELECT count(*) FROM invoice_allocations WHERE invoice_id = '${invoiceId}'`)).toBe('0');

  // Yeniden bağlama: eski bağ tekrar yazılır, bu kez sözleşmeye taşınır.
  sql(`INSERT INTO invoice_allocations (tenant_id, company_id, invoice_id, line_no, po_line_id, contract_version_id, quantity, amount, created_by)
    VALUES ('${tenantId}', '${companyId}', '${invoiceId}', 1, '${poLine}', NULL, 1, 100.00, '${creator}')`);
  await page.reload();
  await page.getByRole('button', { name: 'Tahsisi düzenle' }).click();
  const t2 = page.getByLabel('Satır 1 hedef');
  // Sözleşme seçenekleri ayrı istekle gelir: önce en az bir seçenek beklenir (demo verisinde Ege Sistem'in sözleşmesi var).
  await expect(t2.locator('option', { hasText: 'Sözleşme · ' }).first()).toBeAttached();
  const contract = (await t2.locator('option').allInnerTexts()).find((o) => o.startsWith('Sözleşme · '));
  await t2.selectOption({ label: contract! });
  await page.getByRole('button', { name: 'Tahsisi kaydet ve kontrol et' }).click();
  await expect(page.getByText(`Sözleşme: ${contract!.replace('Sözleşme · ', '')}`)).toBeVisible();
  expect(sql(`SELECT count(*) FROM invoice_allocations WHERE invoice_id = '${invoiceId}' AND po_line_id IS NULL AND contract_version_id IS NOT NULL`)).toBe('1');
});
