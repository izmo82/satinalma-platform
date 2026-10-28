import { describe, expect, it } from 'vitest';
import { approvalProgress, planApproval, validatePolicy, type ApprovalPolicy, type ApprovalRule } from '../src/approvalPolicy.ts';

const PM = { role: 'PROCUREMENT_MANAGER', label: 'Satınalma yöneticisi' };
const FIN = { role: 'FINANCE', label: 'Finans' };
const rule = (o: Partial<ApprovalRule>): ApprovalRule => ({ id: 'R', action: 'AWARD', currency: 'TRY', minAmount: '0', maxAmount: null, steps: [PM], ...o });
const policy: ApprovalPolicy = { version: 3, rules: [
  rule({ id: 'A1', maxAmount: '1000000' }),
  rule({ id: 'A2', minAmount: '1000000', steps: [PM, FIN] }),
  rule({ id: 'A3', category: 'BT donanımı', minAmount: '0', steps: [{ role: 'SECURITY', label: 'Bilgi güvenliği' }, PM] }),
  rule({ id: 'P1', action: 'RFQ_PUBLISH', minInvitees: 3, minResponseDays: 7 }),
] };

describe('onay planı', () => {
  it('tutar aralığı ve en özel kapsam seçilir; açıklama sürüm, kural ve adımları söyler', () => {
    expect(planApproval(policy, { action: 'AWARD', companyId: 'C1', category: 'Temizlik', currency: 'TRY', amount: '999999.99' }).ruleId).toBe('A1');
    const big = planApproval(policy, { action: 'AWARD', companyId: 'C1', category: 'Temizlik', currency: 'TRY', amount: '1000000' });
    expect(big.ruleId).toBe('A2');
    expect(big.steps.map((s) => s.role)).toEqual(['PROCUREMENT_MANAGER', 'FINANCE']);
    expect(big.explanation).toContain('Politika v3, kural A2');
    expect(planApproval(policy, { action: 'AWARD', companyId: 'C1', category: ' bt DONANIMI ', currency: 'TRY', amount: '5' }).ruleId).toBe('A3');
  });
  it('inceleme: büyük tutar için özel kural, küçük tutarda genel kuralı ortadan kaldırmaz', () => {
    const pol: ApprovalPolicy = { version: 1, rules: [
      rule({ id: 'GENEL', action: 'RFQ_PUBLISH', steps: [PM, FIN], minInvitees: 3 }),
      rule({ id: 'C1-BUYUK', action: 'RFQ_PUBLISH', companyId: 'C1', minAmount: '1000000', steps: [PM, FIN, { role: 'LEGAL', label: 'Hukuk' }] }),
    ] };
    expect(planApproval(pol, { action: 'RFQ_PUBLISH', companyId: 'C1', category: null, currency: 'TRY', amount: '500000' })).toMatchObject({ ruleId: 'GENEL', minInvitees: 3 });
    expect(planApproval(pol, { action: 'RFQ_PUBLISH', companyId: 'C1', category: null, currency: 'TRY', amount: '2000000' }).ruleId).toBe('C1-BUYUK');
  });

  it('kural yoksa veya politika yoksa varsayılan tek adım; tutar yoksa kapsamın en sıkı kuralı', () => {
    expect(planApproval(policy, { action: 'AWARD', companyId: 'C1', category: null, currency: 'EUR', amount: '5' })).toMatchObject({ ruleId: null, steps: [PM] });
    expect(planApproval(null, { action: 'RFQ_PUBLISH', companyId: 'C1', category: null, currency: 'TRY', amount: null }).explanation).toContain('Yayınlanmış politika yok');
    const unknown = planApproval(policy, { action: 'AWARD', companyId: 'C1', category: null, currency: 'TRY', amount: null });
    expect(unknown.ruleId).toBe('A2');
    expect(unknown.explanation).toContain('en sıkı');
    expect(planApproval(policy, { action: 'RFQ_PUBLISH', companyId: 'C1', category: null, currency: 'TRY', amount: '10' })).toMatchObject({ minInvitees: 3, minResponseDays: 7 });
  });
  it('aynı kapsamda çakışan aralık reddedilir; geçersiz kural reddedilir', () => {
    expect(validatePolicy(policy.rules)).toBeNull();
    expect(validatePolicy([rule({ id: 'X', maxAmount: '100' }), rule({ id: 'Y', minAmount: '50' })])).toContain('çakışan');
    expect(validatePolicy([rule({ id: 'X', maxAmount: '100' }), rule({ id: 'Y', minAmount: '100' })])).toBeNull();
    expect(validatePolicy([rule({ id: 'X', steps: [] })])).toContain('1–6');
    expect(validatePolicy([rule({ id: 'X', minInvitees: 3 })])).toContain('yalnız yayın');
  });
});

describe('ardışık adım ilerlemesi', () => {
  it('sıradaki adım rolü ister; talep eden ve önceki adımı onaylayan karar veremez; ret süreci bitirir', () => {
    const steps = [PM, FIN];
    let p = approvalProgress(steps, [], 'u0');
    expect(p.nextStepNo).toBe(1);
    expect(p.canDecide('u0', ['PROCUREMENT_MANAGER']).ok).toBe(false);
    expect(p.canDecide('u1', ['FINANCE']).reason).toContain('Satınalma yöneticisi');
    expect(p.canDecide('u1', ['PROCUREMENT_MANAGER']).ok).toBe(true);
    p = approvalProgress(steps, [{ stepNo: 1, decidedBy: 'u1', decision: 'APPROVE' }], 'u0');
    expect(p.nextStep).toEqual(FIN);
    expect(p.canDecide('u1', ['FINANCE', 'PROCUREMENT_MANAGER']).reason).toContain('Önceki');
    expect(p.canDecide('u2', ['FINANCE']).ok).toBe(true);
    expect(approvalProgress(steps, [{ stepNo: 1, decidedBy: 'u1', decision: 'APPROVE' }, { stepNo: 2, decidedBy: 'u2', decision: 'APPROVE' }], 'u0').done).toBe(true);
    const rej = approvalProgress(steps, [{ stepNo: 1, decidedBy: 'u1', decision: 'REJECT' }], 'u0');
    expect([rej.rejected, rej.done, rej.nextStep]).toEqual([true, false, null]);
  });
});
