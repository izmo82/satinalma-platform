// v2 Faz 7 (D112) Görev 7: Faturalar eşleştirme kuyruğu ve elle bağlama (Figma 17), proje Faturalar / Beyanlar / Uyum denetimi sekmeleri
// (Figma 18), proje tamamlama ve çıkar çatışması beyanı, Yönetim > Satınalma kuralları (Figma 19), Raporlar > Uyum denetimleri (Denetçi).
// Önkoşul: geliştirme API'si (4100), işçi (compliance.audit işleri) ve web (5174). Veri değiştiren adımlar yalnız 1440'ta; hepsi sentetik
// (adlar "E2E Faz7"). Demo faturalar (ANB2026000101, ANB2026000102, EGE2026000877) kullanılmaz ve değiştirilmez. Onaycı ataması test başında
// yapılır ve sonunda eski haline döner. Kalıcı olanlar: sentetik proje, sözleşme, fatura, beyanlar, yayımlanan kural seti sürümü.
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
const istanbul = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d);
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DEMO = ['ANB2026000101', 'ANB2026000102', 'EGE2026000877'];

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

type Person = { userId: string; email: string } | null;
interface Approvers { organization: { lead: Person; leadDeputy: Person; director: Person; directorDeputy: Person };
  departments: { departmentId: string; departmentName: string; head: Person; deputy: Person }[]; candidates: { userId: string; email: string }[] }
/** contracts-v2 ile aynı onaycılar (BT sorumlusu Selin, satınalma sorumlusu Kerem, direktör Mine); geri alma işlevini döner. */
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
  return async () => { const r = await request.put('/api/v1/approver-assignments', { headers: h, data: restore }); expect(r.ok(), await r.text()).toBe(true); };
}

const DECIDERS = ['mine.anaveri@example.test', 'kerem.hukuk@example.test', 'leyla.hukuk@example.test', 'ferda.finans@example.test', 'nur.finansonay@example.test'];

/**
 * API ile tam sentetik proje: BT departmanı, 1 kalem (2 adet), fiyat %70 + kalite %30 (Tolga puanlar → katılımcı), üç portal tedarikçisi teklif
 * verir, tur erken kapanır, değerlendirme, Anadolu'ya tahsis, onay; projeye bağlı ve onaylı sözleşme (2.000,00 ₺). Proje CONTRACTING kalır.
 */
async function sourcedProject(request: APIRequestContext, tag: string) {
  const alper = await bearer(request, 'alper.satinalma@example.test');
  const me = await (await request.get('/api/v1/me', { headers: alper })).json();
  const companyId = me.companies[0].id as string;
  const bt = (me.departments as { id: string; name: string }[]).find((d) => d.name === 'Bilgi Teknolojileri')!;
  const title = `E2E Faz7 uyum ${tag}`;
  const created = await request.post('/api/v1/projects', { headers: alper, data: { companyId, departmentId: bt.id, title, category: 'Bilgi teknolojileri',
    need: 'Sentetik uyum denetimi senaryosu (e2e).', currency: 'TRY', budget: '2500', budgetVerified: false,
    lines: [{ description: 'Sentetik destek hizmeti', unit: 'adet', quantity: '2' }],
    criteria: [{ code: 'PRICE', name: 'Fiyat', kind: 'PRICE', weight: '70' }, { code: 'QUAL', name: 'Kalite', kind: 'SCORE', weight: '30' }] } });
  expect(created.status(), await created.text()).toBe(201);
  const projectId = (await created.json()).id as string;
  const get = async (h: Record<string, string>) => (await request.get(`/api/v1/projects/${projectId}`, { headers: h })).json();
  let d = await get(alper);
  const opts = (await (await request.get('/api/v1/supplier-options', { headers: alper })).json()).items as { id: string; label: string; status: string }[];
  const sup = (re: RegExp) => opts.find((o) => re.test(o.label) && o.status === 'ACTIVE')!;
  const firms = [{ s: sup(/^Anadolu Bilişim Hizmetleri/), user: 'teklif.anadolu@example.test', price: '1000' },
    { s: sup(/^Ege Sistem/), user: 'teklif.ege@example.test', price: '1100' }, { s: sup(/^Kuzey Teknoloji/), user: 'teklif.kuzey@example.test', price: '1200' }];
  const closesAt = new Date(Date.now() + 8 * 86400_000).toISOString();
  const round = await request.post(`/api/v1/projects/${projectId}/rounds`, { headers: { ...alper, 'if-match': d.project.etag }, data: { closesAt, supplierIds: firms.map((f) => f.s.id) } });
  expect(round.ok(), await round.text()).toBe(true);
  // Yayın onayı: karar yetkisi olan kullanıcılar sırayla (politika adımları sunucuda).
  d = await get(alper);
  for (let i = 0; i < 6 && d.round?.status === 'PENDING_APPROVAL'; i++) {
    for (const u of DECIDERS) {
      const h = await bearer(request, u);
      const x = await get(h);
      if (x.round?.status === 'PENDING_APPROVAL' && (x.round.approval ? x.round.approval.canDecide : x.can.approvePublish && !x.round.requestedByMe)) {
        const r = await request.post(`/api/v1/rfq-rounds/${x.round.id}/decision`, { headers: h, data: { approve: true, note: 'E2E onay' } });
        expect(r.ok(), await r.text()).toBe(true);
        break;
      }
    }
    d = await get(alper);
  }
  expect(d.round?.status).toBe('OPEN');
  const lineId = d.lines[0].id as string;
  for (const f of firms) {
    const r = await request.post(`/api/v1/portal/rounds/${d.round.id}/bids`, { headers: { ...(await bearer(request, f.user)), 'idempotency-key': `e2e-f7-${tag}-${f.user.split('@')[0]!.replace('.', '-')}` }, data: { currency: 'TRY',
      lines: [{ projectLineId: lineId, unit: 'adet', quantity: '2', unitPrice: f.price, scope: 'INCLUDED' }] } });
    expect(r.ok(), await r.text()).toBe(true);
  }
  for (const u of DECIDERS) {
    const r = await request.post(`/api/v1/rfq-rounds/${d.round.id}/close`, { headers: await bearer(request, u), data: { reason: 'E2E sentetik senaryo: teklifler tamam, erken kapanış.' } });
    if (r.ok()) break;
  }
  d = await get(alper);
  expect(d.project.status).toBe('EVALUATION');
  // Departman kullanıcısı Tolga kalite puanı verir (katılımcı olur → beyan görevi).
  const tolga = await bearer(request, 'tolga.teknik@example.test');
  const cmp = await (await request.get(`/api/v1/projects/${projectId}/comparison`, { headers: alper })).json();
  for (const b of cmp.bids as { bidId: string }[]) {
    const r = await request.post(`/api/v1/bids/${b.bidId}/scores`, { headers: tolga, data: { criterionCode: 'QUAL', score: '80', evidence: 'E2E: referans projeler ve demo incelendi.' } });
    expect(r.ok(), await r.text()).toBe(true);
  }
  const ev = await request.post(`/api/v1/projects/${projectId}/evaluations`, { headers: alper });
  expect(ev.ok(), await ev.text()).toBe(true);
  const aw = await request.post(`/api/v1/projects/${projectId}/awards`, { headers: alper, data: { evaluationId: (await ev.json()).id,
    rationale: 'En düşük toplam maliyet ve yeterli kalite puanı (E2E).', allocations: [{ projectLineId: lineId, supplierId: firms[0]!.s.id, quantity: '2' }] } });
  expect(aw.ok(), await aw.text()).toBe(true);
  d = await get(alper);
  for (let i = 0; i < 6 && d.project.status === 'AWARD_APPROVAL'; i++) {
    for (const u of DECIDERS) {
      const h = await bearer(request, u);
      const x = await get(h);
      const open = (x.awards as { id: string; status: string; proposedByMe: boolean; approval: { canDecide: boolean } | null }[]).find((a) => a.status === 'PROPOSED');
      if (open && (open.approval ? open.approval.canDecide : x.can.decide && !open.proposedByMe)) {
        const r = await request.post(`/api/v1/awards/${open.id}/decision`, { headers: h, data: { approve: true, note: 'E2E onay' } });
        expect(r.ok(), await r.text()).toBe(true);
        break;
      }
    }
    d = await get(alper);
  }
  expect(d.project.status).toBe('CONTRACTING');
  // Sözleşme: projeye bağlı, Anadolu, 2.000,00 ₺ (KDV hariç), bugünden bir yıl; onay zinciri Selin → Kerem → Mine.
  const today = istanbul(new Date());
  const up = await request.post('/api/v1/documents', { headers: alper, multipart: { companyId, kind: 'CONTRACT', title: `E2E Faz7 sözleşme ${tag}.pdf`,
    file: { name: `e2e-faz7-${tag}.pdf`, mimeType: 'application/pdf', buffer: pdf(`E2E Faz7 sozlesme ${tag}`) } } });
  expect(up.ok(), await up.text()).toBe(true);
  const draft = await (await request.post('/api/v1/contract-drafts', { headers: alper, data: { documentVersionId: (await up.json()).documentVersionId, projectId } })).json();
  const members = await (await request.get('/api/v1/members', { headers: alper })).json() as { id: string; displayName: string }[];
  const f = await request.put(`/api/v1/contracts/${draft.familyId}/fields`, { headers: alper, data: {
    supplierId: firms[0]!.s.id, contractType: 'SERVICE', ownerUserId: members.find((m) => m.displayName === 'Alper Yıldız')!.id, signedOn: today,
    currency: 'TRY', valueType: 'FIXED', amount: '2000.00', limitBasis: 'NET', startDate: today, endDate: addDays(today, 365), autoRenewal: false,
    noticeAmount: 30, noticeUnit: 'DAY', sourceRef: 'Madde 2, s. 1' } });
  expect(f.ok(), await f.text()).toBe(true);
  const s = await request.post(`/api/v1/contracts/${draft.familyId}/submit`, { headers: alper, data: {} });
  expect(s.ok(), await s.text()).toBe(true);
  for (const u of ['selin.guvenlik@example.test', 'kerem.hukuk@example.test', 'mine.anaveri@example.test']) {
    const h = await bearer(request, u);
    const item = ((await (await request.get('/api/v1/contract-approvals/mine', { headers: h })).json()).items as { stepId: string; canDecide: boolean; contract: { familyId: string } }[])
      .find((x) => x.contract.familyId === draft.familyId && x.canDecide);
    expect(item, `${u} onay adımı`).toBeTruthy();
    const r = await request.post(`/api/v1/contract-approval-steps/${item!.stepId}/decision`, { headers: h, data: { decision: 'APPROVED' } });
    expect(r.ok(), await r.text()).toBe(true);
  }
  const v2 = await (await request.get(`/api/v1/contracts/${draft.familyId}/v2`, { headers: alper })).json();
  expect(v2.status.code).toBe('APPROVED');
  return { projectId, title, code: d.project.code as string, familyId: draft.familyId as string, contractCode: v2.family.code as string, companyId,
    supplierId: firms[0]!.s.id, today, alper };
}

test.describe('v2 Faz 7: fatura eşleştirme ve uyum denetimi (veri değiştiren)', () => {
  let restore: (() => Promise<void>) | null = null;
  test.beforeEach(async ({ request }, info) => { mutating(info.project.name); restore = await assignApprovers(request); });
  test.afterEach(async () => { await restore?.(); restore = null; });

  test('kural taslağı → yayım; kuyruktan elle bağlama → proje Faturalar; beyanlar; tamamla → rapor → PDF; Denetçi salt okur', async ({ page, request }) => {
    test.setTimeout(300_000);
    const tag = `${Date.now()}`;
    const demoBefore = await (await request.get('/api/v1/invoices', { headers: await bearer(request, 'alper.satinalma@example.test') })).json();
    const demoState = (l: { items: { invoiceNo: string; matchState: string; matched: boolean; departmentId: string | null }[] }) =>
      JSON.stringify(l.items.filter((x) => DEMO.includes(x.invoiceNo)).map((x) => [x.invoiceNo, x.matchState, x.matched, x.departmentId]).sort());

    // --- 1. Yönetici: kural seti taslağı (varsayılan katalog ya da yürürlükteki sürümün kopyası) → bir kural kaydı → bugün yayım ---
    await login(page, 'tamer.yonetici@example.test');
    await page.goto('/yonetim/satinalma-kurallari');
    await expect(page.getByRole('heading', { name: 'Satınalma kuralları', level: 1 })).toBeVisible();
    const sets = await (await request.get('/api/v1/procurement-rule-sets', { headers: await bearer(request, 'tamer.yonetici@example.test') })).json();
    if (!sets.draft) {
      await page.getByRole('button', { name: sets.current ? /Yeni sürüm taslağı/ : 'Varsayılan kataloğu yükle' }).click();
      await expect(page.getByText(/taslağı oluşturuldu/)).toBeVisible();
    } else {
      await page.getByLabel('Sürüm').selectOption({ label: `Sürüm ${sets.draft.versionNo} · Taslak` });
    }
    await expect(page.getByText(/Ağırlık toplamı/)).toBeVisible();
    await expect(page.getByText(/toplam 100/i)).toHaveCount(0);
    await axe(page, 'Kurallar taslak');
    const firstEdit = page.getByRole('button', { name: /düzenle$/ }).first();
    await firstEdit.click();
    await expect(page.getByRole('heading', { name: /Kuralı düzenle/ })).toBeVisible();
    await page.getByRole('button', { name: 'Kuralı kaydet' }).click();
    await expect(page.getByText(/güncellendi\./)).toBeVisible();
    await page.getByRole('button', { name: 'Yayımla' }).click();
    await expect(page.getByText(/yayımlandı; .* tarihinden itibaren yürürlükte/)).toBeVisible();
    await expect(page.getByText('Yürürlükte', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Kural ekle' })).toHaveCount(0);
    await logout(page);

    // --- 2. Sentetik proje ve sözleşme (API) ---
    const p = await sourcedProject(request, tag);

    // --- 3. Sözleşme süresi dışında tarihli sentetik fatura: otomatik eşleşmez → kuyruk → elle bağla (tarih onayıyla) ---
    const invNo = `E2EF7${tag.slice(-8)}`;
    const inv = await request.post('/api/v1/invoices', { headers: p.alper, data: { companyId: p.companyId, supplierId: p.supplierId, kind: 'INVOICE', invoiceNo: invNo,
      issueDate: addDays(p.today, -10), currency: 'TRY', lines: [{ description: 'Sentetik destek (E2E Faz7)', quantity: '1', unit: 'adet', unitPrice: '1900', taxRate: '20', netAmount: '1900.00' }] } });
    expect(inv.status(), await inv.text()).toBe(201);
    await login(page, 'alper.satinalma@example.test');
    await page.goto('/faturalar');
    const chips = page.getByRole('group', { name: 'Eşleşme süzgeci' });
    await chips.getByRole('button', { name: /^Eşleşmedi kuyruğu/ }).click();
    await expect(page).toHaveURL(/durum=ESLESMEDI/);
    const row = page.getByRole('row').filter({ hasText: invNo });
    await expect(row.getByText('Eşleşmedi', { exact: true }).first()).toBeVisible();
    await expect(row.getByText(/Tahsis kontrolü: Eşleşmedi/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Kuyruğu yeniden dene' })).toBeVisible();
    await axe(page, 'Faturalar kuyruk');
    await row.getByRole('button', { name: `${invNo} faturasını elle bağla` }).click();
    const drawer = page.getByRole('dialog', { name: `Elle bağla · ${invNo}` });
    await drawer.getByRole('radio', { name: new RegExp(p.contractCode) }).check();
    await expect(drawer.locator('label').filter({ hasText: p.contractCode }).getByText('Fatura tarihi sözleşme süresinin dışında.')).toBeVisible();
    const link = drawer.getByRole('button', { name: 'Sözleşmeye bağla' });
    await expect(link).toBeDisabled();
    await drawer.getByRole('checkbox', { name: /yine de bu sözleşmeye bağlamayı onaylıyorum/ }).check();
    await drawer.getByLabel('Not (isteğe bağlı)').fill('E2E: sözleşme öncesi teslim, aynı kapsam.');
    await axe(page, 'Elle bağla çekmecesi');
    await link.click();
    await expect(page.getByText(`${invNo} faturası ${p.contractCode} sözleşmesine bağlandı.`)).toBeVisible();
    // Detay: v2 durumu birincil, eski tahsis kontrolü ikincil; eşleşme kartı yöntem ve kullanım.
    await page.goto('/faturalar?durum=ESLESTI');
    await page.getByRole('link', { name: invNo }).click();
    const card = page.locator('section[aria-labelledby="match-h"]');
    await expect(card.getByText('Elle', { exact: true })).toBeVisible();
    await expect(card.getByText('Sınıra yakın').first()).toBeVisible();
    await expect(page.getByText('Tahsis kontrolü:').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tahsisi düzenle' })).toBeVisible();
    await expect(page.getByText(/ERP_REF|MANUAL|UNMATCHED|SUPPLIER_DATE/)).toHaveCount(0);
    await axe(page, 'Fatura detayı eşleşme');
    // Proje > Faturalar: sözleşme başına kullanım ve fatura satırı.
    await page.goto(`/projeler/${p.projectId}?sekme=faturalar`);
    await expect(page.getByRole('heading', { name: 'Sözleşme başına kullanım' })).toBeVisible();
    await expect(page.getByRole('meter', { name: `${p.contractCode} kullanımı` })).toHaveAttribute('aria-valuenow', '95');
    await expect(page.getByRole('link', { name: invNo })).toBeVisible();
    await axe(page, 'Proje Faturalar');

    // --- 4. Beyanlar: Alper (sahip + öneren) bantla "yok"; tamamlanmamış projede Uyum boş durumu ---
    await page.goto(`/projeler/${p.projectId}`);
    await expect(page.getByRole('list', { name: 'Proje aşaması' }).getByText('Tamamlandı')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Çıkar çatışması beyanınız bekleniyor' })).toBeVisible();
    await page.getByRole('button', { name: 'Çıkar çatışmam yok' }).click();
    await expect(page.getByText('Beyanınız kaydedildi: çıkar çatışmanız yok.')).toBeVisible();
    await page.getByRole('tab', { name: 'Uyum denetimi' }).click();
    await expect(page.getByText('Uyum denetimi proje tamamlanınca koşar.', { exact: false })).toBeVisible();
    await logout(page);
    // Departman kullanıcısı Tolga (puan veren): "var" açıklaması 10 karakterden kısayken gönderilemez; "yok" beyanı.
    await login(page, 'tolga.teknik@example.test');
    await page.goto(`/projeler/${p.projectId}`);
    await page.getByRole('button', { name: 'Çıkar çatışmam var' }).click();
    await page.getByLabel('Açıklama').fill('kısa');
    await expect(page.getByRole('button', { name: 'Beyanı gönder' })).toBeDisabled();
    await page.getByRole('button', { name: 'Çıkar çatışmam yok' }).click();
    await expect(page.getByText('Beyanınız kaydedildi: çıkar çatışmanız yok.')).toBeVisible();
    await page.getByRole('tab', { name: 'Beyanlar' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Tolga' }).getByText('Çıkar çatışmam yok')).toBeVisible();
    await axe(page, 'Beyanlar');
    await logout(page);
    // Kararı veren(ler) API ile beyan eder (eksik kalan katılımcı Uyumsuz yapar; burada tam).
    const coi = await (await request.get(`/api/v1/projects/${p.projectId}/coi`, { headers: p.alper })).json();
    for (const m of coi.missing as { userId: string; name: string }[]) {
      for (const u of DECIDERS) {
        const h = await bearer(request, u);
        const mine = await (await request.get(`/api/v1/projects/${p.projectId}/coi`, { headers: h })).json();
        if (mine.me.participant && !mine.me.latest && mine.participants.find((x: { isMe: boolean; userId: string }) => x.isMe)?.userId === m.userId) {
          expect((await request.post(`/api/v1/projects/${p.projectId}/coi`, { headers: h, data: { kind: 'NONE' } })).ok()).toBe(true);
        }
      }
    }

    // --- 5. Tamamla → Uyum denetimi raporu (işçi) → PDF ---
    await login(page, 'alper.satinalma@example.test');
    await page.goto(`/projeler/${p.projectId}`);
    await page.getByRole('button', { name: 'Projeyi tamamla' }).click();
    await page.getByRole('dialog', { name: 'Projeyi tamamla' }).getByRole('button', { name: 'Tamamla' }).click();
    await expect(page.getByText(/tarihiyle tamamlandı; uyum denetimi sıraya alındı/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Proje aşaması' }).locator('[aria-current="step"]')).toHaveText(/Tamamlandı/);
    await expect(page.getByRole('button', { name: 'İstisna iste' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Uyum denetimi' }).click();
    await expect(page.getByRole('heading', { name: /Uyum denetimi · koşu \d+/ })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('img', { name: /Uyum puanı 100 üzerinden \d+/ })).toBeVisible();
    await expect(page.getByText(/Kural seti sürüm \d+/)).toBeVisible();
    await expect(page.getByText('Özet · Otomatik özet')).toBeVisible();
    await expect(page.getByText(/Test sağlayıcısı — gerçek değil|Yapay zekâ kullanılmadı|Anthropic API/).first()).toBeVisible();
    await expect(page.getByText(/\b(COMPLIANT|NONCOMPLIANT|EVIDENCE_AI|NOT_APPLICABLE|NO_DATA)\b/)).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'Çıkar çatışması' }).getByText('Karşılandı')).toBeVisible();
    expect(await fits(page)).toBe(true);
    await axe(page, 'Uyum denetimi');
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'PDF indir' }).first().click();
    expect((await dl).suggestedFilename()).toMatch(new RegExp(`^${p.code}-uyum-denetimi-ko(s|ş)u-\\d+\\.pdf$`));
    // Yeniden denetle: 202 (sırada iş varsa aynı iş).
    await page.getByRole('button', { name: 'Yeniden denetle' }).click();
    await expect(page.getByText(/Yeniden denetim sıraya alındı|Sırada bekleyen denetim var/)).toBeVisible();
    // Projeler: Tamamlandı süzgeci ve uyum puanı sütunu.
    await page.goto('/projeler?durum=COMPLETED');
    await expect(page.getByRole('link', { name: p.title })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Uyum puanı' })).toBeVisible();
    await logout(page);

    // --- 6. Denetçi: Raporlar > Uyum denetimleri + PDF; projede yeniden denetle ve işaret yok; kurallar salt okunur ---
    await login(page, 'deniz.denetci@example.test');
    await page.goto('/raporlar');
    await page.getByRole('navigation', { name: 'Rapor türleri' }).getByRole('link', { name: 'Uyum denetimleri' }).click();
    await expect(page.getByRole('heading', { name: 'Uyum denetimleri', level: 1 })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Hüküm süzgeci' }).getByRole('button', { name: 'Kural seti yok' })).toBeVisible();
    const arow = page.getByRole('row').filter({ hasText: p.title });
    await expect(arow).toBeVisible();
    const dl2 = page.waitForEvent('download');
    await arow.getByRole('button', { name: `${p.code} PDF indir` }).click();
    expect((await dl2).suggestedFilename()).toContain(p.code);
    await axe(page, 'Uyum denetimleri (Denetçi)');
    await arow.getByRole('link', { name: p.title }).click();
    await expect(page.getByRole('heading', { name: /Uyum denetimi · koşu \d+/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Yeniden denetle' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /elle işaretle/ })).toHaveCount(0);
    await page.goto('/yonetim/satinalma-kurallari');
    await expect(page.getByText('Salt okunur', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Kural ekle|Yayımla|Varsayılan kataloğu yükle/ })).toHaveCount(0);

    // Demo faturalar değişmedi.
    const demoAfter = await (await request.get('/api/v1/invoices', { headers: await bearer(request, 'alper.satinalma@example.test') })).json();
    expect(demoState(demoAfter)).toBe(demoState(demoBefore));
  });
});

// Salt okunur ekranlar her genişlikte: Faturalar (sekmeler, sayaçlar), Raporlar > Uyum denetimleri, kural kataloğu (Denetçi), tamamlanmış proje.
test('Faz 7 ekranları: taşma ve erişilebilirlik (her genişlik, salt okunur)', async ({ page, request }) => {
  await login(page, 'alper.satinalma@example.test');
  await page.goto('/faturalar');
  const chips = page.getByRole('group', { name: 'Eşleşme süzgeci' });
  for (const n of [/^Tümü/, /^Eşleşmedi kuyruğu/, /^Eşleşti/, /^Hukuken iptal\/ret/]) await expect(chips.getByRole('button', { name: n })).toBeVisible();
  for (const c of ['Sözleşme', 'Departman', 'Eşleşme']) await expect(page.getByRole('columnheader', { name: c, exact: true }).first()).toBeVisible();
  expect(await fits(page)).toBe(true);
  await axe(page, 'Faturalar');
  const audits = await (await request.get('/api/v1/compliance-audits', { headers: await bearer(request, 'alper.satinalma@example.test') })).json();
  const done = (audits.items as { projectId: string }[])[0];
  if (done) {
    await page.goto(`/projeler/${done.projectId}?sekme=uyum`);
    await expect(page.getByRole('tab', { name: 'Uyum denetimi' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'PDF indir' }).first()).toBeVisible();
    expect(await fits(page)).toBe(true);
    await axe(page, 'Uyum denetimi sekmesi');
  }
  await page.goto('/projeler?durum=COMPLETED');
  await expect(page.getByRole('group', { name: 'Aşama filtresi' }).getByRole('button', { name: /^Tamamlandı/ })).toHaveAttribute('aria-pressed', 'true');
  expect(await fits(page)).toBe(true);
  await logout(page);
  await login(page, 'deniz.denetci@example.test');
  await page.goto('/raporlar?sekme=uyum');
  await expect(page.getByRole('heading', { name: 'Uyum denetimleri', level: 1 })).toBeVisible();
  expect(await fits(page)).toBe(true);
  await axe(page, 'Raporlar uyum');
  await page.goto('/yonetim/satinalma-kurallari');
  await expect(page.getByRole('heading', { name: 'Satınalma kuralları', level: 1 })).toBeVisible();
  await expect(page.getByText(/toplam 100/i)).toHaveCount(0);
  expect(await fits(page)).toBe(true);
  await axe(page, 'Satınalma kuralları (Denetçi)');
});
