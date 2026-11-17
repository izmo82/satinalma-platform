// v2 Faz 2 (D105) Görev 6: Yönetim > Kullanıcılar ve Entra (Figma 20) ve Onaycılar (Figma 21).
// Önkoşul: geliştirme API'si ve işçisi `DIRECTORY_PROVIDER=test` + `DIRECTORY_TEST_FIXTURE=apps/api/fixtures/directory-dev.json` ile çalışır.
// Sağlayıcı yoksa testler sessizce atlanmaz, açık iletiyle başarısız olur. Veri değiştiren adımlar yalnız 1440'ta. Rol ataması
// (rol.deneme@example.test) ve Tıbbi Cihaz onaycı ataması sonunda eski haline döner. Kalıcı olan: ilk test kapsamı (GROUP, açık)
// kaydeder ve eşitleme çalıştırır; bağlantı ayarı, eşitleme çalıştırması ve directory_users satırları paylaşılan veritabanında kalır.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const TEST_LABEL = 'Test dizini (gerçek Entra değil)';

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
async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}
async function bearer(request: APIRequestContext, email: string) {
  const r = await request.post('/api/v1/dev/token', { data: { email } });
  return { authorization: `Bearer ${(await r.json()).token}` };
}

/** Sağlayıcı yapılandırılmamışsa açıkça başarısız ol (sessiz atlama yok). */
async function requireTestProvider(request: APIRequestContext) {
  const h = await bearer(request, 'tamer.yonetici@example.test');
  const conn = await (await request.get('/api/v1/directory/connection', { headers: h })).json();
  expect(conn.provider, 'Dizin sağlayıcısı yapılandırılmamış: API ve işçiyi DIRECTORY_PROVIDER=test ve DIRECTORY_TEST_FIXTURE=apps/api/fixtures/directory-dev.json ile başlatın.').not.toBeNull();
  expect(conn.provider.kind, 'Bu testler test dizini sağlayıcısıyla çalışır.').toBe('test');
  return { h, conn };
}

/** Kapsam kayıtlı değilse ya da kapalıysa API ile kaydeder; eşitlenmiş kullanıcı yoksa bir eşitleme çalıştırır ve bitmesini bekler. */
async function ensureSynced(request: APIRequestContext) {
  const { h, conn } = await requireTestProvider(request);
  if (!conn.scope || !conn.enabled) {
    expect((await request.put('/api/v1/directory/connection', { headers: h, data: { scopeType: 'GROUP', scopeValue: 'sp-satinalma-kullanicilari (sentetik)', enabled: true } })).ok()).toBe(true);
  }
  const users = await (await request.get('/api/v1/directory/users?q=rol.deneme', { headers: h })).json();
  if (users.items.length) return h;
  const s = await request.post('/api/v1/directory/sync', { headers: h, data: {} });
  const body = await s.json();
  const runId = s.status() === 202 ? body.runId : body.error?.details?.runId;
  expect(runId, `eşitleme başlatılamadı: ${JSON.stringify(body)}`).toBeTruthy();
  await expect.poll(async () => (await (await request.get('/api/v1/directory/runs', { headers: h })).json()).items.find((r: { id: string }) => r.id === runId)?.status,
    { timeout: 60_000, intervals: [1000] }).toBe('SUCCEEDED');
  return h;
}

test('Yönetici test dizinini eşitler; test etiketi bağlantı kartında ve eşitleme durumunda görünür', async ({ page, request }, info) => {
  await requireTestProvider(request);
  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/kullanicilar');
  await expect(page.getByRole('heading', { name: 'Kullanıcılar ve Entra', level: 1 })).toBeVisible();
  await expect(page.getByText("Kullanıcılar ve departmanlar Microsoft Entra ID'den alınır; yalnız seçilen kapsam eşitlenir.")).toBeVisible();
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Bağlantı ve kapsam' }) });
  await expect(card.locator('.panel-head').getByText(TEST_LABEL)).toBeVisible();
  await expect(page.getByTestId('sync-status').getByText(TEST_LABEL)).toBeVisible();
  for (const t of ['Güvenlik grubu', 'Yönetim birimi', 'OU filtresi']) await expect(card.getByRole('radio', { name: t })).toHaveCount(1);
  await expect(card.getByText('OU=Satinalma,OU=Kullanicilar,DC=moment')).toBeVisible();
  await expect(card.getByText('Kapsam dışındaki Entra kullanıcıları alınmaz.', { exact: false })).toBeVisible();
  // Kiracı: fixture'daki etiket (ham "test" sözcüğü değil).
  await expect(card.getByText('Örnek Holding test dizini (sentetik, gerçek Entra değil)')).toBeVisible();
  await card.getByRole('button', { name: 'Bağlantıyı sına' }).click();
  await expect(card.getByText('Bağlantı doğrulandı (test dizini)')).toBeVisible();
  if (info.project.name !== 'desktop-1440') return;

  // Kapsam: güvenlik grubu (test dizini grubu süzmez; OU filtresi süzer). Değer yoksa yazılır ve kaydedilir.
  await card.getByText('Güvenlik grubu', { exact: true }).click();
  const scope = card.getByLabel('Kapsam', { exact: true });
  await scope.fill('sp-satinalma-kullanicilari (sentetik)');
  const enabled = card.getByRole('checkbox', { name: /Eşitleme açık/ });
  await enabled.check();
  const save = card.getByRole('button', { name: 'Kapsamı kaydet' });
  if (await save.isEnabled()) { await save.click(); await expect(card.getByText('Kapsam kaydedildi.')).toBeVisible(); }
  await page.getByRole('button', { name: 'Şimdi eşitle' }).click();
  await expect(page.getByTestId('sync-status').getByText('Eşitleme tamamlandı.')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('sync-status').getByText(TEST_LABEL)).toBeVisible();
  await expect(page.getByTestId('sync-status')).toContainText('kullanıcı alındı');
  const users = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Eşitlenen kullanıcılar' }) });
  await expect(users.getByText('Rol Deneme (sentetik)')).toBeVisible();
  await expect(users.getByText('Kapalı Hesap (sentetik)')).toBeVisible();
  await expect(users.getByRole('row').filter({ hasText: 'Kapalı Hesap (sentetik)' })).toContainText("Entra'da kapalı ya da kapsam dışı");
  await expect(users.getByRole('row').filter({ hasText: 'Postasız Kullanıcı (sentetik)' })).toContainText('E-posta yok');
  expect(await fits(page)).toBe(true);
});

test('Yönetici sentetik kullanıcıya Departman kullanıcısı rolü verir; departman sayısı artar; geri alınır', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const h = await ensureSynced(request);
  // Önceki yarım kalmış çalıştırmadan kalan rol temizlenir (adanmış sentetik kullanıcı).
  const du = (await (await request.get('/api/v1/directory/users?q=rol.deneme', { headers: h })).json()).items[0];
  if (du.roles?.length) await request.put(`/api/v1/directory/users/${du.id}/roles`, { headers: h, data: { roles: [] } });

  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/kullanicilar');
  const deps = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Departmanlar', exact: true }) });
  const ik = deps.getByRole('listitem').filter({ hasText: 'İnsan Kaynakları' });
  const countOf = async () => Number((await ik.innerText()).match(/·\s*(\d+)/)?.[1] ?? NaN);
  await expect(ik).toContainText('·');
  const before = await countOf();

  const users = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Eşitlenen kullanıcılar' }) });
  const row = users.getByRole('row').filter({ hasText: 'Rol Deneme (sentetik)' });
  await expect(row).toContainText('Rol verilmedi');
  // Sıfır gerileme: Faz 1 düzenleyicideki kaydedilmemiş seçim, rol kaydı sonrası yeniden yüklemede kaybolmaz.
  const selinIk = page.getByRole('group', { name: 'Selin Arslan departmanları' }).getByRole('checkbox', { name: 'İnsan Kaynakları' });
  const selinBefore = await selinIk.isChecked();
  await selinIk.setChecked(!selinBefore);
  await row.getByRole('button', { name: 'Rol Deneme (sentetik) rolünü değiştir' }).click();
  await row.getByRole('checkbox', { name: 'Departman kullanıcısı' }).check();
  await row.getByRole('button', { name: 'Rol Deneme (sentetik) rollerini kaydet' }).click();
  await expect(row.getByText('Roller kaydedildi.')).toBeVisible();
  await expect(row).toContainText('Departman kullanıcısı');
  await expect(row).toContainText('Etkin');
  await expect.poll(countOf).toBe(before + 1);
  await expect(selinIk).toBeChecked({ checked: !selinBefore });
  await selinIk.setChecked(selinBefore);
  // Faz 1 departman düzenleyicisinde de görünür (aynı sekme).
  const editor = page.getByRole('group', { name: 'Rol Deneme (sentetik) departmanları' });
  await expect(editor.getByRole('checkbox', { name: 'İnsan Kaynakları' })).toBeChecked();
  await page.reload();
  await expect(row).toContainText('Departman kullanıcısı');

  // Başka kurumda kayıtlı e-posta: API'nin Türkçe iletisi görünür, hiçbir şey değişmez.
  const bora = users.getByRole('row').filter({ hasText: 'Bora Koç' });
  await bora.getByRole('button', { name: /rolünü değiştir/ }).click();
  await bora.getByRole('checkbox', { name: 'Satınalma' }).check();
  await bora.getByRole('button', { name: /rollerini kaydet/ }).click();
  await expect(bora.getByText('Bu e-posta başka bir kurumda kayıtlı; erişimi operatör tanımlar.')).toBeVisible();
  await bora.getByRole('button', { name: 'Vazgeç' }).click();

  // Geri al: rol kaldırılır, sayı eski haline döner.
  await row.getByRole('button', { name: 'Rol Deneme (sentetik) rolünü değiştir' }).click();
  await row.getByRole('checkbox', { name: 'Departman kullanıcısı' }).uncheck();
  await expect(row.getByText('Rol seçilmezse kullanıcının erişimi kaldırılır.')).toBeVisible();
  await row.getByRole('button', { name: 'Rol Deneme (sentetik) rollerini kaydet' }).click();
  await expect(row.getByText('Erişim kaldırıldı.')).toBeVisible();
  await expect.poll(countOf).toBe(before);
});

test('Onaycılar: Yönetici öneriyle departman sorumlusu ve vekil atar; yenileyince kalır; geri alınır', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  const h = await ensureSynced(request);
  const original = await (await request.get('/api/v1/approver-assignments', { headers: h })).json();
  const tc = original.departments.find((d: { departmentName: string }) => d.departmentName === 'Tıbbi Cihaz');
  expect(tc?.suggestion, 'Tıbbi Cihaz için Entra yöneticisi önerisi bekleniyor (fixture: Hande Yalın → Leyla Demir).').toBeTruthy();
  const restore = { departments: [{ departmentId: tc.departmentId, headUserId: tc.head?.userId ?? null, deputyUserId: tc.deputy?.userId ?? null }] };
  // Başlangıç durumu: atanmamış (önceki yarım çalıştırma kalıntısı temizlenir).
  await request.put('/api/v1/approver-assignments', { headers: h, data: { departments: [{ departmentId: tc.departmentId, headUserId: null, deputyUserId: null }] } });
  try {
    await login(page, 'tamer.yonetici@example.test');
    // İlk çizimde bir kare hata durumu ("Bağlantı yok") görünmez: DOM'a eklenen her metin izlenir.
    await page.addInitScript(() => {
      const seen: string[] = ((window as unknown as { __seen: string[] }).__seen = []);
      new MutationObserver(() => { if (document.body?.innerText.includes('Bağlantı yok')) seen.push('Bağlantı yok'); })
        .observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.goto('/yonetim/onaycilar');
    await expect(page.getByRole('heading', { name: 'Onaycılar', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Departman sorumluları' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toEqual([]);
    await expect(page.getByText('Her sözleşme sırayla üç onaydan geçer: departman sorumlusu, satınalma sorumlusu, satınalma direktörü.')).toBeVisible();
    for (const l of ['Satınalma sorumlusu', 'Sorumlu vekili', 'Satınalma direktörü', 'Direktör vekili']) await expect(page.getByLabel(l, { exact: true })).toBeVisible();
    const row = page.getByTestId('approver-row-Tıbbi Cihaz');
    await expect(row).toContainText('Atanmadı');
    await row.getByRole('button', { name: `Entra yöneticisi: ${tc.suggestion.displayName}` }).click();
    await expect(row.getByLabel('Tıbbi Cihaz departman sorumlusu')).toHaveValue(tc.suggestion.userId);
    await expect(row).toContainText('Vekil yok');
    const deputy = original.candidates.find((c: { userId: string; email: string }) => c.userId !== tc.suggestion.userId && c.email === 'kerem.hukuk@example.test');
    await row.getByLabel('Tıbbi Cihaz vekil').selectOption(deputy.userId);
    await expect(row).toContainText('Tanımlı');
    await page.getByRole('button', { name: 'Değişiklikleri kaydet' }).click();
    await expect(page.getByText('Onaycılar kaydedildi.')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('approver-row-Tıbbi Cihaz').getByLabel('Tıbbi Cihaz departman sorumlusu')).toHaveValue(tc.suggestion.userId);
    await expect(page.getByTestId('approver-row-Tıbbi Cihaz').getByLabel('Tıbbi Cihaz vekil')).toHaveValue(deputy.userId);
    await expect(page.getByTestId('approver-row-Tıbbi Cihaz')).toContainText('Tanımlı');
    await expect(page.getByRole('button', { name: 'Değişiklikleri kaydet' })).toBeDisabled();
  } finally {
    await request.put('/api/v1/approver-assignments', { headers: h, data: restore });
  }
});

test('Denetçi Kullanıcılar ve Entra ile Onaycılar\'ı salt okunur görür; test etiketi görünür', async ({ page, request }) => {
  await requireTestProvider(request);
  await login(page, 'deniz.denetci@example.test');
  await page.goto('/yonetim/kullanicilar');
  await expect(page.getByRole('heading', { name: 'Kullanıcılar ve Entra', level: 1 })).toBeVisible();
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Bağlantı ve kapsam' }) });
  await expect(card.getByText(TEST_LABEL).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Eşitlenen kullanıcılar' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Şimdi eşitle' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Kapsamı kaydet' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bağlantıyı sına' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /rolünü değiştir/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /departmanını birleştir/ })).toHaveCount(0);
  await expect(page.getByLabel('Departman adı')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Departmansız kayıtlar' })).toHaveCount(0);
  expect(await fits(page)).toBe(true);
  await page.goto('/yonetim/onaycilar');
  await expect(page.getByRole('heading', { name: 'Onaycılar', level: 1 })).toBeVisible();
  await expect(page.getByText('Onaycıları Yönetici atar')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Departman sorumluları' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Değişiklikleri kaydet' })).toHaveCount(0);
  await expect(page.locator('main select')).toHaveCount(0);
  expect(await fits(page)).toBe(true);
});

test('Satınalma Onaycılar\'ı salt okunur görür; Kullanıcılar ve Entra Faz 1 ekranı (Departmansız kayıtlar) yerinde', async ({ page }) => {
  await login(page, 'leyla.hukuk@example.test');
  await page.goto('/yonetim/onaycilar');
  await expect(page.getByRole('heading', { name: 'Kurum geneli' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Değişiklikleri kaydet' })).toHaveCount(0);
  await page.goto('/yonetim/kullanicilar');
  await expect(page.getByRole('heading', { name: 'Departmanlar', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kullanıcılar', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Departmansız kayıtlar' })).toBeVisible();
  await expect(page.getByLabel('Departman adı')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Bağlantı ve kapsam' })).toHaveCount(0);
  expect(await fits(page)).toBe(true);
});

test('Faz 1 öğeleri kalır, sayfalar yatay taşmaz ve axe ihlali yok (Yönetici)', async ({ page, request }) => {
  await requireTestProvider(request);
  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/kullanicilar');
  await expect(page.getByRole('heading', { name: 'Bağlantı ve kapsam' })).toBeVisible();
  // Faz 1: departman listesi + departman ekleme, kullanıcıların departman ataması, Departmansız kayıtlar.
  await expect(page.getByRole('heading', { name: 'Departmanlar', exact: true })).toBeVisible();
  await expect(page.getByLabel('Departman adı')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Departman ekle' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kullanıcılar', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Selin Arslan departmanları' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Departmansız kayıtlar' })).toBeVisible();
  await expect(page.getByText("Entra'dan gelen departmanlar kullanıcıların department alanından türetilir; Entra dışı departmanı yalnız Yönetici ekler.", { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Şimdi eşitle' })).toBeVisible();
  await expect(page.getByRole('main').getByText(/^(ADMIN|PROCUREMENT|DEPARTMENT_USER|AUDITOR)$/)).toHaveCount(0);
  expect(await fits(page)).toBe(true);
  await axe(page);
  // Birleştirme: onay penceresi geri alınamaz uyarısı gösterir; vazgeçilir (veri değişmez).
  await page.getByRole('button', { name: 'Bilgi Teknolojileri departmanını birleştir' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Bu işlem geri alınamaz')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Birleştir' })).toBeDisabled();
  await axe(page);
  await dialog.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(dialog).toHaveCount(0);

  await page.goto('/yonetim/onaycilar');
  await expect(page.getByRole('heading', { name: 'Departman sorumluları' })).toBeVisible();
  await expect(page.getByText('Sorumlusu atanmamış departmanın sözleşmeleri onaya gönderilemez.')).toBeVisible();
  expect(await fits(page)).toBe(true);
  await axe(page);
});

// Düzeltme turu 2: birleştirme sonrası liste yeniden kurulmadan yenilenir. Birleştirme ve kayıt istekleri taklit edilir (veri değişmez):
// ilk yanıtlarda taklit bir departman vardır ve Selin'e atanmıştır; birleştirmeden sonra sunucu yanıtı gerçek veriye döner.
test('birleştirme sonrası: düzenlenmemiş satır temiz kalır, kaydedilmemiş düzenleme korunur, birleştirilen kimlik gönderilmez', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'tek projede yeterli');
  await requireTestProvider(request);
  const FAKE = '00000000-0000-4000-8000-0000000000aa';
  const FAKE_NAME = 'Birleştirilecek departman (taklit)';
  let merged = false;
  const sent: unknown[] = [];
  await page.route(/\/api\/v1\/departments(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    if (!merged) body.items = [...body.items, { id: FAKE, name: FAKE_NAME, source: 'MANUAL', userCount: 1 }];
    await route.fulfill({ response: res, json: body });
  });
  await page.route(/\/api\/v1\/memberships$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (!merged) for (const m of body.items) if (m.email === 'selin.guvenlik@example.test') m.departmentIds = [...m.departmentIds, FAKE];
    await route.fulfill({ response: res, json: body });
  });
  await page.route(/\/api\/v1\/departments\/[^/]+\/merge$/, async (route) => {
    merged = true;
    await route.fulfill({ json: { sourceId: FAKE, intoId: route.request().postDataJSON().intoId, counts: {} } });
  });
  await page.route(/\/api\/v1\/memberships\/[^/]+\/departments$/, async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: {} });
  });

  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/kullanicilar');
  const selin = page.getByRole('group', { name: 'Selin Arslan departmanları' });
  await expect(selin.getByRole('checkbox', { name: FAKE_NAME })).toBeChecked();
  const selinSave = page.getByRole('button', { name: 'Selin Arslan departmanlarını kaydet' });
  await expect(selinSave).toBeDisabled();
  const tolga = page.getByRole('group', { name: 'Tolga Er departmanları' });
  const tolgaIk = tolga.getByRole('checkbox', { name: 'İnsan Kaynakları' });
  const tolgaIkBefore = await tolgaIk.isChecked();
  await tolgaIk.setChecked(!tolgaIkBefore);
  await tolga.getByRole('checkbox', { name: FAKE_NAME }).check();
  // Departmansız kayıtlar: hedef olarak taklit departman seçilir (en az bir grupta seçici varsa).
  const unassigned = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Departmansız kayıtlar' }) });
  const target = unassigned.getByRole('combobox', { name: /^Departman/ }).first();
  const hasTarget = await target.count() > 0;
  if (hasTarget) { await target.selectOption(FAKE); await expect(target).toHaveValue(FAKE); }

  await page.getByRole('button', { name: `${FAKE_NAME} departmanını birleştir` }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Hedef departman').selectOption({ label: 'Bilgi Teknolojileri' });
  await dialog.getByRole('button', { name: 'Birleştir' }).click();
  await expect(page.getByText(`${FAKE_NAME} departmanı Bilgi Teknolojileri departmanına birleştirildi.`)).toBeVisible();
  await expect(selin.getByRole('checkbox', { name: FAKE_NAME })).toHaveCount(0);

  // Düzenlenmemiş satır: temiz, Kaydet kapalı.
  await expect(selinSave).toBeDisabled();
  // Kaydedilmemiş düzenleme korunur; birleştirilen kimlik gönderilmez.
  await expect(tolgaIk).toBeChecked({ checked: !tolgaIkBefore });
  await page.getByRole('button', { name: 'Tolga Er departmanlarını kaydet' }).click();
  await expect.poll(() => sent.length).toBe(1);
  const ids = (sent[0] as { departmentIds: string[] }).departmentIds;
  expect(ids).not.toContain(FAKE);
  if (hasTarget) {
    await expect(target).toHaveValue('');
    await expect(unassigned.getByRole('button', { name: /^Departman ata/ }).first()).toBeDisabled();
  }
  // Kayıt sonrası yenileme isteği sürerken test bitmesin.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
