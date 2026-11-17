// v2 Faz 3 (D108) Görev 7: sözleşme listesi (Figma 07), ekleme sihirbazı (08–09), detay (10–11), şablonlar (12), proje Sözleşmeler sekmesi.
// Önkoşul: geliştirme API'si (4100) ve web (5174). Veri değiştiren adımlar yalnız 1440'ta. Onaycı ataması (BT departman sorumlusu, satınalma
// sorumlusu ve direktörü) test başında yapılır ve sonunda eski haline döner. Kalıcı olan: eklenen sentetik sözleşmeler, belgeler ve şablonlar
// (silme ucu yok; adlar "E2E" ile başlar). Hatırlatıcı tarihleri işçiye bağlı değildir: API'nin planladığı tarihler ekranda aranır.
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
const trDate = (d: string) => new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeZone: 'Europe/Istanbul' }).format(new Date(d));
const mutating = (name: string) => test.skip(name !== 'desktop-1440', 'veri değiştirir; yalnız 1440');

/** Tek sayfalık geçerli sentetik PDF (görüntüleyici gerçekten çizer); içerik her çağrıda farklı (aynı dosya yinelemesi olmaz). */
function pdf(text: string): Buffer {
  const stream = `BT /F1 14 Tf 60 760 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** En küçük geçerli .docx kabı (sıkıştırmasız ZIP; word/document.xml var). */
function docx(text: string): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const files: [string, string][] = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
  ];
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content); const n = Buffer.from(name); const c = crc(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); centrals.push(ch, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

type Person = { userId: string; email: string } | null;
interface Approvers { organization: { lead: Person; leadDeputy: Person; director: Person; directorDeputy: Person };
  departments: { departmentId: string; departmentName: string; head: Person; deputy: Person }[]; candidates: { userId: string; email: string }[] }

/** BT departman sorumlusu Selin, satınalma sorumlusu Kerem, direktör Mine (vekiller: Tolga, Ferda, Nur). Geri alma gövdesini döner. */
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
  return async () => { await request.put('/api/v1/approver-assignments', { headers: h, data: restore }); };
}

/** Alper'in şirketinde, Bilgi Teknolojileri'ne bağlı bir proje. */
async function btProject(request: APIRequestContext) {
  const h = await bearer(request, 'alper.satinalma@example.test');
  const me = await (await request.get('/api/v1/me', { headers: h })).json();
  const items = (await (await request.get('/api/v1/projects', { headers: h })).json()).items as { id: string; code: string; title: string; companyName: string; departmentName: string | null }[];
  const p = items.find((x) => x.departmentName === 'Bilgi Teknolojileri' && x.companyName === me.companies[0].name);
  expect(p, 'Bilgi Teknolojileri projesi bekleniyor').toBeTruthy();
  return { project: p!, companyId: me.companies[0].id as string, h };
}

/** API ile tam doldurulmuş ve gönderilmiş sözleşme (red senaryosu için hızlı kurulum). */
async function submittedContract(request: APIRequestContext, tag: string) {
  const { project, companyId, h } = await btProject(request);
  const up = await request.post('/api/v1/documents', { headers: h, multipart: { companyId, kind: 'CONTRACT', title: `E2E red ${tag}.pdf`,
    file: { name: `e2e-red-${tag}.pdf`, mimeType: 'application/pdf', buffer: pdf(`E2E red senaryosu ${tag}`) } } });
  expect(up.ok(), await up.text()).toBe(true);
  const draft = await (await request.post('/api/v1/contract-drafts', { headers: h, data: { documentVersionId: (await up.json()).documentVersionId, projectId: project.id } })).json();
  const sup = (await (await request.get('/api/v1/supplier-options', { headers: h })).json()).items.find((s: { status: string }) => s.status === 'ACTIVE');
  const members = await (await request.get('/api/v1/members', { headers: h })).json() as { id: string; displayName: string }[];
  const f = await request.put(`/api/v1/contracts/${draft.familyId}/fields`, { headers: h, data: {
    supplierId: sup.id, contractType: 'SERVICE', ownerUserId: members.find((m) => m.displayName === 'Alper Yıldız')!.id, signedOn: '2026-11-10',
    currency: 'TRY', valueType: 'FIXED', amount: '48000.00', limitBasis: 'NET', startDate: '2027-01-01', endDate: '2027-12-31', autoRenewal: false,
    noticeAmount: 30, noticeUnit: 'DAY', sourceRef: 'Madde 3, s. 1' } });
  expect(f.ok(), await f.text()).toBe(true);
  const s = await request.post(`/api/v1/contracts/${draft.familyId}/submit`, { headers: h, data: {} });
  expect(s.ok(), await s.text()).toBe(true);
  const v2 = await (await request.get(`/api/v1/contracts/${draft.familyId}/v2`, { headers: h })).json();
  return { familyId: draft.familyId as string, code: v2.family.code as string, url: `/sozlesmeler/${v2.document.contractVersionId}`, h };
}

test.describe('v2 sözleşmeler: veri değiştiren akışlar', () => {
  let restore: (() => Promise<void>) | null = null;
  test.beforeEach(async ({ request }, info) => { mutating(info.project.name); restore = await assignApprovers(request); });
  test.afterEach(async () => { await restore?.(); restore = null; });

  test('projeden ekleme → doğrulama → gönderim → üç kullanıcı sırayla onaylar → Yürürlükte + hatırlatıcı tarihleri', async ({ page, request }) => {
    test.setTimeout(180_000);
    const tag = `${Date.now()}`;
    const { project, h } = await btProject(request);
    await login(page, 'alper.satinalma@example.test');
    // Proje detayı > Sözleşmeler sekmesi: projeye bağlı ekleme (proje dolu gelir).
    await page.goto(`/projeler/${project.id}?sekme=sozlesmeler`);
    await expect(page.getByRole('tab', { name: 'Sözleşmeler' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('link', { name: 'Bu projeye sözleşme ekle' }).click();
    await expect(page.getByRole('heading', { name: 'Sözleşme ekle', level: 1 })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Sözleşme ekleme adımları' })).toContainText('Tamamla ve doğrula');
    await expect(page.getByLabel('Proje')).toHaveValue(project.id);
    await expect(page.getByLabel('Belge türü')).toHaveValue('CONTRACT');
    await axe(page, 'Sihirbaz 1');
    await page.getByLabel('Dosya').setInputFiles({ name: `e2e-sozlesme-${tag}.pdf`, mimeType: 'application/pdf', buffer: pdf(`E2E hizmet sozlesmesi ${tag}`) });
    await page.getByRole('button', { name: 'Yükle' }).click();
    await expect(page).toHaveURL(/taslak=[0-9a-f-]{36}&adim=3/);
    // 2 Oku: yapay zekâ bağlı değil; sahte puan yok.
    await expect(page.getByText('Yapay zekâ okuması bağlı değil (Faz 4); alanları belgeden siz girin.').first()).toBeVisible();
    await expect(page.getByText(/Güven %|\/ 100/)).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Sayfa 1' })).toBeVisible();
    await expect(page.getByText(/\d+ alan eksik/)).toBeVisible();
    await page.getByLabel('Tedarikçi', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Sözleşme türü').selectOption('SERVICE');
    await page.getByLabel('Sözleşme sorumlusu').selectOption({ label: 'Alper Yıldız' });
    await page.getByLabel('İmza tarihi').fill('2026-11-15');
    await page.getByLabel('Bedel türü').selectOption('FIXED');
    await page.getByLabel('Tutar', { exact: true }).fill('120.000,00');
    await page.getByLabel('KDV').selectOption('NET');
    await page.getByLabel('Başlangıç').fill('2027-01-01');
    await page.getByLabel('Bitiş').fill('2028-12-31');
    await page.getByLabel('Fesih ihbar süresi').fill('60');
    await page.getByLabel('Birim').selectOption('DAY');
    await page.getByLabel('Kaynak madde ve sayfa').fill('Madde 4, s. 2');
    const next = page.getByRole('button', { name: 'Devam: İncele ve gönder' });
    await expect(next).toBeDisabled();
    await page.getByLabel("Tutar, tarih ve VKN'yi belgeyle karşılaştırdım.").check();
    await axe(page, 'Sihirbaz 3');
    await next.click();
    await expect(page).toHaveURL(/adim=4/);
    // 4 İncele ve gönder: onaycılar, ön inceleme boş durumu, hatırlatıcı planı.
    const approvers = page.getByRole('list', { name: 'Onay sırası' });
    await expect(approvers).toContainText('Selin Arslan');
    await expect(approvers).toContainText('Kerem Aksoy');
    await expect(approvers).toContainText('Mine Kaya');
    await expect(page.getByText('gönderen siz olursanız')).toBeVisible();
    await expect(page.getByText("Yapay zekâ ön incelemesi Faz 4'te")).toBeVisible();
    const familyId = new URL(page.url()).searchParams.get('taslak')!;
    const v2 = await (await request.get(`/api/v1/contracts/${familyId}/v2`, { headers: h })).json();
    expect(v2.missing).toEqual([]);
    expect(v2.fields.amount).toBe('120000.00');
    for (const p of v2.reminders.planned) await expect(page.getByText(trDate(p.date)).first()).toBeVisible();
    await axe(page, 'Sihirbaz 4');
    await page.getByLabel('Onaycılara not (isteğe bağlı)').fill('E2E sentetik gönderim notu.');
    await page.getByRole('button', { name: 'Onaya gönder' }).click();
    await expect(page).toHaveURL(/sekme=onaylar/);
    await expect(page.getByText('Onaya gönderildi', { exact: true })).toBeVisible();
    await expect(page.getByText('Departman sorumlusu onayında').first()).toBeVisible();
    // Görev ayrılığı: ekleyen karar düğmesi görmez.
    await expect(page.getByRole('button', { name: 'Onayla' })).toHaveCount(0);
    const detail = page.url().split('?')[0]!.replace(/^https?:\/\/[^/]+/, '');
    const code = v2.family.code as string;
    await logout(page);

    // 1. adım: Selin (departman sorumlusu) İşlerim'deki görevden açar.
    await login(page, 'selin.guvenlik@example.test');
    const selinTask = (await (await request.get('/api/v1/tasks?view=mine', { headers: await bearer(request, 'selin.guvenlik@example.test') })).json())
      .items.find((t: { entityType: string; title: string }) => t.entityType === 'contract_approval_step' && t.title.includes(code));
    expect(selinTask, 'Selin için onay görevi').toBeTruthy();
    await page.getByRole('link', { name: `İşi aç: ${selinTask.title}` }).first().click();
    await expect(page).toHaveURL(/sekme=onaylar/);
    await expect(page.getByText('Gönderim notu:')).toBeVisible();
    await page.getByRole('button', { name: 'Onayla' }).click();
    await page.getByRole('button', { name: 'Onayı kaydet' }).click();
    await expect(page.getByText('Onaylandı; sıradaki: Satınalma sorumlusu.')).toBeVisible();
    await logout(page);

    for (const [email, after] of [['kerem.hukuk@example.test', 'Onaylandı; sıradaki: Satınalma direktörü.'], ['mine.anaveri@example.test', 'Onaylandı; zincir tamamlandı, hatırlatıcılar kuruldu.']] as const) {
      await login(page, email);
      await page.goto(`${detail}?sekme=onaylar`);
      await page.getByRole('button', { name: 'Onayla' }).click();
      await page.getByRole('button', { name: 'Onayı kaydet' }).click();
      await expect(page.getByText(after)).toBeVisible();
      await logout(page);
    }

    await login(page, 'alper.satinalma@example.test');
    await page.goto(`${detail}?sekme=ozet`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(code);
    await expect(page.getByText('Yürürlükte').first()).toBeVisible();
    for (const n of ['Onayladı']) await expect(page.getByText(n)).toHaveCount(3);
    await axe(page, 'Detay Özet');
    await page.getByRole('tab', { name: 'Hatırlatıcılar' }).click();
    const rem = await (await request.get(`/api/v1/contracts/${familyId}/reminders`, { headers: h })).json();
    expect(rem.scheduled).toBe(true);
    expect(rem.reminders.length).toBeGreaterThanOrEqual(4);
    for (const m of rem.reminders) await expect(page.getByText(trDate(m.dueOn)).first()).toBeVisible();
    if (!rem.emailChannel.configured) await expect(page.getByText('Gönderilmedi — e-posta kanalı yapılandırılmadı').first()).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Yeni proje açıldı' })).toBeVisible();
    await axe(page, 'Detay Hatırlatıcılar');
    await page.getByRole('tab', { name: 'Geçmiş' }).click();
    await expect(page.getByText('Onaya gönderildi')).toBeVisible();
    await page.getByRole('tab', { name: 'İnceleme' }).click();
    await expect(page.getByText("Yapay zekâ ön incelemesi Faz 4'te")).toBeVisible();
    // Listede: proje bağlı, durum Yürürlükte süzgecinde.
    await page.goto(`/projeler/${project.id}?sekme=sozlesmeler`);
    // Liste ucu aile kodunu vermez (yalnız detay); satır belge adıyla aranır.
    await expect(page.getByRole('list', { name: 'Projenin sözleşmeleri' })).toContainText(`e2e-sozlesme-${tag}.pdf`);
    await page.goto('/sozlesmeler?durum=ACTIVE');
    await expect(page.getByRole('button', { name: /Yürürlükte/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('red gerekçesiyle ekleyene döner; düzenleyip yeniden gönderince yeni tur başlar', async ({ page, request }) => {
    test.setTimeout(120_000);
    const c = await submittedContract(request, `${Date.now()}`);
    await login(page, 'selin.guvenlik@example.test');
    await page.goto(`${c.url}?sekme=onaylar`);
    await page.getByRole('button', { name: 'Reddet' }).click();
    await page.getByLabel('Red gerekçesi').fill('Kısa');
    await expect(page.getByRole('button', { name: 'Reddi kaydet' })).toBeDisabled();
    await page.getByLabel('Red gerekçesi').fill('Bedel teklifle uyuşmuyor; sentetik e2e reddi.');
    await page.getByRole('button', { name: 'Reddi kaydet' }).click();
    await expect(page.getByText('Reddedildi; sözleşme ekleyene döndü.')).toBeVisible();
    await logout(page);

    await login(page, 'alper.satinalma@example.test');
    // Red görevi ekleyene açılır (aile kimliğiyle). İşlerim en fazla 200 iş listeler ve geliştirme verisinde Alper'in 200'den fazla işi
    // olabilir; bu yüzden görev API'den doğrulanmaz, görev bağlantısının hedefi (aile adresi) açılır.
    await page.goto(`/sozlesmeler/aile/${c.familyId}?sekme=onaylar`);
    await expect(page).toHaveURL(/sekme=onaylar/);
    await expect(page.getByText('Red gerekçesi: Bedel teklifle uyuşmuyor; sentetik e2e reddi.')).toBeVisible();
    await page.getByRole('link', { name: 'Düzenle ve yeniden gönder' }).click();
    await expect(page).toHaveURL(/adim=3/);
    await page.getByLabel('Tutar', { exact: true }).fill('45000');
    await page.getByLabel("Tutar, tarih ve VKN'yi belgeyle karşılaştırdım.").check();
    await page.getByRole('button', { name: 'Devam: İncele ve gönder' }).click();
    await expect(page).toHaveURL(/adim=4/);
    await page.getByRole('button', { name: 'Onaya gönder' }).click();
    await expect(page).toHaveURL(/sekme=onaylar/);
    await expect(page.getByText(/2\. onay turu/)).toBeVisible();
    await expect(page.getByText('Departman sorumlusu onayında').first()).toBeVisible();
  });

  test('şablon yükle, listede gör, indir ve yeni sözleşmede kullan', async ({ page }) => {
    const code = `E2E-${Date.now().toString(36).toUpperCase()}`;
    await login(page, 'leyla.hukuk@example.test');
    await page.goto('/sozlesmeler');
    await page.getByRole('link', { name: 'Şablonlar' }).click();
    await expect(page.getByRole('heading', { name: 'Sözleşme şablonları', level: 1 })).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Şablon yükle (.docx)' }).click();
    await (await chooser).setFiles({ name: `${code}.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx(`Sentetik şablon ${code}`) });
    await page.getByLabel('Kod').fill(code);
    await page.getByLabel('Ad').fill(`E2E Hizmet Şablonu ${code}`);
    await page.getByRole('button', { name: 'Yükle', exact: true }).click();
    await expect(page.getByText(`${code} şablonu yüklendi.`)).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: `${code} indir` }).filter({ visible: true }).click();
    expect((await download).suggestedFilename()).toBe(`${code}.docx`);
    await page.getByRole('link', { name: `${code} ile yeni sözleşme` }).filter({ visible: true }).click();
    await expect(page).toHaveURL(/\/sozlesmeler\/ekle\?sablon=/);
    await expect(page.getByLabel('Kullanılan şablon').locator('option:checked')).toContainText(code);
    await expect(page.getByText('Tür: Hizmet · sürüm v1')).toBeVisible();
  });
});

test('eski sözleşme: İmza kontrolü varsayılan ve aynen; eski sekme adresleri çalışır; yeni sekmeler eklendi', async ({ page }, info) => {
  await login(page, 'leyla.hukuk@example.test');
  await page.goto('/sozlesmeler');
  // Liste: durum süzgeci sayılarla, imza süzgeci aynen, yeni düğmeler.
  await expect(page.getByRole('group', { name: 'Durum süzgeci' }).getByRole('button')).toHaveText([/^Tümü/, /^Onayda/, /^Yürürlükte/, /^90 gün içinde biten/, /^Eksik alan/]);
  await expect(page.getByRole('group', { name: 'İmza filtresi' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Şablonlar' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sözleşme ekle' })).toBeVisible();
  expect(await fits(page)).toBe(true);
  await axe(page, 'Liste');
  await page.getByRole('link', { name: 'Nakliye Hizmet Sözleşmesi' }).first().click();
  await expect(page.getByRole('tab', { name: 'İmza kontrolü' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Nakliye Hizmet Sözleşmesi' })).toBeVisible();
  await expect(page.getByText('İmza eksik (insan teyidi)')).toBeVisible();
  const tabs = await page.getByRole('tablist', { name: 'Sözleşme' }).getByRole('tab').allInnerTexts();
  expect(tabs).toEqual(['Özet', 'Belge', 'İnceleme', 'Onaylar', 'İmza kontrolü', 'Koşullar ve ihbar', 'Yükümlülükler', 'Fiyat, SLA ve teminat', 'Hatırlatıcılar', 'Geçmiş']);
  const base = page.url().split('?')[0]!;
  for (const [q, tab] of [['imza', 'İmza kontrolü'], ['kosullar', 'Koşullar ve ihbar'], ['yukumlulukler', 'Yükümlülükler'], ['ticari', 'Fiyat, SLA ve teminat']] as const) {
    await page.goto(`${base}?sekme=${q}`);
    await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  }
  await page.goto(`${base}?sekme=ozet`);
  await expect(page.getByRole('heading', { name: 'Sözleşme bilgileri' })).toBeVisible();
  await expect(page.getByText(/Onay kaydı yok \(eski kayıt\)|zorunlu alan eksik/).first()).toBeVisible();
  expect(await fits(page)).toBe(true);
  await axe(page, 'Eski sözleşme Özet');
  for (const tab of ['Onaylar', 'Hatırlatıcılar', 'Geçmiş', 'Belge']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForLoadState('networkidle');
    expect(await fits(page), tab).toBe(true);
    if (tab !== 'Belge') await axe(page, `Eski sözleşme ${tab}`);
  }
  if (info.project.name === 'narrow-390') await expect(page.getByRole('tablist', { name: 'Sözleşme' })).toBeVisible();
});

test('şablonlar, sihirbaz ve proje sekmesi: taşma ve erişilebilirlik; Departman kullanıcısı yükleyemez', async ({ page }) => {
  await login(page, 'tolga.teknik@example.test');
  await page.goto('/sozlesmeler/sablonlar');
  await expect(page.getByRole('heading', { name: 'Sözleşme şablonları', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Şablon yükle (.docx)' })).toHaveCount(0);
  await expect(page.getByText('.docx dosyasını buraya bırakın')).toHaveCount(0);
  expect(await fits(page)).toBe(true);
  await axe(page, 'Şablonlar (departman)');
  await page.goto('/sozlesmeler/ekle');
  await expect(page.getByLabel('Proje')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yükle' })).toBeDisabled();
  expect(await fits(page)).toBe(true);
  await axe(page, 'Sihirbaz 1 (departman)');
  await logout(page);
  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/sablonlar');
  await expect(page.getByRole('heading', { name: 'Sözleşme hatırlatıcı süreleri' })).toBeVisible();
  await expect(page.getByLabel('Süreler (gün)')).toHaveValue(/\d/);
  expect(await fits(page)).toBe(true);
  await axe(page, 'Yönetim Şablonlar');
});
