import { describe, expect, it } from 'vitest';
import {
  CONTRACT_TYPES, CONTRACT_TYPE_TR, REQUIRED_FIELD_TR, canDecide, contractStatus, missingRequired, planChain, reminderDates,
  type ContractFields,
} from '../src/contractV2.ts';
import { can } from '../src/roles.ts';

const full: ContractFields = {
  project: 'p1', supplier: 's1', contractType: 'SERVICE', owner: 'u1', signedOn: '2026-01-01', amount: '1000.00', currency: 'TRY',
  limitBasis: 'NET', startDate: '2026-01-01', endDate: '2028-12-31', indefinite: false, autoRenewal: false, noticePeriod: null,
};

describe('sabitler', () => {
  it('sözleşme türleri ve Türkçe etiketleri', () => {
    expect(CONTRACT_TYPES).toEqual(['SERVICE', 'HARDWARE', 'MAINTENANCE', 'NDA', 'CONSULTING', 'OTHER']);
    expect(CONTRACT_TYPE_TR.MAINTENANCE).toBe('Bakım-destek');
    expect(CONTRACT_TYPE_TR.NDA).toBe('Gizlilik');
    expect(REQUIRED_FIELD_TR.project).toBe('Proje');
  });
});

describe('missingRequired', () => {
  it('tam kayıt boş döner', () => expect(missingRequired(full)).toEqual([]));
  it('proje yok', () => expect(missingRequired({ ...full, project: null })).toEqual(['project']));
  it('süresiz + ihbar yok', () => {
    expect(missingRequired({ ...full, indefinite: true, endDate: null })).toEqual(['noticePeriod']);
    expect(missingRequired({ ...full, indefinite: true, endDate: null, noticePeriod: '3 ay' })).toEqual([]);
  });
  it('süreli kayıtta bitiş zorunlu', () => expect(missingRequired({ ...full, endDate: null })).toEqual(['endDate']));
  it('otomatik yenileme ihbar ister; autoRenewal null eksik', () => {
    expect(missingRequired({ ...full, autoRenewal: true })).toEqual(['noticePeriod']);
    expect(missingRequired({ ...full, autoRenewal: null })).toEqual(['autoRenewal']);
  });
  it('boş metin eksik sayılır', () => expect(missingRequired({ ...full, amount: '  ' })).toEqual(['amount']));
});

describe('contractStatus', () => {
  const base: Parameters<typeof contractStatus>[0] = { missing: [], chains: [], legacy: false, endDate: '2028-12-31', indefinite: false, today: '2026-11-17' };
  it('eksik alan', () => expect(contractStatus({ ...base, missing: ['project'] })).toEqual({ code: 'INCOMPLETE', label: 'Eksik alan' }));
  it('taslak', () => expect(contractStatus(base)).toEqual({ code: 'DRAFT', label: 'Taslak' }));
  it('onayda: sıradaki adım unvanı', () => {
    expect(contractStatus({ ...base, chains: [{ status: 'OPEN', nextStepKind: 'PROCUREMENT_LEAD' }] }))
      .toEqual({ code: 'IN_APPROVAL', label: 'Satınalma sorumlusu onayında' });
    expect(contractStatus({ ...base, chains: [{ status: 'OPEN', nextStepKind: 'DEPARTMENT_HEAD' }] }).label).toBe('Departman sorumlusu onayında');
    expect(contractStatus({ ...base, chains: [{ status: 'OPEN', nextStepKind: 'PROCUREMENT_DIRECTOR' }] }).label).toBe('Satınalma direktörü onayında');
    expect(contractStatus({ ...base, chains: [{ status: 'OPEN', nextStepKind: 'EXTRA' }] }).label).toBe('Ek onaycı onayında');
  });
  it('reddedildi', () => expect(contractStatus({ ...base, chains: [{ status: 'REJECTED' }] })).toEqual({ code: 'REJECTED', label: 'Reddedildi' }));
  it('yeni zincir eskinin reddini aşar', () => {
    expect(contractStatus({ ...base, chains: [{ status: 'REJECTED' }, { status: 'APPROVED' }] }).code).toBe('APPROVED');
  });
  it('yürürlükte', () => expect(contractStatus({ ...base, chains: [{ status: 'APPROVED' }] })).toEqual({ code: 'APPROVED', label: 'Yürürlükte' }));
  it('süresiz onaylı yürürlükte kalır', () => {
    expect(contractStatus({ ...base, endDate: null, indefinite: true, chains: [{ status: 'APPROVED' }] }).code).toBe('APPROVED');
  });
  it('süresi doldu', () => {
    expect(contractStatus({ ...base, endDate: '2026-11-16', chains: [{ status: 'APPROVED' }] })).toEqual({ code: 'EXPIRED', label: 'Süresi doldu' });
    expect(contractStatus({ ...base, endDate: '2026-11-17', chains: [{ status: 'APPROVED' }] }).code).toBe('APPROVED');
  });
  it('iptal edilen zincir taslağa döner', () => expect(contractStatus({ ...base, chains: [{ status: 'APPROVED' }, { status: 'CANCELLED' }] }).code).toBe('DRAFT'));
  it('eski kayıt', () => {
    expect(contractStatus({ ...base, legacy: true })).toEqual({ code: 'LEGACY', label: 'Onay kaydı yok (eski kayıt)' });
    expect(contractStatus({ ...base, legacy: true, missing: ['owner'] }).code).toBe('INCOMPLETE');
    expect(contractStatus({ ...base, legacy: true, endDate: '2020-01-01' }).code).toBe('EXPIRED');
  });
});

describe('planChain', () => {
  const P = (id: string) => ({ id });
  const approvers = { head: P('h'), deputy: P('hd'), lead: P('l'), leadDeputy: P('ld'), director: P('d'), directorDeputy: P('dd') };
  const input = { creatorId: 'c', approvers, useDeputyForHead: false, extras: [] as string[] };
  it('normal üç adım', () => {
    expect(planChain(input)).toEqual({ steps: [
      { order: 1, kind: 'DEPARTMENT_HEAD', userId: 'h', viaDeputy: false },
      { order: 2, kind: 'PROCUREMENT_LEAD', userId: 'l', viaDeputy: false },
      { order: 3, kind: 'PROCUREMENT_DIRECTOR', userId: 'd', viaDeputy: false },
    ] });
  });
  it('useDeputyForHead vekili koyar', () => {
    const r = planChain({ ...input, useDeputyForHead: true });
    expect('steps' in r && r.steps[0]).toEqual({ order: 1, kind: 'DEPARTMENT_HEAD', userId: 'hd', viaDeputy: true });
  });
  it('useDeputyForHead ama vekil yok -> hata', () => {
    expect(planChain({ ...input, useDeputyForHead: true, approvers: { ...approvers, deputy: null } })).toEqual({ error: 'no_eligible_approver', kind: 'DEPARTMENT_HEAD' });
  });
  it('ekleyen = sorumlu -> vekil', () => {
    const r = planChain({ ...input, creatorId: 'h' });
    expect('steps' in r && r.steps[0]).toEqual({ order: 1, kind: 'DEPARTMENT_HEAD', userId: 'hd', viaDeputy: true });
  });
  it('ekleyen = sorumlu ve vekil yok -> hata', () => {
    expect(planChain({ ...input, creatorId: 'h', approvers: { ...approvers, deputy: null } })).toEqual({ error: 'no_eligible_approver', kind: 'DEPARTMENT_HEAD' });
  });
  it('vekil de ekleyen ise hata', () => {
    expect(planChain({ ...input, creatorId: 'l', approvers: { ...approvers, leadDeputy: P('l') } })).toEqual({ error: 'no_eligible_approver', kind: 'PROCUREMENT_LEAD' });
  });
  it('eksik atamalar', () => {
    expect(planChain({ ...input, approvers: { ...approvers, head: null } })).toEqual({ error: 'department_head_missing', kind: 'DEPARTMENT_HEAD' });
    expect(planChain({ ...input, approvers: { ...approvers, lead: null } })).toEqual({ error: 'lead_missing', kind: 'PROCUREMENT_LEAD' });
    expect(planChain({ ...input, approvers: { ...approvers, director: null } })).toEqual({ error: 'director_missing', kind: 'PROCUREMENT_DIRECTOR' });
  });
  it('ek onaycılar sona, sırayla', () => {
    const r = planChain({ ...input, extras: ['x1', 'x2'] });
    expect('steps' in r && r.steps.slice(3)).toEqual([
      { order: 4, kind: 'EXTRA', userId: 'x1', viaDeputy: false },
      { order: 5, kind: 'EXTRA', userId: 'x2', viaDeputy: false },
    ]);
  });
  it('ekleyen ek onaycı olamaz', () => {
    expect(planChain({ ...input, extras: ['c'] })).toEqual({ error: 'no_eligible_approver', kind: 'EXTRA' });
  });
  it('aynı kişi birden çok adımda olabilir', () => {
    const r = planChain({ ...input, approvers: { ...approvers, lead: P('d') } });
    expect('steps' in r && r.steps.map((s) => s.userId)).toEqual(['h', 'd', 'd']);
  });
});

describe('canDecide', () => {
  const step = { userId: 'u1', decidedAt: null };
  it('atanan kişi', () => expect(canDecide(step, 'u1', null)).toBe(true));
  it('aktif vekil', () => expect(canDecide(step, 'v1', 'v1')).toBe(true));
  it('başkası', () => expect(canDecide(step, 'x', 'v1')).toBe(false));
  it('null vekil kimsenin yerine geçmez', () => expect(canDecide(step, 'x', null)).toBe(false));
  it('karar verilmiş adım', () => expect(canDecide({ userId: 'u1', decidedAt: '2026-11-17T10:00:00Z' }, 'u1', null)).toBe(false));
});

describe('reminderDates', () => {
  const base = { endDate: '2028-12-31', indefinite: false, autoRenewal: false, noticeDeadline: null, offsets: [90, 60, 30, 7] };
  it('Figma örneği', () => {
    expect(reminderDates(base)).toEqual([
      { offset: 90, date: '2028-10-02', kind: 'END', includeProcurement: false },
      { offset: 60, date: '2028-11-01', kind: 'END', includeProcurement: false },
      { offset: 30, date: '2028-12-01', kind: 'END', includeProcurement: true },
      { offset: 7, date: '2028-12-24', kind: 'END', includeProcurement: true },
    ]);
  });
  it('otomatik yenilemede ihbar-30 eklenir', () => {
    const r = reminderDates({ ...base, autoRenewal: true, noticeDeadline: '2028-09-30' });
    expect(r[0]).toEqual({ offset: 30, date: '2028-08-31', kind: 'NOTICE', includeProcurement: true });
    expect(r).toHaveLength(5);
  });
  it('süresizde yalnız ihbar', () => {
    expect(reminderDates({ ...base, endDate: null, indefinite: true, noticeDeadline: '2028-09-30' }).map((x) => x.kind)).toEqual(['NOTICE']);
    expect(reminderDates({ ...base, endDate: null, indefinite: true })).toEqual([]);
  });
  it('özel offsetler', () => {
    expect(reminderDates({ ...base, offsets: [14] })).toEqual([{ offset: 14, date: '2028-12-17', kind: 'END', includeProcurement: false }]);
  });
  it('yıl/artık yıl sınırı', () => {
    expect(reminderDates({ ...base, endDate: '2028-03-01', offsets: [1] })[0]?.date).toBe('2028-02-29');
  });
  it('geçmiş tarih: yalnız en yakın geçmiş olan bugüne çekilir', () => {
    const r = reminderDates({ ...base, endDate: '2026-12-10', today: '2026-11-17' });
    // 90->2026-09-11, 60->2026-10-11 (geçmiş), 30->2026-11-10 (geçmiş), 7->2026-12-03 (gelecek)
    expect(r).toEqual([
      { offset: 30, date: '2026-11-17', kind: 'END', includeProcurement: true },
      { offset: 7, date: '2026-12-03', kind: 'END', includeProcurement: true },
    ]);
  });
  it('bugüne taşınan ile bugünkü çakışırsa tek kalır', () => {
    const r = reminderDates({ ...base, endDate: '2026-12-17', offsets: [31, 30], today: '2026-11-17' });
    expect(r).toEqual([{ offset: 30, date: '2026-11-17', kind: 'END', includeProcurement: true }]);
  });
  it('END + NOTICE karışık, bazıları geçmiş', () => {
    const r = reminderDates({ endDate: '2027-01-31', indefinite: false, autoRenewal: true, noticeDeadline: '2026-12-31', offsets: [90, 30, 7], today: '2026-11-17' });
    // END: 90->2026-11-02 (geçmiş), 30->2027-01-01, 7->2027-01-24; NOTICE: 2026-12-01
    expect(r).toEqual([
      { offset: 90, date: '2026-11-17', kind: 'END', includeProcurement: false },
      { offset: 30, date: '2026-12-01', kind: 'NOTICE', includeProcurement: true },
      { offset: 30, date: '2027-01-01', kind: 'END', includeProcurement: true },
      { offset: 7, date: '2027-01-24', kind: 'END', includeProcurement: true },
    ]);
  });
  it('süresi dolmuş sözleşmeye hatırlatıcı planlanmaz (D108 I1)', () => {
    expect(reminderDates({ ...base, endDate: '2024-01-01', today: '2026-11-17' })).toEqual([]);
    expect(reminderDates({ ...base, endDate: '2026-11-16', today: '2026-11-17' })).toEqual([]);
  });
  it('bitiş bugünse en yakın geçmiş bugüne taşınır', () => {
    expect(reminderDates({ ...base, endDate: '2026-11-17', today: '2026-11-17' })).toEqual([
      { offset: 7, date: '2026-11-17', kind: 'END', includeProcurement: true },
    ]);
  });
  it('ihbar son günü geçmişse ihbar düşer, bitiş hatırlatıcıları kalır', () => {
    const r = reminderDates({ endDate: '2027-06-30', indefinite: false, autoRenewal: true, noticeDeadline: '2026-11-10', offsets: [30], today: '2026-11-17' });
    expect(r).toEqual([{ offset: 30, date: '2027-05-31', kind: 'END', includeProcurement: true }]);
  });
  it('süresizde ihbar son günü geçmişse hiçbir şey yok', () => {
    expect(reminderDates({ ...base, endDate: null, indefinite: true, noticeDeadline: '2026-01-01', today: '2026-11-17' })).toEqual([]);
  });
  it('bugünkü tarih geçmiş sayılmaz', () => {
    const r = reminderDates({ ...base, endDate: '2026-12-17', offsets: [30], today: '2026-11-17' });
    expect(r).toEqual([{ offset: 30, date: '2026-11-17', kind: 'END', includeProcurement: true }]);
  });
});

describe('izinler', () => {
  it('v2 Faz 3 izinleri', () => {
    expect(can(['DEPARTMENT_USER'], 'contract.approve')).toBe(true);
    expect(can(['ADMIN'], 'contract.approve')).toBe(false);
    expect(can(['AUDITOR'], 'template.read')).toBe(true);
    expect(can(['DEPARTMENT_USER'], 'template.manage')).toBe(false);
    expect(can(['ADMIN'], 'template.manage')).toBe(true);
    expect(can(['ADMIN'], 'reminder.settings')).toBe(true);
    expect(can(['PROCUREMENT'], 'reminder.settings')).toBe(false);
    expect(can(['DEPARTMENT_USER'], 'supplier.candidate.create')).toBe(true);
    expect(can(['AUDITOR'], 'supplier.candidate.create')).toBe(false);
  });
});

describe('planChain excludedIds (görev ayrılığı: gönderen de ekleyen sayılır)', () => {
  const P = (id: string) => ({ id });
  const approvers = { head: P('h'), deputy: P('hd'), lead: P('l'), leadDeputy: P('ld'), director: P('d'), directorDeputy: P('dd') };
  const input = { creatorId: 'c', approvers, useDeputyForHead: false, extras: [] as string[] };
  it('gönderen satınalma sorumlusuysa o adım vekile gider', () => {
    const r = planChain({ ...input, excludedIds: ['l'] });
    expect('steps' in r && r.steps[1]).toEqual({ order: 2, kind: 'PROCUREMENT_LEAD', userId: 'ld', viaDeputy: true });
  });
  it('vekil de dışlanmışsa no_eligible_approver', () => {
    expect(planChain({ ...input, excludedIds: ['d', 'dd'] })).toEqual({ error: 'no_eligible_approver', kind: 'PROCUREMENT_DIRECTOR' });
  });
  it('dışlanan kişi ek onaycı olamaz; boş liste eski davranış', () => {
    expect(planChain({ ...input, excludedIds: ['x'], extras: ['x'] })).toEqual({ error: 'no_eligible_approver', kind: 'EXTRA' });
    expect(planChain({ ...input, excludedIds: [] })).toEqual(planChain(input));
  });
});
