// v2 Faz 4 (D109) Görev 7: sözleşme yapay zekâ ekranları — Oku (Figma 08), Tamamla ve doğrula önerileri, İncele ve gönder kartı (09), İnceleme
// sekmesi (10), Yönetim > Yapay zekâ (23).
// Önkoşul: geliştirme API'si (4100) ve web (5174) AI_PROVIDER=test ile; `ai.run` işini çeken bir işçi de AI_PROVIDER=test ile çalışmalı
// (`npm run worker -w @sp/api`). Katalogda test-fixture satırı (geliştirme seed'i / ensureTestAiCatalog) olmalı.
// TEST SAĞLAYICISI GERÇEK DEĞİLDİR: buradaki okuma ve puanlar gerçek okuma ya da gerçek doğruluk değildir; ekranda etiketiyle görünür.
// Veri değiştiren adımlar yalnız 1440'ta. Değiştirilen ayarlar (kiracı yapay zekâ politikası, inceleme eşiği, onaycı ataması) test sonunda eski
// haline döner. Kalıcı olan: "E2E AI" adlı sentetik sözleşmeler, belgeler ve defter satırları (silme ucu yok).
// Not: politika testte açılırken başka spec'ler paralel koşarsa onların taslakları da okunur; bu dosya diğer sözleşme spec'lerinden ayrı koşulur.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace('.', '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: 'İşlerim' })).toBeVisible();
}
const logout = async (page: Page) => { await page.getByRole('button', { name: 'Çıkış' }).first().click(); await expect(page.getByRole('button', { name: 'Oturum aç' })).toBeVisible(); };
async function bearer(request: APIRequestContext, email: string) {
  const r = await request.post('/api/v1/dev/token', { data: { email } });
  return { authorization: `Bearer ${(await r.json()).token}` };
}
async function axe(page: Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${name}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
const fits = async (page: Page) => (await page.locator('main').waitFor(), page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
const mutating = (name: string) => test.skip(name !== 'desktop-1440', 'veri değiştirir; yalnız 1440');
const TEST_LABEL = 'Test sağlayıcısı — gerçek değil';

/** Etiketli satırlı tek sayfalık SENTETİK sözleşme PDF'i (test sağlayıcısı "Etiket: değer" satırlarını okur). Türkçe harfler ASCII'ye düşer. */
function contractPdf(lines: string[]): Buffer {
  const esc = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[ıİşŞğĞ]/g, (ch) => ({ ı: 'i', İ: 'I', ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G' } as Record<string, string>)[ch]!).replace(/[()\\]/g, '\\$&');
  const stream = `BT /F1 12 Tf 60 780 Td 16 TL ${lines.map((l) => `(${esc(l)}) '`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const contractLines = (tag: string) => [
  'SENTETIK TEST BELGESI - gercek sozlesme degildir',
  `Sozlesme Basligi: E2E AI hizmet ${tag}`, 'Sozlesme Turu: Hizmet', `Sozlesme No: SNT-${tag}`,
  'Imza Tarihi: 15.12.2026', 'Baslangic Tarihi: 01.01.2027', 'Bitis Tarihi: 31.12.2027', 'Sozlesme Bedeli: 48.000,00 TRY',
  'Ihbar Suresi: 30 gun', 'Odeme Vadesi: 45 gun', 'Yetkili Mahkeme: Istanbul Merkez',
  'Madde 7 - Yuklenici sinirsiz sorumluluk kabul eder.', 'Madde 8 - Alici fiyatlari tek tarafli degistirebilir.',
];

type Person = { userId: string; email: string } | null;
interface Approvers { organization: { lead: Person; leadDeputy: Person; director: Person; directorDeputy: Person };
  departments: { departmentId: string; departmentName: string; head: Person; deputy: Person }[]; candidates: { userId: string; email: string }[] }

/** contracts-v2 ile aynı onaycı ataması (BT: Selin; satınalma sorumlusu Kerem; direktör Mine); geri alma döner. */
async function assignApprovers(request: APIRequestContext) {
  const h = await bearer(request, 'tamer.yonetici@example.test');
  const original = await (await request.get('/api/v1/approver-assignments', { headers: h })).json() as Approvers;
  const id = (email: string) => original.candidates.find((c) => c.email === email)!.userId;
  const bt = original.departments.find((d) => d.departmentName === 'Bilgi Teknolojileri')!;
  const restore = {
    organization: { leadUserId: original.organization.lead?.userId ?? null, leadDeputyUserId: original.organization.leadDeputy?.userId ?? null,
      directorUserId: original.organization.director?.userId ?? null, directorDeputyUserId: original.organization.directorDeputy?.userId ?? null },
    departments: [{ departmentId: bt.departmentId, headUserId: bt.head?.userId ?? null, deputyUserId: bt.deputy?.userId ?? null }],
  };
  const set = await request.put('/api/v1/approver-assignments', { headers: h, data: {
    organization: { leadUserId: id('kerem.hukuk@example.test'), leadDeputyUserId: id('ferda.finans@example.test'), directorUserId: id('mine.anaveri@example.test'), directorDeputyUserId: id('nur.finansonay@example.test') },
    departments: [{ departmentId: bt.departmentId, headUserId: id('selin.guvenlik@example.test'), deputyUserId: id('tolga.teknik@example.test') }] } });
  expect(set.ok(), await set.text()).toBe(true);
  return async () => {
    const r = await request.put('/api/v1/approver-assignments', { headers: h, data: restore });
    expect(r.ok(), `onaycı ataması geri alınamadı: ${await r.text()}`).toBe(true);
  };
}

async function btProject(request: APIRequestContext) {
  const h = await bearer(request, 'alper.satinalma@example.test');
  const me = await (await request.get('/api/v1/me', { headers: h })).json();
  const items = (await (await request.get('/api/v1/projects', { headers: h })).json()).items as { id: string; departmentName: string | null; companyName: string; status: string }[];
  const p = items.find((x) => x.departmentName === 'Bilgi Teknolojileri' && x.companyName === me.companies[0].name && !['CANCELLED', 'NO_AWARD'].includes(x.status));
  expect(p, 'Bilgi Teknolojileri projesi bekleniyor').toBeTruthy();
  return { project: p!, h };
}

type Policy = null | { allowedProviders: string[]; allowedRegions: string[]; monthlyBudget: string | null; budgetCurrency: string; dailyCallLimit: number | null; allowUpgrade: boolean };
const TEST_POLICY = { allowedProviders: ['test-fixture'], allowedRegions: ['local'], monthlyBudget: '5.00', budgetCurrency: 'USD', dailyCallLimit: null, allowUpgrade: false };
async function setPolicy(request: APIRequestContext, p: Policy) {
  const h = await bearer(request, 'tamer.yonetici@example.test');
  const r = p ? await request.put('/api/v1/ai/policy', { headers: h, data: p }) : await request.delete('/api/v1/ai/policy', { headers: h });
  expect(r.ok(), await r.text()).toBe(true);
}
async function setThreshold(request: APIRequestContext, v: number) {
  const r = await request.put('/api/v1/ai/contract-settings', { headers: await bearer(request, 'tamer.yonetici@example.test'), data: { reviewThreshold: v } });
  expect(r.ok(), await r.text()).toBe(true);
}

test.describe('v2 sözleşme yapay zekâ: veri değiştiren akışlar (test sağlayıcısı)', () => {
  test.describe.configure({ mode: 'serial' });
  let original: { policy: Policy; threshold: number } | null = null;
  let restoreApprovers: (() => Promise<void>) | null = null;
  test.beforeEach(async ({ request }, info) => {
    mutating(info.project.name);
    const ov = await (await request.get('/api/v1/ai/overview', { headers: await bearer(request, 'tamer.yonetici@example.test') })).json();
    expect(ov.provider?.kind, 'API AI_PROVIDER=test ile çalışmalı').toBe('test');
    original = { policy: ov.policy, threshold: ov.contractSettings.reviewThreshold };
    await setPolicy(request, TEST_POLICY);
    restoreApprovers = await assignApprovers(request);
  });
  test.afterEach(async ({ request }) => {
    if (original) { await setPolicy(request, original.policy); await setThreshold(request, original.threshold); }
    await restoreApprovers?.();
    original = null; restoreApprovers = null;
  });

  test('ekle → Oku → kritik öneriyi kullan → kaydet → inceleme kartı (eşik altı uyarı) → gönder; İnceleme sekmesi; Yönetim defteri', async ({ page, request }) => {
    test.setTimeout(240_000);
    const tag = `${Date.now()}`;
    const { project, h } = await btProject(request);
    // Eşik 99: test sağlayıcısının bulguları (sınırsız sorumluluk, tek taraflı değişiklik) puanı eşiğin altına indirir.
    await setThreshold(request, 99);
    await login(page, 'alper.satinalma@example.test');
    await page.goto(`/sozlesmeler/ekle?proje=${project.id}`);
    await expect(page.getByLabel('Proje')).toHaveValue(project.id);
    await page.getByLabel('Dosya').setInputFiles({ name: `e2e-ai-${tag}.pdf`, mimeType: 'application/pdf', buffer: contractPdf(contractLines(tag)) });
    await page.getByRole('button', { name: 'Yükle' }).click();

    // 2 Oku: iş durumu, alan + sayfa + güven + alıntı, test etiketi.
    await expect(page).toHaveURL(/taslak=[0-9a-f-]{36}&adim=2/, { timeout: 20_000 });
    const familyId = new URL(page.url()).searchParams.get('taslak')!;
    const read = page.locator('section[aria-labelledby="read-h"]');
    await expect(read.getByText('Tamamlandı')).toBeVisible({ timeout: 45_000 });
    await expect(read.getByText(TEST_LABEL, { exact: true })).toBeVisible();
    const list = page.getByRole('list', { name: 'Okunan alanlar' });
    await expect(list).toContainText('Tutar· siz onaylarsınız');
    await expect(list).toContainText('48.000,00');
    await expect(list.getByText('Okunamadı').first()).toBeVisible(); // VKN belgede yok → MISSING
    await page.getByRole('button', { name: "Tutar: belgede sayfa 1'yı aç ve alıntıyı göster" }).click();
    await expect(page.getByText('Tutar · s. 1 alıntısı:')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Sayfa 1' })).toBeVisible();
    await axe(page, 'Oku');
    expect(await fits(page)).toBe(true);
    await page.getByRole('button', { name: 'Devam: Tamamla ve doğrula' }).click();

    // 3 Tamamla ve doğrula: kritik alan boş + öneri; kritik olmayan HIGH alan "Yapay zekâ" etiketiyle dolu.
    await expect(page).toHaveURL(/adim=3/);
    await expect(page.getByLabel('Tutar', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('İmza tarihi', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Sözleşme no (isteğe bağlı)', { exact: true })).toHaveValue(`SNT-${tag}`);
    await expect(page.getByText('Yapay zekâ', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Sorulan alan').first()).toBeVisible();
    for (const f of ['Tutar', 'Para birimi', 'İmza tarihi', 'Başlangıç tarihi', 'Bitiş tarihi', 'Sözleşme türü']) await page.getByRole('button', { name: `Öneriyi kullan: ${f}` }).click();
    await expect(page.getByLabel('Tutar', { exact: true })).toHaveValue('48.000,00');
    await expect(page.getByLabel('İmza tarihi', { exact: true })).toHaveValue('2026-12-15');
    await page.getByLabel('Tedarikçi', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Sözleşme sorumlusu', { exact: true }).selectOption({ label: 'Alper Yıldız' });
    await page.getByLabel('Bedel türü', { exact: true }).selectOption('FIXED');
    await page.getByLabel('KDV', { exact: true }).selectOption('NET');
    await page.getByLabel('Kaynak madde ve sayfa', { exact: true }).fill('Madde 4, s. 1');
    await page.getByLabel("Tutar, tarih ve VKN'yi belgeyle karşılaştırdım.").check(); // Faz 3 onay kutusu sürer
    await axe(page, 'Tamamla ve doğrula');
    await page.getByRole('button', { name: 'Devam: İncele ve gönder' }).click();
    await expect(page).toHaveURL(/adim=4/);
    const ex = await (await request.get(`/api/v1/contracts/${familyId}/extractions`, { headers: h })).json();
    const dec = Object.fromEntries(ex.fields.map((x: { field: string; decision: string }) => [x.field, x.decision]));
    expect(dec).toMatchObject({ amount: 'CONFIRMED', currency: 'CONFIRMED', signedOn: 'CONFIRMED', startDate: 'CONFIRMED', endDate: 'CONFIRMED', contractType: 'CONFIRMED' });
    const v2a = await (await request.get(`/api/v1/contracts/${familyId}/v2`, { headers: h })).json();
    expect(v2a.fields.amount).toBe('48000.00');

    // 4 İncele ve gönder: inceleme kartı (puan, bulgu sayıları, model/istem, uyarı), eşik altı öneri bandı; gönderim açık.
    const card = page.locator('section[aria-labelledby="review-card-h"]');
    await expect(card.getByText('/ 100')).toBeVisible({ timeout: 45_000 });
    await expect(card.getByText(TEST_LABEL, { exact: true })).toBeVisible();
    await expect(card.getByText('Yapay zekâ ön incelemesidir, hukuki görüş değildir.', { exact: false })).toBeVisible();
    await expect(card.getByText('Sınırsız sorumluluk')).toBeVisible();
    await expect(card.getByText('sozlesme-inceleme-2026-11-v1')).toBeVisible();
    await expect(card.getByText('Puan eşiğin altında; ek onaycı (ör. kurumun hukuk danışmanı) eklemeniz önerilir.')).toBeVisible();
    await card.getByRole('button', { name: 'Onaycı ekle' }).click();
    await expect(page.getByLabel('Onaycı ekle')).toBeFocused();
    const send = page.getByRole('button', { name: 'Onaya gönder' });
    await expect(send).toBeEnabled();
    await axe(page, 'İncele ve gönder');
    expect(await fits(page)).toBe(true);
    await send.click();
    await expect(page).toHaveURL(/sekme=onaylar/);
    await expect(page.getByRole('heading', { name: 'Ön inceleme (bilgi)' })).toBeVisible();
    const audit = await (await request.get(`/api/v1/audit-events?entityId=${familyId}`, { headers: await bearer(request, 'tamer.yonetici@example.test') })).json();
    expect(audit.items.map((a: { action: string }) => a.action)).toContain('contract.review_below_threshold_acknowledged');

    // İnceleme sekmesi (Figma 10): puan halkası, alt puan tablosu, önem süzgeci, sayfa bağlantısı Belge sekmesine.
    await page.getByRole('tab', { name: 'İnceleme' }).click();
    await expect(page.getByRole('img', { name: /Ön inceleme puanı \d+ \/ 100/ })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Alt puanlar' })).toContainText('Sorumluluk sınırı');
    await page.getByRole('group', { name: 'Önem süzgeci' }).getByRole('button', { name: /Yüksek/ }).click();
    await expect(page.getByText('Sınırsız sorumluluk')).toBeVisible();
    await expect(page.getByText('Tek taraflı değişiklik hakkı')).toHaveCount(0);
    await axe(page, 'İnceleme sekmesi');
    await page.getByRole('link', { name: "Belgede s. 1'yı aç" }).first().click();
    await expect(page).toHaveURL(/sekme=belge&sayfa=1/);
    await expect(page.getByRole('group', { name: 'Sayfa 1' })).toBeVisible();
    await logout(page);

    // Onaycı (Selin, departman sorumlusu): puan özeti bilgi olarak; inceleme isteyemez.
    await login(page, 'selin.guvenlik@example.test');
    await page.goto(`/sozlesmeler/${v2a.document.contractVersionId}?sekme=onaylar`);
    await expect(page.getByRole('heading', { name: 'Ön inceleme (bilgi)' })).toBeVisible();
    await expect(page.getByText('Onay kararınızı etkilemez', { exact: false })).toBeVisible();
    await page.getByRole('tab', { name: 'İnceleme' }).click();
    await expect(page.getByRole('img', { name: /Ön inceleme puanı/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /İncele/ })).toHaveCount(0);
    await logout(page);

    // Yönetim > Yapay zekâ: sağlayıcı kartı, defter satırı (test etiketi), eşik, doğruluk NOT_RUN; v1 bölümleri yerinde.
    await login(page, 'tamer.yonetici@example.test');
    await page.goto('/yonetim/yapay-zeka');
    await expect(page.getByRole('heading', { name: 'Model ve sağlayıcı' })).toBeVisible();
    await expect(page.getByText('AI_MODEL_ID')).toBeVisible();
    const ledger = page.getByRole('table', { name: 'Yapay zekâ çağrı defteri' });
    const row = ledger.getByRole('row').filter({ hasText: 'sozlesme-inceleme-2026-11-v1' }).first();
    await expect(row).toContainText('AI14');
    await expect(row).toContainText('Alper Yıldız');
    await expect(row).toContainText(TEST_LABEL);
    await expect(row).toContainText('1.000 / 200');
    await expect(row.getByRole('button', { name: 'Yeniden dene' })).toHaveCount(0);
    await expect(page.getByLabel('Ön inceleme eşiği (0–100)')).toHaveValue('99');
    await expect(page.getByRole('heading', { name: 'Doğruluk ölçümü' })).toBeVisible();
    await expect(page.getByText('Ölçülmedi (NOT_RUN)', { exact: true })).toBeVisible();
    for (const hd of ['Görev matrisi', 'Kiracı politikası', 'Kullanım', 'Model kaydı']) await expect(page.getByRole('heading', { name: hd })).toBeVisible();
    await axe(page, 'Yönetim Yapay zekâ');
  });

  test('politika yokken okuma çalışmaz: sebep görünür, elle akış; politika gelince "Yeniden oku"', async ({ page, request }) => {
    test.setTimeout(120_000);
    const tag = `${Date.now()}`;
    const { project } = await btProject(request);
    await setPolicy(request, null);
    await login(page, 'alper.satinalma@example.test');
    await page.goto(`/sozlesmeler/ekle?proje=${project.id}`);
    await page.getByLabel('Dosya').setInputFiles({ name: `e2e-ai-elle-${tag}.pdf`, mimeType: 'application/pdf', buffer: contractPdf(contractLines(tag)) });
    await page.getByRole('button', { name: 'Yükle' }).click();
    // Faz 3 davranışı: doğrudan 3. adım; bantta açık sebep; kritik alan boş, öneri yok.
    await expect(page).toHaveURL(/taslak=[0-9a-f-]{36}&adim=3/, { timeout: 20_000 });
    await expect(page.getByText(/Yapay zekâ okuması çalışmadı:/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Öneriyi kullan/ })).toHaveCount(0);
    await expect(page.getByLabel('Sözleşme no (isteğe bağlı)', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Geri' }).click();
    await expect(page).toHaveURL(/adim=2/);
    await expect(page.getByRole('button', { name: 'Alanları elle girin' })).toBeVisible();
    await expect(page.getByText('Bekliyor', { exact: true })).toBeVisible();
    await axe(page, 'Oku (çalışmadı)');
    // Politika geri gelince aynı iş yeniden yönlendirilir (çalışmamış iş ücret yaratmamıştır).
    await setPolicy(request, TEST_POLICY);
    await page.getByRole('button', { name: 'Yeniden oku' }).click();
    await expect(page.locator('section[aria-labelledby="read-h"]').getByText('Tamamlandı')).toBeVisible({ timeout: 45_000 });
    await page.getByRole('button', { name: 'Devam: Tamamla ve doğrula' }).click();
    await expect(page.getByRole('button', { name: 'Öneriyi kullan: Tutar' })).toBeVisible();
  });
});

test.describe('v2 sözleşme yapay zekâ: görünüm (her genişlik)', () => {
  test('İnceleme sekmesi ve Yönetim > Yapay zekâ taşmaz, erişilebilir', async ({ page, request }) => {
    const h = await bearer(request, 'alper.satinalma@example.test');
    const items = (await (await request.get('/api/v1/contracts?limit=50', { headers: h })).json()).items as { id: string; familyId: string; title: string }[];
    let target: string | null = null;
    let family: string | null = null;
    for (const it of items.filter((x) => x.title.startsWith('E2E AI') || x.title.startsWith('e2e-ai'))) {
      const r = await (await request.get(`/api/v1/contracts/${it.familyId}/reviews`, { headers: h })).json();
      if (r.current) { target = it.id; family = it.familyId; break; }
    }
    test.skip(!target, 'İncelenmiş E2E AI sözleşmesi yok (önce 1440 veri adımı koşmalı)');
    await login(page, 'alper.satinalma@example.test');
    // Sihirbaz Oku ve Tamamla adımları (gönderilmiş sözleşmede salt görünüm; kayıt yapılmaz).
    await page.goto(`/sozlesmeler/ekle?taslak=${family}&adim=2`);
    await expect(page.locator('section[aria-labelledby="read-h"]').getByText('Tamamlandı')).toBeVisible();
    expect(await fits(page)).toBe(true);
    await axe(page, 'Oku');
    await page.getByRole('button', { name: 'Devam: Tamamla ve doğrula' }).click();
    await expect(page.getByText('Belgeden okunan öneriler')).toBeVisible();
    expect(await fits(page)).toBe(true);
    await page.goto(`/sozlesmeler/${target}?sekme=inceleme`);
    await expect(page.getByRole('img', { name: /Ön inceleme puanı \d+ \/ 100/ })).toBeVisible();
    await expect(page.getByText(TEST_LABEL).first()).toBeVisible();
    expect(await fits(page)).toBe(true);
    await axe(page, 'İnceleme sekmesi');
    await logout(page);
    await login(page, 'tamer.yonetici@example.test');
    await page.goto('/yonetim/yapay-zeka');
    await expect(page.getByRole('heading', { name: 'Çağrı defteri · son çalıştırmalar' })).toBeVisible();
    expect(await fits(page)).toBe(true);
    await axe(page, 'Yönetim Yapay zekâ');
  });
});
