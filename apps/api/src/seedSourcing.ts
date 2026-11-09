// Faz 2 sentetik demo verisi (09 Demo veri seti: 3 teklifli proje, eksik kapsam dahil; bölünmüş seçim).
// Var olan demo kiracısını silmez; eksik kullanıcı/tedarikçi/projeyi ekler. Aynı API yolunu kullanır.
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { syntheticVkn } from '@sp/domain';
import type { DevAuthProvider } from './auth.ts';
import type { App } from './server.ts';

export async function ensureSourcingDemo(owner: pg.Pool, app: App, auth: DevAuthProvider, tenantId: string, log = console.log) {
  const company = (await owner.query<{ id: string }>(`SELECT id FROM legal_entities WHERE tenant_id = $1 ORDER BY name DESC LIMIT 1`, [tenantId])).rows[0]!.id;
  const userId = async (key: string, name: string) => {
    const email = `${key}@example.test`;
    const u = await owner.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    if (u.rows[0]) return u.rows[0].id;
    return (await owner.query<{ id: string }>(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1,$2,$3) RETURNING id`,
      [`dev|${email}`, email, name])).rows[0]!.id;
  };
  const buyer = await userId('alper.satinalma', 'Alper Yıldız');
  const masterData = await userId('mine.anaveri', 'Mine Kaya');
  const tech = await userId('tolga.teknik', 'Tolga Er');
  await owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids) VALUES ($1,$2,ARRAY['TECH_EVALUATOR'],ARRAY[$3]::uuid[]) ON CONFLICT DO NOTHING`, [tenantId, tech, company]);
  const supplier = async (name: string, prefix: string, status: string, userKey: string, userName: string) => {
    let s = (await owner.query<{ id: string }>(`SELECT id FROM suppliers WHERE tenant_id = $1 AND legal_name = $2`, [tenantId, name])).rows[0]?.id;
    s ??= (await owner.query<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, activated_by, activated_at)
      VALUES ($1,$2,'TR','VKN',$3,$4,$5,$6,$7) RETURNING id`, [tenantId, status, syntheticVkn(prefix), name, buyer,
        status === 'ACTIVE' ? masterData : null, status === 'ACTIVE' ? new Date() : null])).rows[0]!.id;
    const u = await userId(userKey, userName);
    await owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, supplier_id) VALUES ($1,$2,ARRAY['SUPPLIER'],'{}',$3) ON CONFLICT DO NOTHING`, [tenantId, u, s]);
    return s;
  };
  const s1 = await supplier('Anadolu Bilişim Hizmetleri A.Ş. (SENTETİK)', '930000001', 'ACTIVE', 'teklif.anadolu', 'Anadolu Bilişim Teklif Sorumlusu');
  const s2 = await supplier('Ege Sistem Entegrasyon Ltd. Şti. (SENTETİK)', '930000002', 'ACTIVE', 'teklif.ege', 'Ege Sistem Teklif Sorumlusu');
  const s3 = await supplier('Kuzey Teknoloji A.Ş. (SENTETİK)', '930000003', 'CANDIDATE', 'teklif.kuzey', 'Kuzey Teknoloji Teklif Sorumlusu');

  if ((await owner.query(`SELECT 1 FROM projects WHERE tenant_id = $1`, [tenantId])).rowCount) { log('Faz 2 demo projeleri zaten var; atlandı.'); return; }

  const tok = async (key: string) => auth.issue(`dev|${key}@example.test`);
  async function call(who: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const r = await app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${await tok(who)}`, 'x-tenant-id': tenantId, ...headers } });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return { body: r.body ? JSON.parse(r.body) : null, etag: r.headers.etag as string };
  }
  const criteria = [
    { code: 'PRICE', name: 'Fiyat (TCO)', kind: 'PRICE', weight: '40' }, { code: 'TECH', name: 'Teknik uygunluk', kind: 'SCORE', weight: '30' },
    { code: 'DELIVERY', name: 'Teslimat ve hizmet', kind: 'SCORE', weight: '15' }, { code: 'PERF', name: 'Doğrulanmış performans', kind: 'SCORE', weight: '15' },
  ];
  const lines = [
    { lot: 'Lot 1', description: 'Sunucu ve depolama bakımı', unit: 'ay', quantity: '12', spec: '7/24 izleme, 4 saat müdahale (sentetik şartname).' },
    { lot: 'Lot 1', description: 'Yerinde teknik destek', unit: 'saat', quantity: '480', spec: 'Hafta içi mesai; yıllık havuz.' },
    { lot: 'Lot 2', description: 'Yedekleme yazılımı lisans yenileme', unit: 'kullanıcı', quantity: '250', spec: 'Adlandırılmış kullanıcı lisansı, 12 ay.' },
  ];
  const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

  // 1) Tamamlanmış akış: üç teklif (biri eksik kapsamlı), puanlar, değerlendirme, bölünmüş ve onaylı tahsis.
  const p1 = (await call('alper.satinalma', 'POST', '/api/v1/projects', { companyId: company, title: 'BT altyapı bakım hizmeti 2027', category: 'BT hizmetleri',
    need: 'Merkez veri odası ve iki şube için yıllık bakım ve destek (sentetik).', currency: 'TRY', budget: '1900000.00', budgetVerified: true, costCenter: 'MM-410',
    deliveryLocation: 'Gebze Lojistik Merkezi', lines, criteria })).body;
  const r1 = (await call('alper.satinalma', 'POST', `/api/v1/projects/${p1.id}/rounds`, { closesAt: at(72), supplierIds: [s1, s2, s3] }, { 'if-match': p1.etag })).body;
  await call('kerem.hukuk', 'POST', `/api/v1/rfq-rounds/${r1.roundId}/decision`, { approve: true, note: 'Bütçe ve kriterler uygun.' });
  const lid = (await call('alper.satinalma', 'GET', `/api/v1/projects/${p1.id}`)).body.lines.map((l: any) => l.id);
  const bid = (who: string, prices: string[], l3: { unit: string; quantity: string } = { unit: 'kullanıcı', quantity: '250' }, costs: unknown[] = []) =>
    call(who, 'POST', `/api/v1/portal/rounds/${r1.roundId}/bids`, { currency: 'TRY', validityDays: 60, costs, lines: [
      { projectLineId: lid[0], unit: 'ay', quantity: '12', unitPrice: prices[0], scope: 'INCLUDED' },
      { projectLineId: lid[1], unit: 'saat', quantity: '480', unitPrice: prices[1], scope: 'INCLUDED' },
      { projectLineId: lid[2], unit: l3.unit, quantity: l3.quantity, unitPrice: prices[2], scope: 'INCLUDED' }] }, { 'idempotency-key': randomUUID() });
  const q = (await call('teklif.ege', 'POST', `/api/v1/portal/rounds/${r1.roundId}/questions`, { question: 'Lisanslar paket olarak teklif edilebilir mi?' })).body;
  await call('alper.satinalma', 'POST', `/api/v1/rfq-questions/${q.id}/answer`, { answer: 'Hayır; değerlendirme adlandırılmış kullanıcı birimiyle yapılır.' });
  const b1 = (await bid('teklif.anadolu', ['42000', '450', '1250'], undefined, [{ kind: 'INSTALLATION', amount: '15000' }])).body;
  await bid('teklif.ege', ['30000', '300', '100000'], { unit: 'paket', quantity: '1' });
  const b3 = (await bid('teklif.kuzey', ['41000', '440', '1200'])).body;
  await call('kerem.hukuk', 'POST', `/api/v1/rfq-rounds/${r1.roundId}/close`, { reason: 'Tüm davetliler teklif verdi; kurul tarihi öne alındı.' });
  for (const [b, tech, del, perf] of [[b1.bidId, '85', '80', '75'], [b3.bidId, '72', '85', '60']]) {
    for (const [code, score] of [['TECH', tech], ['DELIVERY', del], ['PERF', perf]]) {
      await call('tolga.teknik', 'POST', `/api/v1/bids/${b}/scores`, { criterionCode: code, score, evidence: 'Referans ziyareti, SLA eki ve önceki dönem kayıtlarına göre (sentetik).' });
    }
  }
  const ev = (await call('alper.satinalma', 'POST', `/api/v1/projects/${p1.id}/evaluations`)).body;
  await owner.query(`UPDATE suppliers SET status = 'ACTIVE', activated_by = $2, activated_at = now() WHERE id = $1`, [s3, masterData]);
  const aw = (await call('alper.satinalma', 'POST', `/api/v1/projects/${p1.id}/awards`, { evaluationId: ev.id,
    rationale: 'Lot 1 bakım Anadolu Bilişim; destek saatleri kapasite nedeniyle bölündü; Lot 2 en düşük uygun TCO ile Kuzey Teknoloji (sentetik).',
    allocations: [{ projectLineId: lid[0], supplierId: s1, quantity: '12' }, { projectLineId: lid[1], supplierId: s1, quantity: '300' },
      { projectLineId: lid[1], supplierId: s3, quantity: '180' }, { projectLineId: lid[2], supplierId: s3, quantity: '250' }] })).body;
  await call('kerem.hukuk', 'POST', `/api/v1/awards/${aw.id}/decision`, { approve: true, note: 'Satınalma kurulu kararı (sentetik).' });

  // 2) Teklife açık proje (portal demosu) ve 3) değerlendirmedeki proje (tahsis bekliyor).
  const p2 = (await call('alper.satinalma', 'POST', '/api/v1/projects', { companyId: company, title: 'Tesis temizlik hizmeti 2027', category: 'Tesis yönetimi',
    need: 'İki depo ve idari bina için yıllık temizlik (sentetik).', currency: 'TRY', budget: '620000.00', budgetVerified: false, criteria,
    lines: [{ lot: 'Lot 1', description: 'Depo temizliği', unit: 'ay', quantity: '12' }, { lot: 'Lot 2', description: 'İdari bina temizliği', unit: 'ay', quantity: '12' }] })).body;
  const r2 = (await call('alper.satinalma', 'POST', `/api/v1/projects/${p2.id}/rounds`, { closesAt: at(96), supplierIds: [s1, s2] }, { 'if-match': p2.etag })).body;
  await call('kerem.hukuk', 'POST', `/api/v1/rfq-rounds/${r2.roundId}/decision`, { approve: true });
  await call('alper.satinalma', 'POST', '/api/v1/projects', { companyId: company, title: 'Ofis ekipmanı yenileme', category: 'Donanım', currency: 'TRY', budget: '412500.00', criteria,
    lines: [{ description: 'Dizüstü bilgisayar', unit: 'adet', quantity: '25' }, { description: 'Monitör', unit: 'adet', quantity: '25' }] });
  log('Faz 2 demo: 3 proje (onaylı bölünmüş tahsis, teklife açık, taslak) oluşturuldu.');
}

/** Faz 3 demo: tatil listesi, doğrulanmış koşullar (ihbarı yakın), yükümlülükler. Var olan veri silinmez. */
export async function ensureLifecycleDemo(owner: pg.Pool, app: App, auth: DevAuthProvider, tenantId: string, runJobs: () => Promise<number>, log = console.log) {
  if ((await owner.query(`SELECT 1 FROM contract_terms WHERE tenant_id = $1`, [tenantId])).rowCount) { log('Faz 3 demo zaten var; atlandı.'); return; }
  const cv = (await owner.query<{ id: string }>(`SELECT cv.id FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id
    WHERE f.tenant_id = $1 AND f.title LIKE 'Yıllık Bakım%' AND cv.superseded_by_id IS NULL LIMIT 1`, [tenantId])).rows[0];
  if (!cv) { log('Faz 3 demo: uygun sözleşme bulunamadı; atlandı.'); return; }
  const tok = async (key: string) => auth.issue(`dev|${key}@example.test`);
  async function call(who: string, method: string, url: string, body?: unknown) {
    const r = await app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${await tok(who)}`, 'x-tenant-id': tenantId } });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.body ? JSON.parse(r.body) : null;
  }
  // Yalnız sabit tarihli resmî tatiller; dini bayram tarihleri her yıl kurum tarafından girilir.
  for (const [day, name] of [['2026-10-29', 'Cumhuriyet Bayramı'], ['2027-01-01', 'Yılbaşı'], ['2027-04-23', 'Ulusal Egemenlik ve Çocuk Bayramı'],
    ['2027-05-01', 'Emek ve Dayanışma Günü'], ['2027-05-19', 'Atatürk\'ü Anma, Gençlik ve Spor Bayramı'], ['2027-07-15', 'Demokrasi ve Millî Birlik Günü'],
    ['2027-08-30', 'Zafer Bayramı'], ['2027-10-29', 'Cumhuriyet Bayramı']]) await call('leyla.hukuk', 'POST', '/api/v1/holidays', { day, name });
  const t = await call('leyla.hukuk', 'POST', `/api/v1/contract-versions/${cv.id}/terms`, { currency: 'TRY', valueType: 'CEILING', amount: '1000000.00',
    paymentTerms: 'Fatura tarihinden itibaren 30 gün', startDate: '2026-01-01', endDate: '2026-12-31', autoRenewal: true, renewalMonths: 12,
    noticeAmount: 60, noticeUnit: 'DAY', nonWorkingDay: 'PREVIOUS_WORKING_DAY', sourceRef: 'Madde 4.2 (süre), 9.1 (ihbar), s. 3 (sentetik)' });
  await call('kerem.hukuk', 'POST', `/api/v1/contract-terms/${t.id}/verify`);
  await call('leyla.hukuk', 'POST', `/api/v1/contract-versions/${cv.id}/obligations`, { title: 'Üç aylık bakım ve arıza raporu', counterparty: 'SUPPLIER', ownerRole: 'BUYER',
    firstDue: '2026-11-15', recurrence: 'QUARTERLY', until: '2026-12-31', evidenceRequired: true, sourceRef: 'Ek-2 madde 3 (sentetik)' });
  await call('leyla.hukuk', 'POST', `/api/v1/contract-versions/${cv.id}/obligations`, { title: 'Yıllık sızma testi raporu', counterparty: 'SUPPLIER', ownerRole: null,
    firstDue: '2026-11-05', recurrence: 'YEARLY', until: null, evidenceRequired: true, sourceRef: 'Ek-4 bilgi güvenliği madde 2 (sentetik)' });
  while (await runJobs()) { /* zamanı gelen uyarılar */ }
  log('Faz 3 demo: koşullar (doğrulanmış), ihbar uyarısı ve 2 yükümlülük oluşturuldu.');
}

// Faz 4 demo: sözleşmeli sipariş, kısmi kabul ve üç fatura (onaya hazır, kabulden fazla, sözleşmesiz). Onay verilmez; karar kullanıcıya bırakılır.
export async function ensurePurchasingDemo(owner: pg.Pool, app: App, auth: DevAuthProvider, tenantId: string, log = console.log) {
  if ((await owner.query(`SELECT 1 FROM purchase_orders WHERE tenant_id = $1`, [tenantId])).rowCount) { log('Faz 4 demo zaten var; atlandı.'); return; }
  const cv = (await owner.query<{ id: string; company_id: string }>(`SELECT cv.id, f.company_id FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id
    JOIN contract_terms t ON t.contract_version_id = cv.id AND t.verified_at IS NOT NULL
    WHERE f.tenant_id = $1 AND f.title LIKE 'Yıllık Bakım%' AND cv.superseded_by_id IS NULL LIMIT 1`, [tenantId])).rows[0];
  if (!cv) { log('Faz 4 demo: doğrulanmış koşullu sözleşme yok; atlandı.'); return; }
  const sup = async (name: string) => (await owner.query<{ id: string }>(`SELECT id FROM suppliers WHERE tenant_id = $1 AND legal_name LIKE $2 AND status = 'ACTIVE'`, [tenantId, `${name}%`])).rows[0]?.id;
  const [s1, s2] = [await sup('Anadolu Bilişim'), await sup('Ege Sistem')];
  if (!s1 || !s2) { log('Faz 4 demo: aktif tedarikçi yok; atlandı.'); return; }
  const email = 'nur.finansonay@example.test';
  const f2 = (await owner.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email])).rows[0]?.id
    ?? (await owner.query<{ id: string }>(`INSERT INTO users (auth_subject, email, display_name) VALUES ($1,$2,'Nur Aydın') RETURNING id`, [`dev|${email}`, email])).rows[0]!.id;
  await owner.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids) VALUES ($1,$2,ARRAY['FINANCE'],ARRAY[$3]::uuid[]) ON CONFLICT DO NOTHING`, [tenantId, f2, cv.company_id]);
  const tok = async (key: string) => auth.issue(`dev|${key}@example.test`);
  async function call(who: string, method: string, url: string, body?: unknown) {
    const r = await app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${await tok(who)}`, 'x-tenant-id': tenantId } });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.body ? JSON.parse(r.body) : null;
  }
  // Demo sipariş bu sözleşmeye bağlıdır; sipariş açma kuralı gereği (D85) tedarikçisi sözleşmenin tarafı olmalı. İmza gereksinimi ayrı kayıttır, etkilenmez.
  await owner.query(`INSERT INTO contract_parties (tenant_id, company_id, contract_version_id, party_role, supplier_id, display_name)
    SELECT cv.tenant_id, cv.company_id, cv.id, 'SUPPLIER', s.id, s.legal_name FROM contract_versions cv JOIN suppliers s ON s.id = $2 WHERE cv.id = $1`, [cv.id, s1]);
  const po = await call('alper.satinalma', 'POST', '/api/v1/purchase-orders', { companyId: cv.company_id, supplierId: s1, contractVersionId: cv.id, currency: 'TRY', lines: [
    { kind: 'GOODS', description: 'Yedek disk 2 TB', unit: 'adet', quantity: '10', unitPrice: '4000' },
    { kind: 'SERVICE', description: 'Aylık bakım hizmeti', unit: 'ay', quantity: '12', unitPrice: '50000' }] });
  const lines = (await call('alper.satinalma', 'GET', `/api/v1/purchase-orders/${po.id}`)).lines as { poLineId: string }[];
  await call('alper.satinalma', 'POST', `/api/v1/po-lines/${lines[0]!.poLineId}/receipts`, { quantity: '6', note: 'İlk sevkiyat, irsaliye 0012 (sentetik)' });
  await call('alper.satinalma', 'POST', `/api/v1/po-lines/${lines[1]!.poLineId}/receipts`, { quantity: '1', note: 'Ekim bakımı yapıldı', periodFrom: '2026-10-01', periodTo: '2026-10-31' });
  const inv = async (supplierId: string, invoiceNo: string, l: { description: string; quantity: string; unit: string; unitPrice: string }[]) =>
    (await call('ferda.finans', 'POST', '/api/v1/invoices', { companyId: cv.company_id, supplierId, kind: 'INVOICE', invoiceNo, issueDate: '2026-10-20', currency: 'TRY',
      lines: l.map((x) => ({ ...x, netAmount: (Number(x.quantity) * Number(x.unitPrice)).toFixed(2), taxRate: '20' })) })).id as string;
  const a = await inv(s1, 'ANB2026000101', [{ description: 'Ekim bakım hizmeti', quantity: '1', unit: 'ay', unitPrice: '50000' }]);
  await call('ferda.finans', 'PUT', `/api/v1/invoices/${a}/allocations`, { allocations: [{ lineNo: 1, poLineId: lines[1]!.poLineId, contractVersionId: null, quantity: '1', amount: '50000.00' }] });
  const b = await inv(s1, 'ANB2026000102', [{ description: 'Yedek disk 2 TB', quantity: '8', unit: 'adet', unitPrice: '4000' }]);
  await call('ferda.finans', 'PUT', `/api/v1/invoices/${b}/allocations`, { allocations: [{ lineNo: 1, poLineId: lines[0]!.poLineId, contractVersionId: null, quantity: '8', amount: '32000.00' }] });
  await inv(s2, 'EGE2026000877', [{ description: 'Acil saha desteği', quantity: '6', unit: 'saat', unitPrice: '2500' }]);
  log('Faz 4 demo: sipariş, kabuller ve 3 fatura oluşturuldu (onay kullanıcıda).');
}

// Faz 5 demo (09 Demo veri seti: "bir güvenlik olayı"): yayımlı güvenlik anketi, bulgulu değerlendirme, iddia aşamasında güvenlik olayı,
// performans incelemesi. Kritik engel oluşturulmaz (diğer demo akışları sürsün); sonuçlar kurallarla türetilir.
export async function ensureEvaluationDemo(owner: pg.Pool, app: App, auth: DevAuthProvider, tenantId: string, log = console.log) {
  if ((await owner.query(`SELECT 1 FROM questionnaire_templates WHERE tenant_id = $1`, [tenantId])).rowCount) { log('Faz 5 demo zaten var; atlandı.'); return; }
  const sup = async (name: string) => (await owner.query<{ id: string }>(`SELECT id FROM suppliers WHERE tenant_id = $1 AND legal_name LIKE $2`, [tenantId, `${name}%`])).rows[0]?.id;
  const [s1, s2] = [await sup('Anadolu Bilişim'), await sup('Ege Sistem')];
  if (!s1 || !s2) { log('Faz 5 demo: tedarikçi yok; atlandı.'); return; }
  const tok = async (key: string) => auth.issue(`dev|${key}@example.test`);
  async function call(who: string, method: string, url: string, body?: unknown) {
    const r = await app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${await tok(who)}`, 'x-tenant-id': tenantId } });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.body ? JSON.parse(r.body) : null;
  }
  const t = await call('selin.guvenlik', 'POST', '/api/v1/questionnaire-templates', { code: 'BT-ERISIM', name: 'BT erişimli hizmet güvenlik anketi', category: 'BT erişimli hizmet', questions: [
    { controlId: 'ERS-01', reference: 'ISO/IEC 27036-2 tedarikçi erişimi (eşleme uzman onayı bekliyor)', text: 'Uzak ve ayrıcalıklı erişimde çok faktörlü kimlik doğrulama uygulanıyor mu?', critical: true, evidenceRequired: false },
    { controlId: 'ERS-02', reference: 'ISO/IEC 27002 erişim hakları', text: 'Personel ayrıldığında erişim aynı gün kapatılıyor mu?', critical: false, evidenceRequired: false },
    { controlId: 'YDK-01', reference: 'ISO/IEC 27002 yedekleme', text: 'Yedekten geri dönüş yılda en az bir kez test edilip raporlanıyor mu?', critical: false, evidenceRequired: true },
    { controlId: 'OLY-01', reference: 'Sözleşme olay bildirim maddesi', text: 'Olay bildirim süresi ve iletişim sorumlusu sözleşmede belirli mi?', critical: false, evidenceRequired: false },
    { controlId: 'KVK-01', reference: 'KVKK veri işleme ve aktarım', text: 'Alt işleyen listesi ve veri konumu paylaşıldı mı?', critical: false, evidenceRequired: false },
  ] });
  await call('kerem.hukuk', 'POST', `/api/v1/questionnaire-templates/${t.id}/publish`);
  const a = await call('alper.satinalma', 'POST', '/api/v1/assessments', { supplierId: s2, templateId: t.id, scope: 'Yedekleme ve felaket kurtarma hizmeti',
    inherentFactors: { dataSensitivity: 'HIGH', accessLevel: 'MEDIUM', criticality: 'HIGH', substitutability: 'MEDIUM', subcontractorDependence: 'LOW' } });
  const d = await call('alper.satinalma', 'GET', `/api/v1/assessments/${a.id}`);
  const resp: Record<string, string> = { 'ERS-01': 'YES', 'ERS-02': 'PARTIAL', 'YDK-01': 'YES', 'OLY-01': 'YES', 'KVK-01': 'YES' };
  for (const q of d.questions as { id: string; controlId: string }[]) {
    await call('alper.satinalma', 'PUT', `/api/v1/assessments/${a.id}/answers/${q.id}`, { response: resp[q.controlId], note: 'Tedarikçi beyanı (sentetik)' });
  }
  // İnceleme yarım bırakılır: ERS-02 bulgulu, yedekleme kanıtı eksik → kullanıcı tamamlar.
  const ers02 = (d.questions as { id: string; controlId: string }[]).find((q) => q.controlId === 'ERS-02')!;
  await call('selin.guvenlik', 'POST', `/api/v1/assessments/${a.id}/answers/${ers02.id}/review`, { review: 'FINDING', findingSeverity: 'MEDIUM', findingNote: 'Erişim kapatma ortalama 3 gün sürüyor (sentetik).' });
  await call('alper.satinalma', 'POST', '/api/v1/incidents', { supplierId: s1, category: 'SECURITY', severity: 'HIGH', title: 'Paylaşılan hesapla uzak erişim şüphesi',
    description: 'Erişim kayıtlarında aynı hesapla iki farklı kişinin bağlandığı görüldü (sentetik).', impact: 'Sunucu bakım ortamı', occurredOn: '2026-10-14' });
  await call('alper.satinalma', 'POST', `/api/v1/suppliers/${s1}/performance-reviews`, { periodStart: '2026-01-01', periodEnd: '2026-09-30', category: 'BT bakım hizmeti',
    scores: { quality: 85, delivery: 78, sla: 72, communication: 90, commercial: 80 }, basis: 'Kabul kayıtları ve aylık SLA raporları (sentetik).' });
  log('Faz 5 demo: güvenlik anketi, bulgulu değerlendirme, güvenlik olayı (iddia) ve performans incelemesi oluşturuldu.');
}

/**
 * Faz 7 demo: saklama ve imha akışını denemek için eski tarihli iki sentetik teklif dosyası. Saklama politikası tanımlanmaz
 * (kurumun kararıdır); "Teklif" için süre tanımlanınca bu belgeler imha adayı olarak görünür.
 */
export async function ensureRetentionDemo(owner: pg.Pool, app: App, auth: DevAuthProvider, tenantId: string, log = console.log) {
  // İmha onayı ikinci bir hukuk yetkilisini gerektirir: belgeler bütün hukuk kullanıcılarının erişebildiği şirkete konur.
  const company = (await owner.query<{ id: string }>(`SELECT le.id FROM legal_entities le WHERE le.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM memberships m
    WHERE m.tenant_id = $1 AND 'LEGAL' = ANY(m.roles) AND NOT le.id = ANY(m.company_ids)) ORDER BY le.name LIMIT 1`, [tenantId])).rows[0];
  if (!company) { log('Faz 7 demo: ortak şirket yok; atlandı.'); return; }
  const { syntheticPdf } = await import('./devdata.ts');
  const token = await auth.issue('dev|leyla.hukuk@example.test');
  let added = 0;
  for (const [title, year] of [['Arşiv teklif dosyası 2014 — kablo alımı (SENTETİK)', '2014-03-14'], ['Arşiv teklif dosyası 2015 — yazıcı bakımı (SENTETİK)', '2015-06-02'],
    ['Arşiv teklif dosyası 2013 — ofis mobilyası (SENTETİK)', '2013-09-20'], ['Arşiv teklif dosyası 2012 — kırtasiye (SENTETİK)', '2012-05-11']] as const) {
    if ((await owner.query(`SELECT 1 FROM documents WHERE tenant_id = $1 AND title = $2`, [tenantId, title])).rowCount) continue;
    added++;
    const boundary = `----sp${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="companyId"\r\n\r\n${company.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nQUOTE\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="arsiv-teklif.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      syntheticPdf([[`SENTETIK ARSIV TEKLIF ${year}`, title.normalize('NFD').replace(/[^\x20-\x7e]/g, '')]]), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await app.inject({ method: 'POST', url: '/api/v1/documents', payload: body,
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    if (r.statusCode >= 400) throw new Error(`upload → ${r.statusCode} ${r.body}`);
    // Yalnız demo: belge yıllar önce yüklenmiş gibi tarihlenir (saklama süresi gerçek zamanda beklenemez).
    await owner.query(`UPDATE document_versions SET created_at = $2::date + time '10:00' WHERE document_id = $1`, [JSON.parse(r.body).documentId, year]);
  }
  log(added ? `Faz 7 demo: eski tarihli ${added} sentetik teklif dosyası eklendi (saklama politikası tanımlanmadı).` : 'Faz 7 demo zaten var; atlandı.');
}
