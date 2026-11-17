// v2 Faz 5 (D110): girişsiz tedarikçi başvurusu → e-posta kutusundan doğrulama → Satınalma incelemesi (eksik belge, tamamlama, onay) →
// ikinci Satınalma kullanıcısı Onaylı yapar → projeye davet (R9: aday seçilemez) + tur onayı → davet e-postası NOT_CONFIGURED → oturumsuz
// davet bağlantısı girişten sonra aynı tura döner → teklif; Belgelerim yenileme, Skorum'da iç alan yok, Firma bilgileri If-Match çakışması,
// pasife alma + ayrılış kontrol listesi. Veri değiştiren akış yalnız 1440'ta; başvuru ayarı ve tedarikçi iletişim bilgisi sonda geri yüklenir.
// Not: başvurudan açılan portal kullanıcısı davetlidir (ilk OIDC girişini bekler) ve geliştirme girişiyle açılamaz; davet bağlantısının
// giriş dönüşü ve teklif aynı tura davet edilen sentetik portal kullanıcısıyla (teklif.anadolu) yürütülür.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });

async function login(page: Page, email: string, landing = 'İşlerim') {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace(/\./g, '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: landing, level: 1 })).toBeVisible();
}
async function logout(page: Page) {
  await page.getByRole('button', { name: 'Çıkış' }).filter({ visible: true }).first().click();
  await expect(page.getByRole('button', { name: 'Oturum aç' })).toBeVisible();
}
async function audit(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${name}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
/** Yatay taşma yok (sayfa ve ana içerik). */
async function fits(page: Page, name: string) {
  await page.locator('main').first().waitFor();
  const ok = await page.evaluate(() => {
    const m = document.querySelector('main')!;
    return document.documentElement.scrollWidth <= window.innerWidth + 1 && m.scrollWidth <= m.clientWidth + 1;
  });
  expect(ok, `${name}: yatay taşma`).toBe(true);
}
const check = async (page: Page, name: string) => { await audit(page, name); await fits(page, name); };

/** Geçerli sentetik VKN (kontrol basamağı domain `vknChecksum` ile aynı). */
function vkn(): string {
  const d = Array.from({ length: 9 }, (_, i) => (i === 0 ? 7 : Math.floor(Math.random() * 10)));
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (d[i]! + 9 - i) % 10;
    let r = (tmp * 2 ** (9 - i)) % 9;
    if (tmp !== 0 && r === 0) r = 9;
    sum += r;
  }
  return `${d.join('')}${(10 - (sum % 10)) % 10}`;
}
const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% SENTETIK ${name} ${Date.now()}-${Math.random()}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`) });
const inDays = (n: number) => { const d = new Date(Date.now() + n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const anon = async (browser: Browser, baseURL: string | undefined) => (await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })).newPage();

/** Yönetici e-posta kutusunda alıcıya giden, gövdesinde `marker` geçen en yeni bağlantı. */
async function linkFromOutbox(page: Page, email: string, marker: RegExp): Promise<string> {
  await page.goto('/yonetim/e-posta-kutusu');
  await expect(page.getByRole('heading', { name: 'E-posta kutusu', level: 1 })).toBeVisible();
  const rows = page.getByRole('list', { name: 'E-postalar' }).getByRole('listitem').filter({ hasText: email });
  await expect(rows.first()).toBeVisible();
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    await row.getByRole('button', { name: 'Gövdeyi göster' }).click();
    const body = await row.locator('pre').innerText();
    const m = marker.exec(body);
    if (m) return new URL(m[0]).pathname + new URL(m[0]).hash;
    await row.getByRole('button', { name: 'Gövdeyi gizle' }).click();
  }
  throw new Error(`E-posta kutusunda bağlantı bulunamadı: ${marker}`);
}

test('tedarikçi portalı v2: başvurudan teklife, belgeler, skor, firma bilgileri ve ayrılış', async ({ page, browser, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  test.setTimeout(300_000);
  const tag = Date.now().toString(36);
  const firm = `E2E Portal Bilişim ${tag} A.Ş. (SENTETİK)`;
  const email = `basvuru.${tag}@example.test`;
  const taxId = vkn();
  const slug = 'tedarikci-e2e';

  // --- 1. Yönetici başvuru adresini açar (önceki ayar sonda geri yüklenir) ---
  await login(page, 'tamer.yonetici@example.test');
  const before = await (await page.request.get('/api/v1/settings/supplier-applications', { headers: { 'X-SP-CSRF': '1' } })).json();
  restoreSettings = { enabled: before.enabled, publicSlug: before.publicSlug ?? (before.enabled ? slug : null), categories: before.categories };
  try {
    await page.goto('/yonetim/tedarikci-basvurusu');
    await expect(page.getByRole('heading', { name: 'Tedarikçi başvurusu', level: 1 })).toBeVisible();
    await page.getByLabel('Başvuru alımı açık').check();
    await page.getByLabel('Adres kısaltması').fill(slug);
    const cats = page.getByLabel('Hizmet kategorileri');
    const current = (await cats.inputValue()).split('\n').map((x) => x.trim()).filter(Boolean);
    await cats.fill([...new Set([...current, 'Bilgi teknolojileri', 'Tesis hizmetleri'])].join('\n'));
    await page.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.getByText(/^Ayarlar kaydedildi/)).toBeVisible();
    await expect(page.getByText(`/basvuru/${slug}`).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: /^Vergi levhası/ }).first()).toBeVisible();
    await check(page, 'Yönetim · Tedarikçi başvurusu');

    // --- 2. Girişsiz başvuru (sentetik PDF'ler) ---
    const applicant = await anon(browser, baseURL);
    await applicant.goto(`/basvuru/${slug}`);
    await expect(applicant.getByRole('heading', { name: 'Tedarikçi başvurusu' })).toBeVisible();
    await check(applicant, 'Girişsiz başvuru formu');
    await applicant.getByLabel('Ticaret unvanı').fill(firm);
    await applicant.getByLabel('VKN', { exact: true }).fill(taxId);
    await applicant.getByLabel('Yetkili kişi').fill('Deniz Sentetik');
    await applicant.getByLabel('E-posta', { exact: true }).fill(email);
    await applicant.getByLabel('Telefon').fill('0216 000 00 00');
    await applicant.getByRole('checkbox', { name: 'Bilgi teknolojileri' }).check();
    // Eksik belgeyle gönderim istemcide durur.
    await applicant.getByRole('button', { name: 'Başvuruyu gönder' }).click();
    await expect(applicant.getByText(/yüklenmeli\./).first()).toBeVisible();
    const types = await applicant.locator('input[type=file]').evaluateAll((els) => els.map((e) => e.id));
    for (const id of types) await applicant.locator(`#${id}`).setInputFiles(pdf(`${id}.pdf`));
    for (const d of await applicant.getByLabel('Geçerlilik tarihi').all()) await d.fill(inDays(365));
    await applicant.getByRole('button', { name: 'Başvuruyu gönder' }).click();
    await expect(applicant.getByRole('heading', { name: 'E-postanızı doğrulayın' })).toBeVisible();
    // Kanal yoksa "gönderildi" denmez (Ruling 4) ve R4e notu görünür.
    await expect(applicant.getByText(/Doğrulama e-postası gönderilmedi/)).toBeVisible();
    await expect(applicant.getByText('E-posta kanalı yapılandırılmadı', { exact: true })).toBeVisible();

    // --- 3. Yönetici e-posta kutusundan doğrulama bağlantısı ---
    const verify = await linkFromOutbox(page, email, /https?:\/\/\S+\/basvuru\/dogrula#token=\S+/);
    await expect(page.getByText('E-posta kanalı yapılandırılmadı — aşağıdaki iletiler gönderilmedi')).toBeVisible();
    await expect(page.getByText('Gönderilmedi — e-posta kanalı yapılandırılmadı').first()).toBeVisible();
    await check(page, 'Yönetim · E-posta kutusu');
    await applicant.goto(verify);
    await expect(applicant.getByText('Doğrulandı', { exact: true })).toBeVisible();
    // Belirteç adres çubuğundan silinir; ikinci kullanım reddedilir.
    expect(applicant.url()).not.toContain('token');
    const again = await applicant.context().newPage();
    await again.goto(verify);
    await expect(again.getByText('Doğrulanamadı', { exact: true })).toBeVisible();
    await again.close();
    await logout(page);

    // --- 4. Satınalma inceler ve eksik belge ister ---
    await login(page, 'alper.satinalma@example.test');
    await page.goto('/tedarikciler');
    await page.getByRole('group', { name: 'Aşama süzgeci' }).getByRole('button', { name: /^Başvuru/ }).click();
    await page.getByRole('link', { name: `${firm} başvurusunu incele` }).click();
    await expect(page.getByRole('heading', { name: `Başvuru · ${firm}` })).toBeVisible();
    await expect(page.getByText('Virüs taraması yapılandırılmadı').first()).toBeVisible();
    await expect(page.getByText('Vergi kimliği denetim basamağı doğru')).toBeVisible();
    await check(page, 'Başvuru incelemesi');
    await page.getByRole('button', { name: 'Eksik belge iste' }).click();
    await page.getByRole('dialog').getByRole('checkbox', { name: 'Faaliyet belgesi' }).check();
    await page.getByRole('dialog').getByLabel('Not').fill('Güncel tarihli faaliyet belgesini yükleyin (e2e).');
    await page.getByRole('button', { name: 'Belgeleri iste' }).click();
    await expect(page.getByText(/Karar kaydedildi: Eksik belge bekleniyor/)).toBeVisible();
    await expect(page.getByText(/Başvurana e-posta gönderilemedi — kanal yapılandırılmadı/)).toBeVisible();
    const reviewUrl = page.url();
    await logout(page);

    // --- 5. Tamamlama bağlantısı (e-posta kutusu) → başvuran belgeyi yükler ---
    await login(page, 'tamer.yonetici@example.test');
    const complete = await linkFromOutbox(page, email, /https?:\/\/\S+\/basvuru\/tamamla#token=\S+/);
    await logout(page);
    await applicant.goto(complete);
    await expect(applicant.getByText('Güncel tarihli faaliyet belgesini yükleyin (e2e).')).toBeVisible();
    await check(applicant, 'Eksik belge tamamlama');
    await applicant.locator('input[type=file]').first().setInputFiles(pdf('faaliyet-yeni.pdf'));
    for (const d of await applicant.getByLabel('Geçerlilik tarihi').all()) await d.fill(inDays(365));
    await applicant.getByRole('button', { name: 'Belgeleri gönder' }).click();
    await expect(applicant.getByText('Belgeleriniz alındı')).toBeVisible();
    await applicant.context().close();

    // --- 6. Satınalma onaylar (Aday kart) ---
    await login(page, 'alper.satinalma@example.test');
    await page.goto(reviewUrl);
    await page.getByRole('button', { name: 'Onayla (Aday yap)' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Onayla (Aday yap)' }).click();
    await expect(page.getByText('Karar kaydedildi: Onaylandı')).toBeVisible();
    await page.getByRole('link', { name: 'Tedarikçi kartını aç' }).first().click();
    await expect(page.getByRole('heading', { name: firm, level: 1 })).toBeVisible();
    const cardUrl = page.url();
    await expect(page.getByText('Aday', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Onaylı yapmadan önce' })).toBeVisible();
    await check(page, 'Tedarikçi kartı · Kayıt ve onay');
    for (const tabName of ['Belgeler ve geçerlilik', 'Sözleşmeler ve projeler', 'Portal kullanıcıları']) {
      await page.getByRole('tab', { name: tabName }).click();
      await check(page, `Tedarikçi kartı · ${tabName}`);
    }
    await page.getByRole('tab', { name: 'Belgeler ve geçerlilik' }).click();
    await expect(page.getByRole('cell', { name: 'Faaliyet belgesi' }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Portal kullanıcıları' }).click();
    // R11: kart e-postası portal kullanıcısı formuna kendiliğinden yazılmaz.
    await expect(page.getByLabel('E-posta', { exact: true })).toHaveValue('');
    await expect(page.getByRole('cell', { name: email })).toBeVisible();
    // R10 görev ayrılığı: kartı açan aktifleştiremez.
    await page.getByRole('tab', { name: 'Kayıt ve onay' }).click();
    await expect(page.getByText(/Bu adayı siz açtınız/)).toBeVisible();
    await logout(page);

    // --- 7. İkinci Satınalma kullanıcısı Onaylı yapar ---
    await login(page, 'mine.anaveri@example.test');
    await page.goto(cardUrl);
    await page.getByRole('button', { name: 'Kayıt onayı ver' }).click();
    await page.getByRole('dialog').getByLabel('Gerekçe').fill('Başvuru belgeleri ve VKN incelendi (e2e).');
    await page.getByRole('button', { name: 'Onayı kaydet' }).click();
    await expect(page.getByText('Kayıt onayı kaydedildi.')).toBeVisible();
    await page.getByRole('button', { name: 'Aktifleştir' }).click();
    await expect(page.getByText('Tedarikçi aktifleştirildi.')).toBeVisible();
    await expect(page.getByText('Onaylı', { exact: true }).first()).toBeVisible();
    await logout(page);

    // --- 8. Projeye davet (R9: aday seçilemez) ve tur onayı ---
    await login(page, 'alper.satinalma@example.test');
    const me = await (await page.request.get('/api/v1/me', { headers: { 'X-SP-CSRF': '1' } })).json();
    const projectTitle = `Portal davet e2e ${tag}`;
    const created = await page.request.post('/api/v1/projects', { headers: { 'X-SP-CSRF': '1', 'X-Tenant-Id': me.activeTenantId ?? me.memberships[0].tenantId }, data: {
      companyId: me.companies[0].id, departmentId: me.departments?.[0]?.id, title: projectTitle, category: 'Bilgi teknolojileri', need: 'Sentetik portal davet senaryosu (e2e).',
      currency: 'TRY', budget: '10000', budgetVerified: false, lines: [{ description: 'Sentetik bakım hizmeti', unit: 'adet', quantity: '2' }], criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '100' }] } });
    expect(created.status()).toBe(201);
    const projectId = (await created.json()).id as string;
    await page.goto(`/projeler/${projectId}`);
    await expect(page.getByRole('heading', { name: projectTitle })).toBeVisible();
    const candidate = page.getByRole('checkbox', { name: /Persona Aday Bilişim|Marmara Kablo/ }).first();
    await expect(candidate).toBeDisabled();
    await expect(page.getByText(/Aday tedarikçi önce onaylanmalı/).first()).toBeVisible();
    await page.getByRole('checkbox', { name: new RegExp(firm.replace(/[().]/g, '\\$&')) }).check();
    await page.getByRole('checkbox', { name: /Anadolu Bilişim Hizmetleri/, disabled: false }).first().check();
    await page.getByLabel('Kapanış').fill(`${inDays(5)}T17:00`);
    await page.getByRole('button', { name: 'Yayın onayına gönder' }).click();
    await expect(page.getByText('Tur yayın onayına gönderildi.')).toBeVisible();
    await logout(page);
    await login(page, 'mine.anaveri@example.test');
    await page.goto(`/projeler/${projectId}`);
    await page.getByRole('button', { name: 'Yayını onayla' }).click();
    await expect(page.getByText(/Karar kaydedildi|Yayın onaylandı/)).toBeVisible();
    await page.getByRole('tab', { name: 'Teklifler' }).click();
    const inviteRow = page.getByRole('row', { name: new RegExp(firm.replace(/[().]/g, '\\$&')) });
    await expect(inviteRow.getByText('Gönderilmedi — e-posta kanalı yapılandırılmadı')).toBeVisible();
    await expect(page.getByText('Gönderildi', { exact: true })).toHaveCount(0);
    const roundId = (await (await page.request.get(`/api/v1/projects/${projectId}`, { headers: { 'X-SP-CSRF': '1' } })).json()).round.id as string;
    await logout(page);

    // --- 9. E-posta kutusunda davet satırı NOT_CONFIGURED ---
    await login(page, 'tamer.yonetici@example.test');
    await page.goto('/yonetim/e-posta-kutusu');
    const invite = page.getByRole('list', { name: 'E-postalar' }).getByRole('listitem').filter({ hasText: `Teklif daveti: ${projectTitle}` }).filter({ hasText: email });
    await expect(invite.getByText('Gönderilmedi — e-posta kanalı yapılandırılmadı')).toBeVisible();
    await invite.getByRole('button', { name: 'Gövdeyi göster' }).click();
    await expect(invite.locator('pre')).toContainText(`/portal/${roundId}`);
    await logout(page);

    // --- 10. Oturumsuz davet bağlantısı → geliştirme girişi → aynı tur → teklif ---
    const supplier = await anon(browser, baseURL);
    await supplier.goto(`/portal/${roundId}`);
    await supplier.getByRole('radio', { name: /teklif\.anadolu/ }).check();
    await supplier.getByRole('button', { name: 'Oturum aç' }).click();
    await expect(supplier).toHaveURL(new RegExp(`/portal/${roundId}$`));
    await expect(supplier.getByRole('heading', { name: projectTitle })).toBeVisible();
    await supplier.getByLabel('Birim fiyat (TRY)').first().fill('1250.50');
    await supplier.getByRole('button', { name: /Teklifi gönder|Yeni sürüm gönder/ }).click();
    await expect(supplier.getByText(/Teklifiniz alındı: sürüm \d+/)).toBeVisible();
    // Tekliflerim: kendi tutarı.
    await supplier.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Tekliflerim' }).click();
    await expect(supplier.getByRole('row', { name: new RegExp(projectTitle) })).toContainText('2.501,00');
    await check(supplier, 'Portal · Tekliflerim');

    // --- 11. Belgelerim: yükle ve yenile ---
    await supplier.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Belgelerim' }).click();
    await expect(supplier.getByRole('heading', { name: 'Belgelerim', level: 1 })).toBeVisible();
    const vergi = supplier.getByRole('listitem').filter({ has: supplier.getByRole('heading', { name: 'Vergi levhası' }) });
    await expect(vergi.getByRole('heading', { name: 'Vergi levhası' })).toBeVisible();
    if (await vergi.getByRole('button', { name: 'Yükle' }).count()) {
      await vergi.getByRole('button', { name: 'Yükle' }).click();
      await vergi.getByLabel('Dosya').setInputFiles(pdf('vergi-levhasi.pdf'));
      await vergi.getByLabel('Geçerlilik tarihi').fill(inDays(200));
      await vergi.getByRole('button', { name: 'Yükle', exact: true }).click();
      await expect(supplier.getByText('Vergi levhası yüklendi.')).toBeVisible();
    }
    await vergi.getByRole('button', { name: 'Yenile' }).first().click();
    await vergi.getByLabel('Dosya').setInputFiles(pdf('vergi-levhasi-yeni.pdf'));
    await vergi.getByLabel('Geçerlilik tarihi').fill(inDays(400));
    await vergi.getByRole('button', { name: 'Yenisini yükle' }).click();
    await expect(supplier.getByText(/Vergi levhası yenilendi/)).toBeVisible();
    await expect(vergi.getByText('Virüs taraması yapılandırılmadı').first()).toBeVisible();
    await check(supplier, 'Portal · Belgelerim');

    // --- 12. Skorum: iç alan yok ---
    const standing = supplier.waitForResponse((r) => r.url().endsWith('/api/v1/portal/standing'));
    await supplier.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Skorum ve risk durumum' }).click();
    const body = await (await standing).text();
    for (const k of ['inherentFactors', 'inherent_factors', 'residualReason', 'residual_reason', 'scoreRiskLevel', 'criticality', 'reviewNotes', 'findingNote']) expect(body).not.toContain(k);
    await expect(supplier.getByRole('heading', { name: 'Sizden beklenenler' })).toBeVisible();
    await check(supplier, 'Portal · Skorum');

    // --- 13. Firma bilgileri: kaydet ve If-Match çakışması ---
    await supplier.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Firma bilgileri' }).click();
    await expect(supplier.getByRole('heading', { name: 'Kayıtlı bilgiler' })).toBeVisible();
    await check(supplier, 'Portal · Firma bilgileri');
    const original = await (await supplier.request.get('/api/v1/portal/profile', { headers: { 'X-SP-CSRF': '1' } })).json();
    try {
      // İletişim kişisi zorunlu: boşsa istemci gönderimi durdurur.
      await supplier.getByLabel('İletişim kişisi').fill('');
      await supplier.getByRole('button', { name: 'Kaydet' }).click();
      await expect(supplier.getByText(/İletişim kişisinin adını girin/)).toBeVisible();
      await supplier.getByLabel('İletişim kişisi').fill(original.contactName ?? 'Anadolu Teklif Sorumlusu (SENTETİK)');
      await supplier.getByLabel('Telefon').fill('0212 111 22 33');
      await supplier.getByRole('button', { name: 'Kaydet' }).click();
      await expect(supplier.getByText('İletişim bilgileri kaydedildi.')).toBeVisible();
      // Başka oturum değiştirir: ekrandaki sürüm bayatlar.
      const fresh = await (await supplier.request.get('/api/v1/portal/profile', { headers: { 'X-SP-CSRF': '1' } })).json();
      const other = await supplier.request.put('/api/v1/portal/profile', { headers: { 'X-SP-CSRF': '1', 'If-Match': `"${fresh.rowVersion}"` }, data: { address: 'Başka oturum adresi (e2e)' } });
      expect(other.status()).toBe(200);
      await supplier.getByLabel('Telefon').fill('0212 444 55 66');
      await supplier.getByRole('button', { name: 'Kaydet' }).click();
      await expect(supplier.getByText(/Bilgiler başka bir oturumda değişti/)).toBeVisible();
    } finally {
      const cur = await (await supplier.request.get('/api/v1/portal/profile', { headers: { 'X-SP-CSRF': '1' } })).json();
      await supplier.request.put('/api/v1/portal/profile', { headers: { 'X-SP-CSRF': '1' }, data: { contactPhone: original.contactPhone, address: original.address } });
      void cur;
    }
    // Teklif davetleri: özet kartları + mevcut liste.
    await supplier.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Teklif davetleri' }).click();
    await expect(supplier.getByRole('region', { name: 'Özet' })).toBeVisible();
    await expect(supplier.getByRole('row', { name: new RegExp(projectTitle) })).toBeVisible();
    await check(supplier, 'Portal · Teklif davetleri');
    await supplier.context().close();

    // --- 14. Pasife alma + ayrılış kontrol listesi ---
    await login(page, 'alper.satinalma@example.test');
    await page.goto(cardUrl);
    await page.getByRole('button', { name: 'Pasife al' }).click();
    await page.getByRole('dialog').getByLabel('Gerekçe').fill('Hizmet ilişkisi sona erdi; sentetik ayrılış (e2e).');
    await page.getByRole('dialog').getByRole('button', { name: 'Pasife al' }).click();
    await expect(page.getByText('Tedarikçi pasife alındı; ayrılış kontrol listesi açıldı.')).toBeVisible();
    await expect(page.getByText(/Açık teklif turu/).first()).toBeVisible();
    await expect(page.getByText('Pasif', { exact: true }).first()).toBeVisible();
    // Pasife alan kişi yeniden açamaz.
    await expect(page.getByRole('button', { name: 'Yeniden aç' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Ayrılış kontrol listesi' }).click();
    const access = page.getByRole('listitem').filter({ hasText: 'Erişimlerin kapatılması' });
    await access.getByRole('button', { name: 'Yapıldı' }).click();
    await access.getByLabel('Not (isteğe bağlı)').fill('VPN hesabı kapatıldı (e2e).');
    await access.getByRole('button', { name: 'Kaydet' }).click();
    await expect(access.getByText('Yapıldı', { exact: true })).toBeVisible();
    const erp = page.getByRole('listitem').filter({ hasText: 'ERP' });
    await erp.getByRole('button', { name: 'Uygulanmaz' }).click();
    await erp.getByLabel('Gerekçe').fill('ERP kaydı açılmamıştı (e2e).');
    await erp.getByRole('button', { name: 'Kaydet' }).click();
    await expect(erp.getByText('Uygulanmaz', { exact: true })).toBeVisible();
    await check(page, 'Tedarikçi kartı · Ayrılış');
    // Liste: Pasif süzgecinde görünür.
    await page.goto('/tedarikciler?asama=PASSIVE');
    await expect(page.getByRole('link', { name: firm })).toBeVisible();
    await check(page, 'Tedarikçiler · Pasif');
    await logout(page);
  } finally {
    restoreSettings = { enabled: before.enabled, publicSlug: before.publicSlug ?? (before.enabled ? slug : null), categories: before.categories };
  }
});

/** Başvuru ayarı geri yüklenir (belge türleri silinmez). afterEach zaman aşımında da çalışır; ayrı bağlamda Yönetici oturumuyla. */
let restoreSettings: { enabled: boolean; publicSlug: string | null; categories: string[] } | null = null;
test.afterEach(async ({ browser, baseURL }) => {
  if (!restoreSettings) return;
  const admin = await browser.newContext({ baseURL });
  await admin.request.post('/api/v1/dev/session', { headers: { 'X-SP-CSRF': '1' }, data: { email: 'tamer.yonetici@example.test' } });
  const restored = await admin.request.put('/api/v1/settings/supplier-applications', { headers: { 'X-SP-CSRF': '1' }, data: restoreSettings });
  await admin.close();
  restoreSettings = null;
  expect(restored.ok(), 'başvuru ayarı geri yüklendi').toBe(true);
});

// Salt okunur ekranlar her genişlikte: süzgeçler, başvuru listesi, Yönetim sekmeleri, girişsiz kapalı adres, portal ekranları (axe + taşma).
test('tedarikçi v2 ekranları: süzgeçler, Yönetim sekmeleri ve portal (her genişlik)', async ({ page }) => {
  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/tedarikciler');
  const group = page.getByRole('group', { name: 'Aşama süzgeci' });
  for (const l of ['Tümü', 'Başvuru', 'Aday', 'Onaylı', 'Pasif', 'Reddedildi']) await expect(group.getByRole('button', { name: new RegExp(`^${l}`) })).toBeVisible();
  // Eski süzgeç adresi aynen çalışır.
  await page.goto('/tedarikciler?durum=ACTIVE');
  await expect(page.getByRole('button', { name: /^Aktif/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: /Anadolu Bilişim/ }).first()).toBeVisible();
  await check(page, 'Tedarikçiler · eski süzgeç');
  await page.goto('/tedarikciler?asama=basvuru');
  await expect(page.getByRole('button', { name: /^Başvuru/ })).toHaveAttribute('aria-pressed', 'true');
  await check(page, 'Tedarikçiler · Başvuru');
  await page.goto('/tedarikciler?asama=APPROVED');
  await page.getByRole('link', { name: /Anadolu Bilişim/ }).filter({ hasNotText: 'doğrulanmadı' }).first().click();
  for (const t of ['Kayıt ve onay', 'Belgeler ve geçerlilik', 'Sözleşmeler ve projeler', 'Değerlendirme ve risk', 'Olaylar', 'Performans karnesi', 'Portal kullanıcıları']) {
    await expect(page.getByRole('tab', { name: t })).toBeVisible();
  }
  await page.getByRole('tab', { name: 'Portal kullanıcıları' }).click();
  await expect(page.getByRole('cell', { name: 'teklif.anadolu@example.test' })).toBeVisible();
  await check(page, 'Tedarikçi kartı · Portal kullanıcıları');
  await page.goto('/yonetim/tedarikci-basvurusu');
  await expect(page.getByRole('heading', { name: 'Belge türleri' })).toBeVisible();
  await check(page, 'Yönetim · Tedarikçi başvurusu');
  await page.goto('/yonetim/e-posta-kutusu');
  await expect(page.getByRole('group', { name: 'Durum süzgeci' })).toBeVisible();
  await check(page, 'Yönetim · E-posta kutusu');
  await logout(page);

  // Kapalı ya da bilinmeyen adres kurum adı göstermez.
  await page.goto('/basvuru/olmayan-adres-e2e');
  await expect(page.getByRole('heading', { name: 'Başvuru şu an kabul edilmiyor' })).toBeVisible();
  await check(page, 'Girişsiz başvuru · kapalı');
  await page.goto('/basvuru/dogrula');
  await expect(page.getByText('Doğrulanamadı', { exact: true })).toBeVisible();

  await page.goto('/');
  await page.getByRole('radio', { name: /teklif\.anadolu/ }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'Teklif davetleri', level: 1 })).toBeVisible();
  const menu = page.getByRole('navigation', { name: 'Ana menü' });
  const names = (await menu.getByRole('link').allInnerTexts()).map((t) => t.trim());
  expect(names).toEqual(['Teklif davetleri', 'Tekliflerim', 'Anketler', 'Skorum ve risk durumum', 'Belgelerim', 'Firma bilgileri']);
  await check(page, 'Portal · Teklif davetleri');
  for (const [link, heading] of [['Tekliflerim', 'Tekliflerim'], ['Skorum ve risk durumum', 'Skorum ve risk durumum'], ['Belgelerim', 'Belgelerim'], ['Firma bilgileri', 'Firma bilgileri']] as const) {
    await menu.getByRole('link', { name: link }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await check(page, `Portal · ${heading}`);
  }
});
