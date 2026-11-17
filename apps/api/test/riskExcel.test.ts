// v2 Faz 6 (D111) Görev 6: risk tablosu Excel içe aktarımı (R11) ve dışa aktarımı (R12). Tüm veri sentetiktir (tedarikçi adları
// "Test Bilişim A.Ş." vb.; ölçüt/skor sayıları analizdeki örnek tablodan, Excel satır no ile). Gerçek dosya repoya kopyalanmaz:
// RISK_XLSX_PATH ayarlıysa yalnız ayrıştırılır (veritabanına yazılmaz), yoksa o test atlanır.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { criticality, riskLevel, syntheticVkn, type CriteriaValues } from '@sp/domain';
import { ApiError } from '../src/errors.ts';
import { ZipStreamWriter } from '../src/zip.ts';
import { geomean, parseRiskTable } from '../src/riskExcel.ts';
import { makeHarness } from './harness.ts';
import { riskWorkbook, SAMPLE_ROWS, SOURCE_GROUPS, SOURCE_HEADERS, SOURCE_NOTES, type SyntheticRiskRow } from './helpers/riskWorkbook.ts';

const KEYS = ['businessImpact', 'dataSensitivity', 'continuity', 'integration', 'regulation', 'serviceType'] as const;
const toCriteria = (c: readonly number[]) => Object.fromEntries(KEYS.map((k, i) => [k, c[i]])) as CriteriaValues;
const sample = (row: number) => SAMPLE_ROWS.find((s) => s.excelRow === row)!;
const sampleRow = (row: number, extra: Partial<SyntheticRiskRow> & { name: string }): SyntheticRiskRow => {
  const s = sample(row);
  return { criteria: [...s.criteria], excelCriticality: s.i, j: s.j, k: 'Ek bir aksiyon planı yokktur', team: 'Bilgi Teknolojileri', ...extra };
};

describe('parseRiskTable (yalnız ayrıştırma)', () => {
  it('kaynak başlıklar kabul edilir; kesir ölçeği; örnek tablonun kritiklik/sütun/seviyesi Excel ile aynı', async () => {
    const buf = await riskWorkbook(SAMPLE_ROWS.map((s, i) => ({ name: `Örnek Satır ${i} A.Ş.`, criteria: [...s.criteria], excelCriticality: s.i, j: s.j })));
    const t = await parseRiskTable(buf);
    expect(t.period).toBe('2026-1');
    expect(t.fractionScale).toBe(true);
    expect(t.rows).toHaveLength(SAMPLE_ROWS.length);
    SAMPLE_ROWS.forEach((s, i) => {
      const r = t.rows[i]!;
      expect(r.issues).toEqual([]);
      expect(r.criteriaComplete).toBe(true);
      expect(r.excelCriticality).toBe(s.i);
      expect(Math.abs(geomean(r.criteria as CriteriaValues) - s.i)).toBeLessThan(1e-9);
      const c = criticality(r.criteria as CriteriaValues);
      expect(c.column).toBe(s.column);
      expect(r.riskScore).toBe((Math.round(s.j * 100)).toFixed(2));
      expect(riskLevel(r.riskScore!, c.column).level).toBe(s.level);
    });
    expect(criticality(t.rows[0]!.criteria as CriteriaValues).display).toBe('3,22');
    // Ham satır her hücreyi saklar: formül metni + önbellek.
    expect(t.rows[0]!.raw.I).toEqual({ formula: 'GEOMEAN(C5:H5)', result: 3.224968079727227 });
  });

  it('1/3/5 dışı ve kısmi ölçüt satır sorunu; Excel I farkı sorun; J > 1 varsa 0–100 ölçeği', async () => {
    const t = await parseRiskTable(await riskWorkbook([
      { name: 'Kısmi A.Ş.', criteria: [3, 5, null, null, null, null], j: 40 },
      { name: 'Geçersiz A.Ş.', criteria: [3, 5, 2, 3, 5, 5], j: 15.5 },
      { name: 'Farklı A.Ş.', criteria: [3, 5, 1, 3, 5, 5], excelCriticality: 3.3, j: 0.5 },
    ]));
    expect(t.fractionScale).toBe(false);
    expect(t.rows[0]!.issues.join(' ')).toMatch(/Ölçütler eksik/);
    expect(t.rows[0]!.criteriaComplete).toBe(false);
    expect(t.rows[0]!.riskScore).toBe('40.00');
    expect(t.rows[1]!.issues.join(' ')).toMatch(/E sütunu.*1, 3 ya da 5/);
    expect(t.rows[1]!.riskScore).toBe('15.50');
    expect(t.rows[2]!.issues.join(' ')).toMatch(/Kritiklik Excel'deki değerden farklı/);
    expect(t.rows[2]!.riskScore).toBe('0.50');
  });

  it('yanlış başlık ya da sayfa → 422 risk_import_format (bulunan başlıklar listeli)', async () => {
    const headers = [...SOURCE_HEADERS];
    headers[9] = 'Skor';
    const err = await parseRiskTable(await riskWorkbook([{ name: 'X A.Ş.' }], { headers })).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'risk_import_format' });
    expect((err as ApiError).details).toMatchObject({ foundHeaders: expect.arrayContaining(['Skor']) });
    // Numara ve büyük/küçük harf, boşluk farkı kabul edilir (normalize karşılaştırma).
    const loose = SOURCE_HEADERS.map((h) => `  ${h.replace(/^\d+\.\s*/, '').toLocaleUpperCase('tr')} `);
    expect((await parseRiskTable(await riskWorkbook([{ name: 'X A.Ş.' }], { headers: loose }))).rows).toHaveLength(1);
    const bad = await parseRiskTable(Buffer.from('düz metin')).catch((e) => e);
    expect(bad).toMatchObject({ status: 422, code: 'risk_import_format' });
  });


  it('M3: J değerleri 1 ve altı ile 1 üstü karışıksa satırlara ölçek sorunu yazılır (tek yanlış hücre sessizce ölçeği çevirmez)', async () => {
    const t = await parseRiskTable(await riskWorkbook([
      { name: 'A A.Ş.', criteria: [3, 3, 3, 3, 3, 3], j: 0.15 }, { name: 'B A.Ş.', criteria: [3, 3, 3, 3, 3, 3], j: 15 }, { name: 'C A.Ş.', criteria: [3, 3, 3, 3, 3, 3], j: null },
    ]));
    expect(t.rows[0]!.issues.join(' ')).toMatch(/ölçeği belirsiz/);
    expect(t.rows[1]!.issues.join(' ')).toMatch(/ölçeği belirsiz/);
    expect(t.rows[2]!.issues).toEqual([]);
    const ok = await parseRiskTable(await riskWorkbook([{ name: 'A A.Ş.', j: 0.15 }, { name: 'B A.Ş.', j: 0.2 }]));
    expect(ok.rows.every((r) => r.issues.every((i) => !/ölçeği belirsiz/.test(i)))).toBe(true);
  });

  it('I1: 5.000 satırdan fazlası ve açılınca çok büyük (sıkıştırma bombası) dosya 422 risk_import_too_large', async () => {
    const many = await parseRiskTable(await riskWorkbook(Array.from({ length: 5001 }, (_, i) => ({ name: `Satır ${i} A.Ş.` })))).catch((e) => e);
    expect(many).toMatchObject({ status: 422, code: 'risk_import_too_large' });
    const okEdge = await parseRiskTable(await riskWorkbook(Array.from({ length: 5000 }, (_, i) => ({ name: `Satır ${i} A.Ş.` }))));
    expect(okEdge.rows).toHaveLength(5000);
    const parts: Buffer[] = [];
    const zw = new ZipStreamWriter({ write: async (c) => { parts.push(c); } });
    const e = await zw.entry('xl/bomb.bin');
    for (let i = 0; i < 60; i++) await e.write(Buffer.alloc(1024 * 1024));
    await e.close();
    await zw.finish();
    const bomb = await parseRiskTable(Buffer.concat(parts)).catch((x) => x);
    expect(bomb).toMatchObject({ status: 422, code: 'risk_import_too_large' });
  });

  const realPath = process.env.RISK_XLSX_PATH;
  (realPath ? it : it.skip)('gerçek dosya (RISK_XLSX_PATH): 104 satır, 74 tam ölçüt, 70 skor, seviye {1:10, 2:21, 3:31, 4:1}, I farkı < 1e-9', async () => {
    const t = await parseRiskTable(readFileSync(realPath!));
    expect(t.period).toBe('2026-1');
    expect(t.fractionScale).toBe(true);
    expect(t.rows).toHaveLength(104);
    const full = t.rows.filter((r) => r.criteriaComplete);
    const scored = t.rows.filter((r) => r.riskScore !== null);
    const both = full.filter((r) => r.riskScore !== null);
    expect(full).toHaveLength(74);
    expect(scored).toHaveLength(70);
    expect(both).toHaveLength(63);
    const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of both) dist[riskLevel(r.riskScore!, criticality(r.criteria as CriteriaValues).column).level]!++;
    expect(dist).toEqual({ 1: 10, 2: 21, 3: 31, 4: 1, 5: 0 });
    let maxDiff = 0;
    for (const r of full) maxDiff = Math.max(maxDiff, Math.abs(geomean(r.criteria as CriteriaValues) - r.excelCriticality!));
    expect(maxDiff).toBeLessThan(1e-9);
    console.info(`RISK_XLSX_PATH: rows=${t.rows.length} full=${full.length} scored=${scored.length} both=${both.length} levels=${JSON.stringify(dist)} maxIDiff=${maxDiff}`);
  });
});

describe('içe aktarım ve dışa aktarım API (R11/R12)', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  const S = {} as Record<'s1' | 's2' | 's3' | 's4' | 's5' | 's6' | 's7' | 's8' | 'hack', string>;
  let file: Buffer;
  let existingId = '';
  let batchId = '';
  const one = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows[0] as T;
  const rows = async <T = any>(sql: string, params: unknown[] = []) => (await h.owner.query(sql, params)).rows as T[];

  async function supplier(name: string) {
    return (await one<{ id: string }>(`INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, activated_by, activated_at)
      VALUES ($1,'ACTIVE','TR','VKN',$2,$3,$4,$5,now()) RETURNING id`,
      [h.world.tenantA, syntheticVkn(String(Math.floor(Math.random() * 9e8) + 1e8)), name, h.world.users.buyer.id, h.world.users.masterData.id])).id;
  }
  async function upload(who: Parameters<typeof h.call>[0], data: Buffer, name = 'risk-tablosu.xlsx') {
    const boundary = '----sp' + randomUUID();
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n`
      + `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return h.call(who, 'POST', '/api/v1/risk/imports', { body: payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  }
  const assessmentOf = (supplierId: string, year = 2026) => one<{ id: string; status: string; source: string; department_id: string | null; services: string | null;
      responsible_team: string | null; draft: any; due_on: string | null }>(
    `SELECT id, status, source, department_id, services, responsible_team, draft, due_on::text AS due_on FROM risk_assessments WHERE tenant_id = $1 AND supplier_id = $2 AND year = $3`,
    [h.world.tenantA, supplierId, year]);

  beforeAll(async () => {
    h = await makeHarness();
    S.s1 = await supplier('Test Bilişim A.Ş.');
    S.s2 = await supplier('Örnek Yazılım Ltd. Şti.');
    S.s3 = await supplier('Deneme Sistem A.Ş.');
    S.s4 = await supplier('Sınama Teknoloji A.Ş.');
    S.s5 = await supplier('Kontrol Hizmet A.Ş.');
    S.s6 = await supplier('Mevcut Kayıt A.Ş.');
    S.s7 = await supplier('Yalnız Ad Bilişim A.Ş.');
    S.s8 = await supplier('Yüksek Skor Sistem A.Ş.');
    S.hack = await supplier('=HYPERLINK("http://example.test") Test A.Ş.');
    // Mevcut 2026 değerlendirmesi: içe aktarım üzerine yazmamalı.
    existingId = (await one<{ id: string }>(`INSERT INTO risk_assessments (tenant_id, supplier_id, year, department_id, source, draft, opened_by)
      VALUES ($1,$2,2026,$3,'MANUAL',$4,$5) RETURNING id`, [h.world.tenantA, S.s6, h.world.departments.ik, { criteria: { businessImpact: 1 } }, h.world.users.buyer.id])).id;
    file = await riskWorkbook([
      sampleRow(5, { name: 'Test Bilişim A.Ş.', services: 'Yoğun bakım uygulaması (sentetik)' }), // 5
      sampleRow(19, { name: 'Örnek Yazılım Ltd. Şti.', services: 'Hizmet B (sentetik)' }), // 6: seviye 1
      sampleRow(9, { name: 'ÖRNEK YAZILIM LTD. ŞTİ', services: 'Hizmet A (sentetik)' }), // 7: seviye 3 → birincil
      sampleRow(54, { name: 'Deneme Sistem A.Ş.', services: 'Kritik hizmet (sentetik)' }), // 8: seviye 4, aksiyon planı yok
      { ...sampleRow(16, { name: 'Sınama Teknoloji A.Ş.', team: 'HIS Yönetimi (sentetik)' }), j: null }, // 9: skor boş, ekip eşlenmez
      sampleRow(17, { name: 'Kontrol Hizmet A.Ş.', k: 'Yıllık sızma testi raporu istenecek (sentetik)' }), // 10: seviye 3 + aksiyon
      sampleRow(26, { name: 'Mevcut Kayıt A.Ş.' }), // 11: çakışma
      sampleRow(56, { name: 'Eşleşmeyen Firma A.Ş.' }), // 12: eşleşmez → atla
      { name: 'Yalnız Ad Bilişim A.Ş.', services: 'Lisans (sentetik)', team: 'Bilgi Teknolojileri' }, // 13: ölçüt/skor yok
      sampleRow(100, { name: 'Yüksek Skor Sistem A.Ş.' }), // 14: seviye 3
    ]);
  });
  afterAll(async () => { await h.close(); });

  it('Departman kullanıcısı ve Denetçi içe aktaramaz (403)', async () => {
    expect((await upload('techEval', file)).status).toBe(403);
    expect((await upload('auditor', file)).status).toBe(403);
  });

  it('yanlış başlıklı dosya 422 risk_import_format; .xlsx olmayan ad 422', async () => {
    const headers = [...SOURCE_HEADERS];
    headers[0] = 'Firma';
    const r = await upload('buyer', await riskWorkbook([{ name: 'X A.Ş.' }], { headers }));
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'risk_import_format', details: { foundHeaders: expect.arrayContaining(['Firma']) } });
    expect((await upload('buyer', file, 'risk.csv')).status).toBe(422);
  });

  it('önizleme: eşleşme, kesir ölçeği, kritiklik/seviye, iki satırlı tedarikçi, ekip eşleme, çakışma, atlama', async () => {
    const r = await upload('buyer', file);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    batchId = r.body.batch.id;
    expect(r.body.batch).toMatchObject({ period: '2026-1', year: 2026, fractionScale: true, status: 'PREVIEW' });
    const row = (n: number) => r.body.rows.find((x: any) => x.rowNo === n);
    expect(row(5)).toMatchObject({ supplier: { id: S.s1 }, decision: 'CREATE', primary: true, riskScore: '15.00', outcome: 'COMPLETED',
      criticality: { display: '3,22', column: 3 }, level: { level: 2 }, department: { id: h.world.departments.bt } });
    // İki satır aynı karta: birincil en yüksek seviye (satır 7, seviye 3); diğer satır MERGE.
    expect(row(6)).toMatchObject({ supplier: { id: S.s2 }, decision: 'MERGE', primary: false, level: { level: 1 }, outcome: 'MERGE' });
    expect(row(7)).toMatchObject({ supplier: { id: S.s2 }, decision: 'CREATE', primary: true, level: { level: 3 }, outcome: 'COMPLETED' });
    expect(row(8)).toMatchObject({ level: { level: 4 }, criticality: { column: 5 }, riskScore: '48.00', outcome: 'OPEN', createsAction: false });
    expect(row(8).issues.join(' ')).toMatch(/Seviye 4–5/);
    expect(row(9)).toMatchObject({ riskScore: null, level: null, outcome: 'OPEN', department: null });
    expect(row(9).issues.join(' ')).toMatch(/eşlenmedi — departman boş/);
    expect(row(10)).toMatchObject({ createsAction: true, outcome: 'COMPLETED' });
    expect(row(11)).toMatchObject({ supplier: { id: S.s6 }, outcome: 'CONFLICT' });
    expect(row(11).issues.join(' ')).toMatch(/Çakışma/);
    expect(row(12)).toMatchObject({ supplier: null, decision: 'SKIP', outcome: 'SKIP' });
    expect(row(13)).toMatchObject({ supplier: { id: S.s7 }, outcome: 'OPEN', criteria: {} });
    expect(r.body.summary).toMatchObject({ rows: 10, completed: 4, open: 3, merged: 1, skipped: 1, conflicts: 1, unmatched: 1 });
    expect(r.body.teams).toEqual(expect.arrayContaining([
      { team: 'Bilgi Teknolojileri', rowCount: 9, department: { id: h.world.departments.bt, name: 'Bilgi Teknolojileri' } },
      { team: 'HIS Yönetimi (sentetik)', rowCount: 1, department: null },
    ]));
    // Ham satır her hücreyi saklar.
    expect(row(5).raw).toMatchObject({ A: 'Test Bilişim A.Ş.', J: 0.15, K: 'Ek bir aksiyon planı yokktur', I: { formula: 'GEOMEAN(C5:H5)' } });
    const audits = await rows(`SELECT action, data FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`, [h.world.tenantA, batchId]);
    expect(audits.find((a: any) => a.action === 'risk.import.previewed')?.data).toMatchObject({ rows: 10, completed: 4, fractionScale: true });

    expect((await h.call('techEval', 'GET', `/api/v1/risk/imports/${batchId}`)).status).toBe(403);
    expect((await h.call('buyer', 'GET', `/api/v1/risk/imports/${batchId}`)).body.rows).toHaveLength(10);
  });

  it('düzenleme: bilinmeyen ekip 422, birincil seçimi değişir ve geri alınır, eşleşmeyen satıra kart seçilir/atlanır', async () => {
    expect((await h.call('buyer', 'PUT', `/api/v1/risk/imports/${batchId}`, { body: { teamMapping: { 'Yok Ekip': null } } })).status).toBe(422);
    let r = await h.call('buyer', 'PUT', `/api/v1/risk/imports/${batchId}`, { body: { rows: [{ rowNo: 6, primary: true }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (n: number) => r.body.rows.find((x: any) => x.rowNo === n);
    expect(row(6)).toMatchObject({ decision: 'CREATE', primary: true });
    expect(row(7)).toMatchObject({ decision: 'MERGE', primary: false });
    r = await h.call('buyer', 'PUT', `/api/v1/risk/imports/${batchId}`, { body: { rows: [{ rowNo: 7, primary: true }] } });
    expect(row(7)).toMatchObject({ decision: 'CREATE', primary: true });
    expect(row(6)).toMatchObject({ decision: 'MERGE', primary: false });
    // Eşleşmeyen satıra kart seçimi CREATE yapar; tekrar atla.
    r = await h.call('buyer', 'PUT', `/api/v1/risk/imports/${batchId}`, { body: { rows: [{ rowNo: 12, supplierId: S.hack }] } });
    expect(row(12)).toMatchObject({ decision: 'CREATE', supplier: { id: S.hack } });
    r = await h.call('buyer', 'PUT', `/api/v1/risk/imports/${batchId}`, { body: { rows: [{ rowNo: 12, decision: 'SKIP', supplierId: null }] } });
    expect(row(12)).toMatchObject({ decision: 'SKIP', supplier: null });
    expect((await h.call('buyer', 'PUT', `/api/v1/risk/imports/${batchId}`, { body: { rows: [{ rowNo: 12, decision: 'CREATE' }] } })).status).toBe(422);
  });

  it('uygula: seviye ≤ 3 tam satır COMPLETED (IMPORT), seviye 4 OPEN + completion_blocked, skor boş OPEN, çakışma üzerine yazılmaz', async () => {
    const r = await h.call('buyer', 'POST', `/api/v1/risk/imports/${batchId}/apply`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ created: 7, completed: 4, open: 3, completionBlocked: 1, merged: 1, conflicts: 1, skipped: 1, actions: 1, needsDepartment: 1 });
    expect(r.body.batch.status).toBe('APPLIED');
    expect((await one(`SELECT data FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'risk.import.applied'`, [h.world.tenantA, batchId])).data)
      .toMatchObject({ created: 7, completed: 4, open: 3, conflicts: 1, skipped: 1, merged: 1 });
    const rr = (n: number) => r.body.rowResults.find((x: any) => x.rowNo === n);
    expect(rr(8)).toMatchObject({ outcome: 'completion_blocked', blockers: expect.arrayContaining([expect.objectContaining({ code: 'action_plan_required' })]) });

    const a1 = await assessmentOf(S.s1);
    expect(a1).toMatchObject({ status: 'COMPLETED', source: 'IMPORT', department_id: h.world.departments.bt, responsible_team: 'Bilgi Teknolojileri' });
    expect(await one(`SELECT score_source, to_char(risk_score,'FM990.00') AS risk_score, level, criticality::text AS criticality, criticality_column, revision_no
      FROM risk_assessment_revisions WHERE assessment_id = $1`, [a1.id])).toEqual({ score_source: 'IMPORT', risk_score: '15.00', level: 2, criticality: '3.224968', criticality_column: 3, revision_no: 1 });
    expect(await rows(`SELECT 1 FROM risk_actions WHERE assessment_id = $1`, [a1.id])).toHaveLength(0);

    const a2 = await assessmentOf(S.s2);
    expect(a2.status).toBe('COMPLETED');
    expect(a2.services).toBe('Hizmet A (sentetik); Hizmet B (sentetik)');
    expect((await one(`SELECT level FROM risk_assessment_revisions WHERE assessment_id = $1`, [a2.id])).level).toBe(3);
    expect(await rows(`SELECT row_no FROM risk_import_rows WHERE assessment_id = $1 ORDER BY row_no`, [a2.id])).toEqual([{ row_no: 6 }, { row_no: 7 }]);

    const a3 = await assessmentOf(S.s3);
    expect(a3).toMatchObject({ status: 'OPEN', source: 'IMPORT', draft: { importScore: '48.00' } });
    expect(a3.due_on).not.toBeNull();
    expect(await rows(`SELECT 1 FROM risk_assessment_revisions WHERE assessment_id = $1`, [a3.id])).toHaveLength(0);
    const g3 = await h.call('buyer', 'GET', `/api/v1/risk/assessments/${a3.id}`);
    expect(g3.body.computed).toMatchObject({ level: { level: 4 }, score: { source: 'IMPORT', value: '48.00' } });
    expect(g3.body.computed.blockers.map((b: any) => b.code)).toEqual(expect.arrayContaining(['action_plan_required', 'control_required']));
    expect(await rows(`SELECT status FROM tasks WHERE dedupe_key = $1`, [`risk:${a3.id}:due`])).toEqual([{ status: 'OPEN' }]);

    const a4 = await assessmentOf(S.s4);
    expect(a4).toMatchObject({ status: 'OPEN', department_id: null, responsible_team: 'HIS Yönetimi (sentetik)' });
    expect(a4.draft.importScore).toBeNull();
    expect(await rows(`SELECT assignee_role FROM tasks WHERE dedupe_key = $1 AND status = 'OPEN'`, [`risk:${a4.id}:department`])).toEqual([{ assignee_role: 'PROCUREMENT' }]);

    const a5 = await assessmentOf(S.s5);
    expect(a5.status).toBe('COMPLETED');
    expect(await rows(`SELECT kind, title, source, owner_user_id, due_on, status FROM risk_actions WHERE assessment_id = $1`, [a5.id])).toEqual([
      { kind: 'MITIGATION', title: 'Yıllık sızma testi raporu istenecek (sentetik)', source: 'IMPORT', owner_user_id: null, due_on: null, status: 'OPEN' }]);

    // Çakışma: mevcut değerlendirme aynen.
    const a6 = await one(`SELECT id, source, draft, department_id FROM risk_assessments WHERE supplier_id = $1 AND year = 2026`, [S.s6]);
    expect(a6).toEqual({ id: existingId, source: 'MANUAL', draft: { criteria: { businessImpact: 1 } }, department_id: h.world.departments.ik });
    expect(await rows(`SELECT 1 FROM risk_assessment_revisions WHERE assessment_id = $1`, [existingId])).toHaveLength(0);

    expect((await assessmentOf(S.s7)).status).toBe('OPEN');
    expect(await assessmentOf(S.hack)).toBeUndefined();
    // Hiçbir satır kaybolmaz: 10 ham satır, bağlı değerlendirmeler.
    expect((await one(`SELECT count(*)::int AS n FROM risk_import_rows WHERE batch_id = $1`, [batchId])).n).toBe(10);
  });

  it('ikinci uygulama reddedilir: aynı parti 409 not_preview; aynı dosya yeni partide 409 already_imported', async () => {
    expect((await h.call('buyer', 'POST', `/api/v1/risk/imports/${batchId}/apply`)).body.error.code).toBe('not_preview');
    const again = await upload('buyer', file);
    expect(again.status).toBe(201);
    expect(again.body.alreadyApplied).toBe(true);
    expect(again.body.can.apply).toBe(false);
    const r = await h.call('buyer', 'POST', `/api/v1/risk/imports/${again.body.batch.id}/apply`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('already_imported');
    const d = await h.call('buyer', 'POST', `/api/v1/risk/imports/${again.body.batch.id}/discard`);
    expect(d.body.batch.status).toBe('DISCARDED');
    expect((await h.call('buyer', 'PUT', `/api/v1/risk/imports/${again.body.batch.id}`, { body: { year: 2025 } })).status).toBe(409);
  });

  it('yeni aday kart: eşleşmeyen satır NEW_CANDIDATE → VKN\'siz CANDIDATE + kimlik incelemesi', async () => {
    const buf = await riskWorkbook([sampleRow(7, { name: 'Yepyeni Aday Bilişim A.Ş.' })], { period: '2025-4' });
    const up = await upload('buyer', buf);
    expect(up.body.rows[0]).toMatchObject({ decision: 'SKIP', supplier: null });
    const put = await h.call('buyer', 'PUT', `/api/v1/risk/imports/${up.body.batch.id}`, { body: { rows: [{ rowNo: 5, decision: 'NEW_CANDIDATE' }] } });
    expect(put.body.rows[0]).toMatchObject({ decision: 'NEW_CANDIDATE', primary: true, outcome: 'COMPLETED' });
    const r = await h.call('buyer', 'POST', `/api/v1/risk/imports/${up.body.batch.id}/apply`);
    expect(r.body.result).toMatchObject({ newCandidates: 1, completed: 1 });
    const s = await one(`SELECT id, status, tax_id, identity_review_required FROM suppliers WHERE tenant_id = $1 AND legal_name = 'Yepyeni Aday Bilişim A.Ş.'`, [h.world.tenantA]);
    expect(s).toMatchObject({ status: 'CANDIDATE', tax_id: null, identity_review_required: true });
    expect((await assessmentOf(s.id, 2025)).status).toBe('COMPLETED');
  });


  describe('düzeltme turu 1 (I2, M1, M2, M5)', () => {
    const dsup = async (n: string) => supplier(n);
    it('I2: K\'de "aksiyon planı yok" sonrası yorum aksiyon üretmez; tamamlananda score_note, açıkta taslakta "Excel notu"', async () => {
      const a = await dsup('Not Bir A.Ş.'), b = await dsup('Not İki A.Ş.');
      const up = await upload('buyer', await riskWorkbook([
        sampleRow(5, { name: 'Not Bir A.Ş.', k: 'Ek bir aksiyon planı yokktur. Not: sözleşme yenilemesi bekleniyor' }),
        sampleRow(54, { name: 'Not İki A.Ş.', k: 'Aksiyon planı yoktur - tedarikçi ile toplantı yapıldı' }),
      ], { period: '2024-2' }));
      expect(up.status, JSON.stringify(up.body)).toBe(201);
      expect(up.body.rows[0]).toMatchObject({ createsAction: false, commentNote: 'Not: sözleşme yenilemesi bekleniyor' });
      expect(up.body.rows[1]).toMatchObject({ createsAction: false, commentNote: 'tedarikçi ile toplantı yapıldı' });
      const r = await h.call('buyer', 'POST', `/api/v1/risk/imports/${up.body.batch.id}/apply`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.result).toMatchObject({ completed: 1, open: 1, actions: 0 });
      const a1 = await assessmentOf(a, 2024), a2 = await assessmentOf(b, 2024);
      const rev = await one(`SELECT score_note FROM risk_assessment_revisions WHERE assessment_id = $1`, [a1.id]);
      expect(rev.score_note).toMatch(/^Excel içe aktarımı: risk-tablosu\.xlsx, satır 5\. Excel notu: Not: sözleşme yenilemesi bekleniyor$/);
      expect(a2).toMatchObject({ status: 'OPEN', draft: { importNote: 'Excel notu: tedarikçi ile toplantı yapıldı' } });
      expect(await rows(`SELECT 1 FROM risk_actions WHERE assessment_id = ANY($1::uuid[])`, [[a1.id, a2.id]])).toHaveLength(0);
    });

    it('M2: ekibi eşlenmeyen satır tamamlanmış açılsa da Satınalma\'ya "Sorumlu departmanı seçin" görevi', async () => {
      const a = await dsup('Departmansız Tamam A.Ş.');
      const up = await upload('buyer', await riskWorkbook([sampleRow(5, { name: 'Departmansız Tamam A.Ş.', team: 'Eşlenmeyen Ekip (sentetik)' })], { period: '2024-3' }));
      const r = await h.call('buyer', 'POST', `/api/v1/risk/imports/${up.body.batch.id}/apply`);
      expect(r.body.result).toMatchObject({ completed: 1, open: 0, needsDepartment: 1 });
      const x = await assessmentOf(a, 2024);
      expect(x).toMatchObject({ status: 'COMPLETED', department_id: null });
      expect(await rows(`SELECT assignee_role FROM tasks WHERE dedupe_key = $1 AND status = 'OPEN'`, [`risk:${x.id}:department`])).toEqual([{ assignee_role: 'PROCUREMENT' }]);
    });

    it('M5: satır başka karta taşınınca eski birincil işaret yeni grubun birincilini çalmaz', async () => {
      const a = await dsup('Taşınan Satır A.Ş.'), b = await dsup('Hedef Kart A.Ş.');
      const up = await upload('buyer', await riskWorkbook([
        sampleRow(54, { name: 'Taşınan Satır A.Ş.' }), sampleRow(9, { name: 'Hedef Kart A.Ş.' }), sampleRow(19, { name: 'Hedef Kart A.Ş.' }),
      ], { period: '2024-4' }));
      const id = up.body.batch.id;
      const row = (body: any, n: number) => body.rows.find((x: any) => x.rowNo === n);
      expect(row(up.body, 5)).toMatchObject({ supplier: { id: a }, primary: true });
      expect(row(up.body, 6)).toMatchObject({ supplier: { id: b }, primary: true });
      const put = await h.call('buyer', 'PUT', `/api/v1/risk/imports/${id}`, { body: { rows: [{ rowNo: 5, supplierId: b }] } });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(row(put.body, 6)).toMatchObject({ decision: 'CREATE', primary: true });
      expect(row(put.body, 5)).toMatchObject({ decision: 'MERGE', primary: false });
      expect(row(put.body, 7)).toMatchObject({ decision: 'MERGE', primary: false });
      expect(await one(`SELECT count(*)::int AS n FROM risk_import_rows WHERE batch_id = $1 AND primary_row AND supplier_id = $2`, [id, b])).toEqual({ n: 1 });
    });

    it('M1: aynı dosyanın iki partisi eşzamanlı uygulanınca biri 200, diğeri already_imported', async () => {
      await dsup('Eşzamanlı Uygulama A.Ş.');
      const buf = await riskWorkbook([sampleRow(5, { name: 'Eşzamanlı Uygulama A.Ş.' })], { period: '2023-1' });
      const u1 = await upload('buyer', buf), u2 = await upload('buyer', buf);
      const [r1, r2] = await Promise.all([
        h.call('buyer', 'POST', `/api/v1/risk/imports/${u1.body.batch.id}/apply`), h.call('buyer', 'POST', `/api/v1/risk/imports/${u2.body.batch.id}/apply`)]);
      const codes = [r1.status, r2.status].sort();
      expect(codes, JSON.stringify([r1.body, r2.body])).toEqual([200, 409]);
      const loser = r1.status === 409 ? r1 : r2;
      expect(loser.body.error.code).toBe('already_imported');
    });
  });

  describe('dışa aktarım', () => {
    let wb: ExcelJS.Workbook;
    let exported: Buffer;
    beforeAll(async () => {
      // Formül enjeksiyonu: "=" ile başlayan ad.
      await h.owner.query(`INSERT INTO risk_assessments (tenant_id, supplier_id, year, department_id, source, draft, opened_by) VALUES ($1,$2,2026,$3,'MANUAL',$4,$5)`,
        [h.world.tenantA, S.hack, h.world.departments.bt, { criteria: toCriteria([3, 3, 3, 3, 1, 3]), importScore: '8.00' }, h.world.users.buyer.id]);
    });

    it('yetki: Departman kullanıcısı 403; Denetçi ve Satınalma indirir; dosya adı ve denetim', async () => {
      expect((await h.call('techEval', 'GET', '/api/v1/risk/export.xlsx?year=2026')).status).toBe(403);
      expect((await h.call('auditor', 'GET', '/api/v1/risk/export.xlsx?year=2026&period=2026-1')).status).toBe(200);
      expect((await h.call('buyer', 'GET', '/api/v1/risk/export.xlsx?year=2026&period=2026-9')).status).toBe(400);
      const r = await h.call('buyer', 'GET', '/api/v1/risk/export.xlsx?year=2026&period=2026-1');
      expect(r.status).toBe(200);
      expect(String(r.headers['content-disposition'])).toContain(`filename*=UTF-8''${encodeURIComponent('BT Tedarikçi Risk Değerlendirme Tablosu 2026-1.xlsx')}`);
      exported = r.raw as Buffer;
      expect((await one(`SELECT data FROM audit_events WHERE tenant_id = $1 AND action = 'risk.exported' ORDER BY id DESC LIMIT 1`, [h.world.tenantA])).data)
        .toMatchObject({ year: 2026, period: '2026-1' });
      wb = new ExcelJS.Workbook();
      await wb.xlsx.load(exported as unknown as ArrayBuffer);
    });

    it('Risk Tablosu A1:L4 kaynakla birebir; I GEOMEAN formülü; J kesir; "=" ile başlayan ad kaçışlı', async () => {
      expect(wb.worksheets.map((w) => w.name)).toEqual(['Risk Tablosu', 'Risk Grafiği', 'Seviye ve aksiyonlar']);
      const ws = wb.getWorksheet('Risk Tablosu')!;
      expect(ws.getCell('A1').value).toBe('Dönem:');
      expect(ws.getCell('B1').value).toBe('2026-1');
      for (const [range, text] of SOURCE_GROUPS) expect(ws.getCell(range.split(':')[0]!).value).toBe(text);
      expect([...(ws.model.merges as string[])].sort()).toEqual(['A2:B2', 'C2:H2', 'I2:J2']);
      SOURCE_HEADERS.forEach((t, i) => expect(ws.getRow(3).getCell(i + 1).value).toBe(t));
      SOURCE_NOTES.forEach((t, i) => expect(ws.getRow(4).getCell(i + 1).value ?? null).toBe(t));
      const names: string[] = [];
      for (let r = 5; r <= ws.rowCount; r++) names.push(String(ws.getCell(`A${r}`).value));
      const r1 = 5 + names.indexOf('Test Bilişim A.Ş.');
      expect(ws.getCell(`I${r1}`).value).toEqual({ formula: `GEOMEAN(C${r1}:H${r1})`, result: geomean(toCriteria([3, 5, 1, 3, 5, 5])) });
      expect(ws.getCell(`J${r1}`).value).toBe(0.15);
      expect(ws.getCell(`K${r1}`).value).toBe('Ek bir aksiyon planı yoktur');
      expect(ws.getCell(`L${r1}`).value).toBe('Bilgi Teknolojileri');
      const r5 = 5 + names.indexOf('Kontrol Hizmet A.Ş.');
      expect(ws.getCell(`K${r5}`).value).toBe('Yıllık sızma testi raporu istenecek (sentetik)');
      expect(names).toContain(`'=HYPERLINK("http://example.test") Test A.Ş.`);
      // Değerlendirmesi açık ve ölçütsüz satır boş hücreyle.
      const r7 = 5 + names.indexOf('Yalnız Ad Bilişim A.Ş.');
      expect([ws.getCell(`C${r7}`).value, ws.getCell(`I${r7}`).value, ws.getCell(`J${r7}`).value]).toEqual([null, null, null]);
      expect(ws.autoFilter).toBe(`A4:L${ws.rowCount}`);
    });

    it('Risk Grafiği matrisi Excel ile aynı; Seviye ve aksiyonlar sayfası', async () => {
      const g = wb.getWorksheet('Risk Grafiği')!;
      expect(g.getCell('C3').value).toBe('Risk Grafiği');
      const grid = [5, 6, 7, 8, 9].map((r) => [3, 4, 5, 6, 7, 8].map((c) => g.getRow(r).getCell(c).value));
      expect(grid).toEqual([[100, 3, 3, 4, 5, 5], [80, 2, 3, 3, 4, 5], [60, 2, 2, 3, 3, 4], [40, 1, 2, 2, 3, 3], [20, 1, 1, 2, 2, 3]]);
      expect([4, 5, 6, 7, 8].map((c) => g.getRow(10).getCell(c).value)).toEqual([1, 2, 3, 4, 5]);
      const d = wb.getWorksheet('Seviye ve aksiyonlar')!;
      expect(d.getRow(1).getCell(8).value).toBe('Seviye');
      let found = false;
      d.eachRow((row, n) => {
        if (n > 1 && row.getCell(1).value === 'Deneme Sistem A.Ş.') {
          found = true;
          expect([row.getCell(6).value, row.getCell(7).value, row.getCell(8).value, row.getCell(10).value, row.getCell(11).value])
            .toEqual([5, 48, 4, 'Açık', 'Excel içe aktarımı']);
        }
      });
      expect(found).toBe(true);
    });

    it('gidiş-dönüş: dışa aktarılan dosya yeniden ayrıştırılınca ölçüt, skor ve seviye aynı; yeniden içe aktarım üzerine yazmaz', async () => {
      const list = (await h.call('buyer', 'GET', '/api/v1/risk/assessments?year=2026')).body.items as any[];
      const t = await parseRiskTable(exported);
      expect(t.fractionScale).toBe(true);
      expect(t.rows).toHaveLength(list.length);
      for (const r of t.rows) {
        const item = list.find((x) => x.supplier.name === r.name)!;
        expect(item, r.name!).toBeTruthy();
        const detail = (await h.call('buyer', 'GET', `/api/v1/risk/assessments/${item.id}`)).body;
        const src = detail.assessment.status === 'COMPLETED' ? detail.revisions[0] : null;
        const criteria = src ? src.criteria : detail.draft.criteria;
        const score = src ? src.riskScore : detail.computed.score?.value ?? null;
        const level = src ? src.level : detail.computed.level?.level ?? null;
        expect(r.criteria).toEqual(criteria);
        // Kısmi ölçütlü taslak (çakışma örneğindeki mevcut kayıt) dışında satır sorunu yok.
        if ([0, 6].includes(Object.keys(criteria).length)) expect(r.issues).toEqual([]);
        expect(r.riskScore).toBe(score);
        const lv = r.criteriaComplete && r.riskScore ? riskLevel(r.riskScore, criticality(r.criteria as CriteriaValues).column).level : null;
        expect(lv).toBe(level);
      }
      const re = await upload('buyer', exported, 'BT Tedarikci Risk 2026-1.xlsx');
      expect(re.status).toBe(201);
      expect(re.body.rows.every((x: any) => x.outcome === 'CONFLICT' || x.outcome === 'MERGE' || x.outcome === 'SKIP')).toBe(true);
      expect(re.body.summary.conflicts).toBe(list.length);
    });
  });
});
