import { describe, expect, it } from 'vitest';
import { holdCovers, retentionVerdict, type LegalHold } from '../src/retention.ts';
import { addMonths } from '../src/contractTerms.ts';
import { reconcileErpResult, type ErpExpected } from '../src/erpReconcile.ts';

const doc = { id: 'd1', companyId: 'c1', kind: 'INVOICE', lastVersionAt: '2016-01-31T10:00:00Z', disposed: false };
const policy = [{ documentKind: 'INVOICE', retentionMonths: 120 }];

describe('saklama ve hukuki saklama (T48)', () => {
  it('politika yoksa belge süresiz saklanır; tek evrensel süre yok', () => {
    expect(retentionVerdict({ ...doc, kind: 'CONTRACT' }, policy, [], '2030-01-01')).toEqual({ eligible: false, reason: 'NO_POLICY', dueOn: null });
  });
  it('süre son sürüm tarihinden işler; vade günü dahil değildir', () => {
    expect(retentionVerdict(doc, policy, [], '2026-01-31')).toEqual({ eligible: false, reason: 'NOT_DUE', dueOn: '2026-01-31' });
    expect(retentionVerdict(doc, policy, [], '2026-02-01')).toEqual({ eligible: true, dueOn: '2026-01-31' });
  });
  it('ay sonu taşması ayın son gününe çekilir', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2023-01-31', 1)).toBe('2023-02-28');
    expect(addMonths('2023-11-15', 3)).toBe('2024-02-15');
  });
  it('hukuki saklama süresi dolmuş belgeyi de korur; kaldırılınca etkisi biter', () => {
    const holds: LegalHold[] = [{ scope: 'COMPANY', companyId: 'c1', documentId: null, releasedAt: null }];
    expect(retentionVerdict(doc, policy, holds, '2027-01-01')).toMatchObject({ eligible: false, reason: 'LEGAL_HOLD' });
    expect(retentionVerdict(doc, policy, [{ ...holds[0]!, releasedAt: '2026-12-01T00:00:00Z' }], '2027-01-01').eligible).toBe(true);
    expect(holdCovers({ scope: 'TENANT', companyId: null, documentId: null, releasedAt: null }, doc)).toBe(true);
    expect(holdCovers({ scope: 'COMPANY', companyId: 'c2', documentId: null, releasedAt: null }, doc)).toBe(false);
    expect(holdCovers({ scope: 'DOCUMENT', companyId: null, documentId: 'd1', releasedAt: null }, doc)).toBe(true);
    expect(holdCovers({ scope: 'DOCUMENT', companyId: null, documentId: 'd2', releasedAt: null }, doc)).toBe(false);
  });
  it('imha edilmiş belge tekrar aday olmaz', () => {
    expect(retentionVerdict({ ...doc, disposed: true }, policy, [], '2030-01-01')).toMatchObject({ eligible: false, reason: 'ALREADY_DISPOSED' });
  });
});

describe('ERP sonuç dosyası mutabakatı', () => {
  const expected: ErpExpected[] = [
    { idempotencyKey: 'k1', invoiceNo: 'F1', payable: '1200.00', currentStatus: 'NOT_CONFIGURED', externalId: null },
    { idempotencyKey: 'k2', invoiceNo: 'F2', payable: '500.00', currentStatus: 'NOT_CONFIGURED', externalId: null },
    { idempotencyKey: 'k3', invoiceNo: 'F3', payable: '10.00', currentStatus: 'CONFIRMED', externalId: 'E3' },
    { idempotencyKey: 'k4', invoiceNo: 'F4', payable: '99.99', currentStatus: 'FAILED', externalId: null },
  ];
  const row = (line: number, idempotencyKey: string, payable: string, status = 'OK', externalId = `E${line}`, message = '') =>
    ({ line, idempotencyKey, externalId, status, payable, message });

  it('her satır sınıflandırılır; hata sayısı ve toplamlar ayrı raporlanır', () => {
    const r = reconcileErpResult([
      row(1, 'k1', '1200,00'),          // virgüllü tutar kabul
      row(2, 'k2', '499.00'),           // tutar farkı
      row(3, 'k3', '10.00', 'OK', 'E3'), // aynı dosya ikinci kez
      row(4, 'k1', '1200.00'),          // dosyada mükerrer
      row(5, 'zz', '1.00'),             // bilinmeyen anahtar
      row(6, 'k4', '99.99', 'ERROR', '', 'Cari kart yok'),
      row(7, '', 'abc'),
    ], expected);
    expect(r.rows.map((x) => x.outcome)).toEqual(['MATCHED', 'AMOUNT_MISMATCH', 'ALREADY_CONFIRMED', 'DUPLICATE_ROW', 'UNKNOWN_KEY', 'ERP_REJECTED', 'INVALID_ROW']);
    expect(r.counts.MATCHED).toBe(1);
    expect(r.matchedTotal).toBe('1200.00');
    expect(r.fileTotal).toBe('1809.99'); // 1200 + 499 + 10 + 1 + 99.99; mükerrer ve geçersiz satır toplama girmez
    expect(r.missingFromFile).toEqual([]);
  });
  it('dosyada olmayan bekleyen aktarım listelenir; onaylı kayıt farklı dış kimlikle gelirse çakışma', () => {
    const r = reconcileErpResult([row(1, 'k3', '10.00', 'OK', 'BAŞKA')], expected);
    expect(r.rows[0]!.outcome).toBe('EXTERNAL_ID_CONFLICT');
    expect(r.missingFromFile.map((m) => m.invoiceNo)).toEqual(['F1', 'F2', 'F4']);
  });
});
