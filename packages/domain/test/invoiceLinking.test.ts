import { describe, expect, it } from 'vitest';
import { MATCH_METHOD_TR, MATCH_REASON_TR, MATCH_STATE_TR, contractUsage, matchInvoice, matchState, can } from '../src/index.js';

const C = (o: Partial<Parameters<typeof matchInvoice>[0]['contracts'][number]> = {}) => ({
  familyId: 'F1', code: 'SOZ-001', contractNo: 'SZ-2026-1', supplierRootId: 'S1', start: '2026-01-01', end: '2026-12-31',
  indefinite: false, status: 'APPROVED', projectId: 'P1', departmentId: 'D1', ...o,
});
const inv = (o = {}) => ({ supplierRootId: 'S1', issueDate: '2026-06-15', erpContractRef: null, erpOrderRef: null, ...o });

describe('matchInvoice (R2)', () => {
  it('sipariş referansı sözleşme ailesine bağlar', () => {
    const r = matchInvoice({ invoice: inv({ erpOrderRef: 'PO-9' }), contracts: [C()], orders: [{ code: 'PO-9', familyId: 'F1' }] });
    expect(r).toEqual({ method: 'ERP_REF', familyId: 'F1' });
  });
  it('sözleşme kodu ve sözleşme numarası referans olur', () => {
    expect(matchInvoice({ invoice: inv({ erpContractRef: 'SOZ-001' }), contracts: [C()], orders: [] })).toEqual({ method: 'ERP_REF', familyId: 'F1' });
    expect(matchInvoice({ invoice: inv({ erpContractRef: 'sz-2026-1' }), contracts: [C()], orders: [] })).toEqual({ method: 'ERP_REF', familyId: 'F1' });
  });
  it('referans başka tedarikçinin sözleşmesi ise eşleşmez', () => {
    const r = matchInvoice({ invoice: inv({ erpContractRef: 'SOZ-001' }), contracts: [C({ supplierRootId: 'S2' })], orders: [] });
    expect(r).toEqual({ method: 'UNMATCHED', reason: 'ref_supplier_mismatch' });
    const o = matchInvoice({ invoice: inv({ erpOrderRef: 'PO-9' }), contracts: [C({ supplierRootId: 'S2' })], orders: [{ code: 'PO-9', familyId: 'F1' }] });
    expect(o).toEqual({ method: 'UNMATCHED', reason: 'ref_supplier_mismatch' });
  });
  it('referans yoksa tek aktif sözleşme tedarikçi + tarihle eşleşir', () => {
    expect(matchInvoice({ invoice: inv(), contracts: [C()], orders: [] })).toEqual({ method: 'SUPPLIER_DATE', familyId: 'F1' });
  });
  it('iki aktif sözleşme belirsizdir', () => {
    const r = matchInvoice({ invoice: inv(), contracts: [C(), C({ familyId: 'F2', code: 'SOZ-002' })], orders: [] });
    expect(r).toEqual({ method: 'UNMATCHED', reason: 'multiple_active_contracts' });
  });
  it('aynı ailenin iki sürümü tek sayılır', () => {
    expect(matchInvoice({ invoice: inv(), contracts: [C(), C()], orders: [] })).toEqual({ method: 'SUPPLIER_DATE', familyId: 'F1' });
  });
  it('tarih aralığı dışı ve onaysız sözleşme sayılmaz; süresiz sayılır', () => {
    expect(matchInvoice({ invoice: inv({ issueDate: '2027-01-01' }), contracts: [C()], orders: [] })).toEqual({ method: 'UNMATCHED', reason: 'no_active_contract' });
    expect(matchInvoice({ invoice: inv({ issueDate: '2025-12-31' }), contracts: [C()], orders: [] })).toEqual({ method: 'UNMATCHED', reason: 'no_active_contract' });
    expect(matchInvoice({ invoice: inv(), contracts: [C({ status: 'IN_APPROVAL' })], orders: [] })).toEqual({ method: 'UNMATCHED', reason: 'no_active_contract' });
    expect(matchInvoice({ invoice: inv({ issueDate: '2030-01-01' }), contracts: [C({ end: null, indefinite: true })], orders: [] })).toEqual({ method: 'SUPPLIER_DATE', familyId: 'F1' });
    expect(matchInvoice({ invoice: inv({ issueDate: '2026-12-31' }), contracts: [C({ status: 'LEGACY' })], orders: [] })).toEqual({ method: 'SUPPLIER_DATE', familyId: 'F1' });
  });
  it('başka tedarikçinin sözleşmesi tarihle eşleşmez', () => {
    expect(matchInvoice({ invoice: inv(), contracts: [C({ supplierRootId: 'S2' })], orders: [] })).toEqual({ method: 'UNMATCHED', reason: 'no_active_contract' });
  });
  it('çözülemeyen referans tarih eşleşmesine düşmez: ref_not_found', () => {
    expect(matchInvoice({ invoice: inv({ erpContractRef: 'YOK' }), contracts: [C()], orders: [] })).toEqual({ method: 'UNMATCHED', reason: 'ref_not_found' });
    expect(matchInvoice({ invoice: inv({ erpOrderRef: 'PO-X' }), contracts: [C()], orders: [] })).toEqual({ method: 'UNMATCHED', reason: 'ref_not_found' });
    expect(matchInvoice({ invoice: inv({ erpOrderRef: 'PO-9' }), contracts: [C()], orders: [{ code: 'PO-9', familyId: null }] })).toEqual({ method: 'UNMATCHED', reason: 'ref_not_found' });
    expect(matchInvoice({ invoice: inv({ erpOrderRef: 'PO-9', erpContractRef: 'SOZ-001' }), contracts: [C()], orders: [] })).toEqual({ method: 'UNMATCHED', reason: 'ref_not_found' });
  });
  it('sipariş ve sözleşme referansı farklı aileleri gösterirse ref_conflict', () => {
    const r = matchInvoice({
      invoice: inv({ erpOrderRef: 'PO-9', erpContractRef: 'SOZ-002' }),
      contracts: [C(), C({ familyId: 'F2', code: 'SOZ-002', contractNo: null })], orders: [{ code: 'PO-9', familyId: 'F1' }],
    });
    expect(r).toEqual({ method: 'UNMATCHED', reason: 'ref_conflict' });
    expect(MATCH_REASON_TR.ref_conflict).toBeTruthy();
    const ok = matchInvoice({ invoice: inv({ erpOrderRef: 'PO-9', erpContractRef: 'SOZ-001' }), contracts: [C()], orders: [{ code: 'PO-9', familyId: 'F1' }] });
    expect(ok).toEqual({ method: 'ERP_REF', familyId: 'F1' });
  });
  it('Türkçe etiketler eksiksiz', () => {
    for (const k of ['ref_not_found', 'ref_conflict', 'ref_supplier_mismatch', 'no_active_contract', 'multiple_active_contracts'] as const) expect(MATCH_REASON_TR[k]).toBeTruthy();
    for (const k of ['ERP_REF', 'SUPPLIER_DATE', 'MANUAL'] as const) expect(MATCH_METHOD_TR[k]).toBeTruthy();
    expect(MATCH_STATE_TR.ALLOCATED).toBe('Tahsisle (eski kayıt)');
    expect(MATCH_STATE_TR.MATCHED).toBe('Eşleşti');
  });
});

describe('matchState (R1)', () => {
  it('saklı bağ MATCHED; bağ yok tek aileye tahsis ALLOCATED; çok aile MIXED; hiçbiri UNMATCHED', () => {
    expect(matchState({ familyId: 'F1', allocationFamilies: [] })).toBe('MATCHED');
    expect(matchState({ familyId: 'F1', allocationFamilies: ['F1', 'F2'] })).toBe('MATCHED');
    expect(matchState({ familyId: null, allocationFamilies: ['F1', 'F1'] })).toBe('ALLOCATED');
    expect(matchState({ familyId: null, allocationFamilies: ['F1', 'F2'] })).toBe('MIXED');
    expect(matchState({ familyId: null, allocationFamilies: [] })).toBe('UNMATCHED');
  });
});

describe('contractUsage (R4)', () => {
  const i = (net: string, tax = '0.00', kind = 'INVOICE', currency = 'TRY') => ({ kind, currency, net, tax });
  it('95000 / 100000 yakın', () => {
    const r = contractUsage({ amount: '100000.00', currency: 'TRY', basis: 'NET', invoices: [i('95000.00')] });
    expect(r).toMatchObject({ used: '95000.00', ratio: '0.9500', level: 'NEAR', overBy: null, foreignCurrency: [] });
  });
  it('105000 aşım ve overBy', () => {
    const r = contractUsage({ amount: '100000.00', currency: 'TRY', basis: 'NET', invoices: [i('105000.00')] });
    expect(r.level).toBe('OVER');
    expect(r.overBy).toBe('5000.00');
  });
  it('tam sınır aşım değil; altı OK', () => {
    expect(contractUsage({ amount: '100000', currency: 'TRY', basis: 'NET', invoices: [i('100000')] }).level).toBe('NEAR');
    expect(contractUsage({ amount: '100000', currency: 'TRY', basis: 'NET', invoices: [i('89999.99')] }).level).toBe('OK');
  });
  it('iade düşer', () => {
    const r = contractUsage({ amount: '100000', currency: 'TRY', basis: 'NET', invoices: [i('105000'), i('10000', '0', 'CREDIT_NOTE')] });
    expect(r.used).toBe('95000.00');
    expect(r.level).toBe('NEAR');
  });
  it('GROSS KDV katar, NET katmaz', () => {
    const invs = [i('90000', '18000')];
    expect(contractUsage({ amount: '100000', currency: 'TRY', basis: 'GROSS', invoices: invs }).level).toBe('OVER');
    expect(contractUsage({ amount: '100000', currency: 'TRY', basis: 'NET', invoices: invs }).used).toBe('90000.00');
  });
  it('yabancı para toplama girmez, ayrı listelenir', () => {
    const r = contractUsage({ amount: '100000', currency: 'TRY', basis: 'NET', invoices: [i('1000'), i('500', '0', 'INVOICE', 'USD'), i('250.50', '0', 'INVOICE', 'USD')] });
    expect(r.used).toBe('1000.00');
    expect(r.foreignCurrency).toEqual([{ currency: 'USD', total: '750.50' }]);
  });
  it('tutar yoksa NO_AMOUNT', () => {
    const r = contractUsage({ amount: null, currency: 'TRY', basis: 'NET', invoices: [i('10')] });
    expect(r).toMatchObject({ used: '10.00', ratio: null, level: 'NO_AMOUNT', overBy: null });
  });
});

describe('izinler (Faz 7)', () => {
  it('fatura eşleştirme ve tamamlama', () => {
    expect(can(['PROCUREMENT'], 'invoice.match')).toBe(true);
    expect(can(['DEPARTMENT_USER'], 'invoice.match')).toBe(true);
    expect(can(['AUDITOR'], 'invoice.match')).toBe(false);
    expect(can(['PROCUREMENT'], 'project.complete')).toBe(true);
    expect(can(['ADMIN'], 'project.complete')).toBe(false);
  });
  it('kural ve uyum izinleri', () => {
    expect(can(['ADMIN'], 'rule.manage')).toBe(true);
    expect(can(['PROCUREMENT'], 'rule.manage')).toBe(false);
    for (const r of ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR']) {
      expect(can([r], 'rule.read'), r).toBe(true);
      expect(can([r], 'compliance.read'), r).toBe(true);
    }
    expect(can(['AUDITOR'], 'compliance.run')).toBe(false);
    expect(can(['DEPARTMENT_USER'], 'compliance.run')).toBe(false);
    expect(can(['ADMIN'], 'compliance.run')).toBe(true);
    expect(can(['PROCUREMENT'], 'compliance.mark')).toBe(true);
    expect(can(['ADMIN'], 'compliance.mark')).toBe(false);
    expect(can(['PROCUREMENT'], 'coi.declare')).toBe(true);
    expect(can(['DEPARTMENT_USER'], 'coi.declare')).toBe(true);
    expect(can(['AUDITOR'], 'coi.declare')).toBe(false);
  });
});
