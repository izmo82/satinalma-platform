import { describe, expect, it } from 'vitest';
import { can, PERMISSIONS, SUPPLIER_STATUSES, APPLICATION_STATUSES, OFFBOARDING_ITEMS, applicationDecisionEmail, canInviteSupplier, documentExpiryEmail, documentReminderDates, documentValidity, documentsRequestedEmail, inviteEmail, missingDocuments, nextApplicationStatus, offboardingComplete, portalAccessEmail, portalStanding, requiredDocumentTypes, stageStatuses, supplierStage, verificationEmail, type DocType } from '../src/index.ts';

describe('R1 aşama', () => {
  it('her durumun aşaması', () => {
    expect(SUPPLIER_STATUSES.map((s) => supplierStage(s))).toEqual([
      { code: 'CANDIDATE', label: 'Aday' }, { code: 'APPROVED', label: 'Onaylı (koşullu)' }, { code: 'APPROVED', label: 'Onaylı' },
      { code: 'PASSIVE', label: 'Pasif' }, { code: 'PASSIVE', label: 'Pasif' }, { code: 'REJECTED', label: 'Reddedildi' }, { code: 'MERGED', label: 'Birleştirildi' }]);
  });
  it('süzgeç eşlemesi her durumu tam bir aşamaya koyar', () => {
    const all = (['CANDIDATE', 'APPROVED', 'PASSIVE', 'REJECTED', 'MERGED'] as const).flatMap((c) => stageStatuses(c));
    expect([...all].sort()).toEqual([...SUPPLIER_STATUSES].sort());
    expect(stageStatuses('APPROVED')).toEqual(['ACTIVE', 'CONDITIONAL']);
  });
  it('R9 yalnız onaylı davet edilir; aday edilemez', () => {
    expect(SUPPLIER_STATUSES.filter(canInviteSupplier)).toEqual(['CONDITIONAL', 'ACTIVE']);
    expect(canInviteSupplier('CANDIDATE')).toBe(false);
  });
});

describe('R2 başvuru geçişleri', () => {
  it('geçerli akış', () => {
    expect(nextApplicationStatus('UNVERIFIED', 'VERIFY')).toBe('SUBMITTED');
    expect(nextApplicationStatus('SUBMITTED', 'REQUEST_DOCUMENTS')).toBe('NEEDS_DOCUMENTS');
    expect(nextApplicationStatus('NEEDS_DOCUMENTS', 'COMPLETE')).toBe('SUBMITTED');
    expect(nextApplicationStatus('SUBMITTED', 'APPROVE')).toBe('APPROVED');
    expect(nextApplicationStatus('SUBMITTED', 'REJECT')).toBe('REJECTED');
    expect(nextApplicationStatus('UNVERIFIED', 'EXPIRE')).toBe('EXPIRED');
  });
  it('UNVERIFIED -> APPROVED ve sonlanmış durumlardan çıkış geçersiz', () => {
    expect(nextApplicationStatus('UNVERIFIED', 'APPROVE')).toEqual({ error: 'invalid_transition' });
    expect(nextApplicationStatus('NEEDS_DOCUMENTS', 'APPROVE')).toEqual({ error: 'invalid_transition' });
    for (const s of ['APPROVED', 'REJECTED', 'EXPIRED'] as const) for (const a of ['VERIFY', 'APPROVE', 'REQUEST_DOCUMENTS', 'COMPLETE', 'REJECT', 'EXPIRE'] as const) expect(nextApplicationStatus(s, a)).toEqual({ error: 'invalid_transition' });
    expect(APPLICATION_STATUSES).toHaveLength(6);
  });
  it('son inceleme I1: eksik belge bekleyen başvuruda istek yeniden gönderilebilir (süresi dolan bağlantı için)', () => {
    expect(nextApplicationStatus('NEEDS_DOCUMENTS', 'REQUEST_DOCUMENTS')).toBe('NEEDS_DOCUMENTS');
    expect(nextApplicationStatus('NEEDS_DOCUMENTS', 'REJECT')).toBe('REJECTED');
    expect(nextApplicationStatus('NEEDS_DOCUMENTS', 'VERIFY')).toEqual({ error: 'invalid_transition' });
  });
});

const T = (code: string, o: Partial<DocType> = {}): DocType => ({ code, name: code, active: true, requiredMode: 'ALWAYS', categories: [], requiresExpiry: false, ...o });
describe('belgeler', () => {
  const types = [T('VERGI', { requiresExpiry: true }), T('SIRKU'), T('ISO27001', { requiredMode: 'CATEGORIES', categories: ['Bilgi teknolojileri'], requiresExpiry: true }), T('ESKI', { active: false })];
  it('ISO 27001 yalnız BT kategorisinde zorunlu; pasif tür zorunlu değil', () => {
    expect(requiredDocumentTypes(types, ['Temizlik']).map((t) => t.code)).toEqual(['VERGI', 'SIRKU']);
    expect(requiredDocumentTypes(types, ['Temizlik', 'Bilgi teknolojileri']).map((t) => t.code)).toEqual(['VERGI', 'SIRKU', 'ISO27001']);
  });
  it('eksik, süresi dolmuş, tarihsiz; bitiş günü dahil geçerli', () => {
    const req = types.slice(0, 3);
    expect(missingDocuments(req, [], '2026-11-17')).toEqual([{ code: 'VERGI', reason: 'MISSING' }, { code: 'SIRKU', reason: 'MISSING' }, { code: 'ISO27001', reason: 'MISSING' }]);
    const up = (typeCode: string, validUntil: string | null, supersededById: string | null = null) => ({ typeCode, validUntil, supersededById });
    expect(missingDocuments(req, [up('VERGI', '2026-11-16'), up('SIRKU', null), up('ISO27001', null)], '2026-11-17')).toEqual([{ code: 'VERGI', reason: 'EXPIRED' }, { code: 'ISO27001', reason: 'NO_EXPIRY_DATE' }]);
    expect(missingDocuments(req, [up('VERGI', '2026-11-17'), up('SIRKU', null), up('ISO27001', '2027-01-01')], '2026-11-17')).toEqual([]);
  });
  it('yerine yenisi yüklenen eski belge sayılmaz', () => {
    const r = [T('VERGI', { requiresExpiry: true })];
    expect(missingDocuments(r, [{ typeCode: 'VERGI', validUntil: '2030-01-01', supersededById: 'yeni' }], '2026-11-17')).toEqual([{ code: 'VERGI', reason: 'MISSING' }]);
    expect(missingDocuments(r, [{ typeCode: 'VERGI', validUntil: '2020-01-01', supersededById: 'yeni' }, { typeCode: 'VERGI', validUntil: '2027-01-01', supersededById: null }], '2026-11-17')).toEqual([]);
  });
  it('geçerlilik sınırları', () => {
    const today = '2026-11-17';
    expect(documentValidity(null, today)).toEqual({ code: 'NO_EXPIRY', label: 'Süresiz', daysLeft: null });
    expect(documentValidity('2026-11-17', today)).toMatchObject({ code: 'EXPIRING', daysLeft: 0 });
    expect(documentValidity('2026-11-16', today)).toMatchObject({ code: 'EXPIRED', daysLeft: -1 });
    expect(documentValidity('2026-12-17', today)).toMatchObject({ code: 'EXPIRING', daysLeft: 30 });
    expect(documentValidity('2026-12-18', today)).toMatchObject({ code: 'VALID', daysLeft: 31, label: 'Geçerli' });
    expect(documentValidity('2026-12-18', today, 45).code).toBe('EXPIRING');
  });
  it('hatırlatma tarihleri (ay ve yıl geçişi dahil)', () => {
    expect(documentReminderDates('2026-12-31')).toEqual([{ offset: 30, date: '2026-12-01' }, { offset: 7, date: '2026-12-24' }, { offset: 0, date: '2026-12-31' }]);
    expect(documentReminderDates('2027-01-10', [30])).toEqual([{ offset: 30, date: '2026-12-11' }]);
  });
});

describe('R15 portalStanding', () => {
  const base = { surveys: [], review: null, verifiedIncidents: [], residualLevel: null, actions: [], pendingSurveys: 0, missingDocs: 0 };
  it('yalnız izinli anahtarlar', () => {
    const r = portalStanding({ ...base, surveys: [{ ratio: '70' }], residualLevel: 'HIGH' });
    expect(Object.keys(r).sort()).toEqual(['expectedActions', 'level', 'levelLabel', 'score', 'scoreReason']);
  });
  it('puan D103 örnekleriyle aynı', () => {
    expect(portalStanding({ ...base, surveys: [{ ratio: '70' }, { ratio: '90' }] })).toMatchObject({ score: 80, scoreReason: null });
    expect(portalStanding({ ...base, surveys: [{ ratio: '70' }], review: { score: '80' }, residualLevel: 'HIGH', verifiedIncidents: [{ severity: 'MEDIUM' }] })).toMatchObject({ score: 65, level: 'HIGH', levelLabel: 'yüksek' });
  });
  it('puanın risk girdisi scoreRiskLevel (yearSummary ile aynı); görünen seviye residualLevel; scoreRiskLevel dönmez', () => {
    const r = portalStanding({ ...base, surveys: [{ ratio: '70' }], residualLevel: 'LOW', scoreRiskLevel: 'HIGH' });
    expect(r).toMatchObject({ score: portalStanding({ ...base, surveys: [{ ratio: '70' }], residualLevel: 'HIGH' }).score, level: 'LOW' });
    expect(r.score).toBeLessThan(70);
    expect(Object.keys(r)).not.toContain('scoreRiskLevel');
    expect(portalStanding({ ...base, surveys: [{ ratio: '70' }], residualLevel: 'HIGH', scoreRiskLevel: null }).score).toBe(70);
  });
  it('veri yoksa puan yok, gerekçe var', () => {
    const r = portalStanding(base);
    expect(r.score).toBeNull(); expect(r.scoreReason).toContain('anket'); expect(r.level).toBeNull(); expect(r.levelLabel).toBeNull();
  });
  it('beklenen aksiyonlar: açık düzeltici, belge, anket; kapalı olanlar yok', () => {
    const r = portalStanding({ ...base, actions: [{ title: 'MFA', dueDate: '2026-12-01', status: 'OPEN' }, { title: 'Eski', dueDate: '2026-01-01', status: 'COMPLETED' }], pendingSurveys: 2, missingDocs: 1 });
    expect(r.expectedActions.map((a) => a.kind)).toEqual(['CORRECTIVE', 'DOCUMENT', 'SURVEY']);
    expect(r.expectedActions[0]).toEqual({ kind: 'CORRECTIVE', title: 'MFA', dueDate: '2026-12-01' });
  });
});

describe('R13 ayrılış listesi', () => {
  const done = OFFBOARDING_ITEMS.map((o) => ({ code: o.code, doneAt: null as string | null, notApplicable: false }));
  it('"Uygulanmaz" ile tamamlanır; eksik madde tamamlatmaz', () => {
    expect(offboardingComplete(done)).toBe(false);
    expect(offboardingComplete(done.map((i, k) => (k % 2 ? { ...i, doneAt: '2026-11-17T10:00:00Z' } : { ...i, notApplicable: true })))).toBe(true);
    expect(offboardingComplete(done.slice(1).map((i) => ({ ...i, notApplicable: true })))).toBe(false);
  });
});

describe('e-posta şablonları', () => {
  it('davet: bağlantı, son tarih İstanbul saatiyle, kapsam 600 karakterde kesilir', () => {
    const scope = 'a'.repeat(600) + 'ZZZ';
    const m = inviteEmail({ supplierName: 'Örnek A.Ş.', projectTitle: 'Ağ yenileme', scopeSummary: scope, closesAt: '2026-12-21T14:00:00Z', link: 'https://app.example.test/portal/r1' });
    expect(m.subject).toBe('Teklif daveti: Ağ yenileme');
    expect(m.body).toContain('https://app.example.test/portal/r1');
    expect(m.body).toContain('21.12.2026 17:00');
    expect(m.body).toContain('a'.repeat(600) + '…');
    expect(m.body).not.toContain('ZZZ');
    expect(inviteEmail({ supplierName: 'X', projectTitle: 'P', scopeSummary: 'kısa', closesAt: '2026-12-21T14:00:00Z', link: 'l' }).body).toContain('kısa');
  });
  it('diğer şablonlar', () => {
    expect(verificationEmail({ legalName: 'Örnek', link: 'https://x.test/#t' }).body).toContain('24 saat');
    const d = documentsRequestedEmail({ legalName: 'Örnek', documents: ['Vergi levhası', 'İmza sirküleri'], note: 'Güncel olsun', link: 'L' });
    expect(d.body).toContain('- Vergi levhası'); expect(d.body).toContain('Güncel olsun');
    expect(documentsRequestedEmail({ legalName: 'Ö', documents: ['A'], note: null, link: 'L' }).body).not.toContain('Not:');
    expect(applicationDecisionEmail({ legalName: 'Ö', decision: 'REJECTED', reason: 'Kapsam dışı' }).body).toContain('Kapsam dışı');
    expect(applicationDecisionEmail({ legalName: 'Ö', decision: 'APPROVED' }).subject).toContain('kabul edildi');
    expect(portalAccessEmail({ name: 'Ayşe', link: 'L' }).body).toContain('misafir');
    const e = documentExpiryEmail({ supplierName: 'Ö', documentName: 'Vergi levhası', validUntil: '2026-12-31', offset: 7, link: 'L' });
    expect(e.body).toContain('7 gün sonra (31.12.2026)');
    expect(documentExpiryEmail({ supplierName: 'Ö', documentName: 'V', validUntil: '2026-12-31', offset: 0, link: 'L' }).body).toContain('bugün');
  });
});

describe('izinler', () => {
  it('Faz 5 izinleri', () => {
    expect(PERMISSIONS['supplier.application.review']).toEqual(['PROCUREMENT']);
    expect(PERMISSIONS['supplier.application.settings']).toEqual(['ADMIN']);
    expect(can(['PROCUREMENT'], 'supplier.application.settings.view')).toBe(true);
    expect(can(['PROCUREMENT'], 'supplier.application.settings')).toBe(false);
    expect(PERMISSIONS['email.outbox.read']).toEqual(['ADMIN']);
    for (const p of ['portal.documents', 'portal.standing', 'portal.profile'] as const) expect(PERMISSIONS[p]).toEqual(['SUPPLIER']);
    for (const p of ['supplier.profile.edit', 'supplier.offboard', 'supplier.portal_users.manage', 'supplier.documents.manage'] as const) expect(PERMISSIONS[p]).toEqual(['PROCUREMENT']);
  });
});
