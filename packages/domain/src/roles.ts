// Rol ve izin eşlemesi. UI gizlemesi yetki değildir; API her işlemde bu tabloyu kullanır.
export const ROLES = [
  'REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'TECH_EVALUATOR', 'LEGAL', 'FINANCE',
  'SECURITY', 'MASTER_DATA', 'SUPPLIER', 'TENANT_ADMIN', 'PLATFORM_OPS', 'AUDITOR',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  'document.upload': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'LEGAL', 'FINANCE', 'MASTER_DATA'],
  'document.read': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'TECH_EVALUATOR', 'LEGAL', 'FINANCE', 'SECURITY', 'MASTER_DATA', 'AUDITOR'],
  'supplier.read': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'TECH_EVALUATOR', 'LEGAL', 'FINANCE', 'SECURITY', 'MASTER_DATA', 'AUDITOR'],
  'supplier.approve': ['MASTER_DATA', 'SECURITY', 'FINANCE'],
  'supplier.activate': ['MASTER_DATA'],
  'supplier.identity.resolve': ['MASTER_DATA'],
  'bank.change.decide': ['MASTER_DATA', 'FINANCE'],
  'contract.manage': ['BUYER', 'PROCUREMENT_MANAGER', 'LEGAL'],
  'contract.read': ['BUYER', 'PROCUREMENT_MANAGER', 'LEGAL', 'FINANCE', 'AUDITOR'],
  'signature.requirement.define': ['LEGAL', 'PROCUREMENT_MANAGER'],
  'signature.review': ['LEGAL', 'BUYER', 'PROCUREMENT_MANAGER'],
  'signature.analyze': ['LEGAL', 'BUYER', 'PROCUREMENT_MANAGER'],
  'signature.custody.record': ['LEGAL'],
  'signature.exception.request': ['LEGAL', 'BUYER', 'PROCUREMENT_MANAGER'],
  'signature.exception.decide': ['LEGAL'],
  'signature.finalize': ['LEGAL'],
  'project.read': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'TECH_EVALUATOR', 'FINANCE', 'SECURITY', 'AUDITOR'],
  'project.manage': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER'],
  'project.publish.approve': ['PROCUREMENT_MANAGER'],
  'rfq.answer': ['BUYER', 'PROCUREMENT_MANAGER'],
  'bid.submit': ['SUPPLIER'],
  'bid.score': ['TECH_EVALUATOR', 'BUYER', 'PROCUREMENT_MANAGER', 'SECURITY'],
  'evaluation.create': ['BUYER', 'PROCUREMENT_MANAGER'],
  'award.propose': ['BUYER', 'PROCUREMENT_MANAGER'],
  'award.decide': ['PROCUREMENT_MANAGER'],
  // Onay motoru: adım rolü kodda doğrulanır; bu izin karar ucuna erişimi açar. Politika yönetimi ve yayını ayrı kişiler.
  'approval.decide': ['PROCUREMENT_MANAGER', 'FINANCE', 'LEGAL', 'SECURITY'],
  'approval.policy.manage': ['PROCUREMENT_MANAGER', 'TENANT_ADMIN'],
  'sourcing.exception.request': ['BUYER', 'PROCUREMENT_MANAGER', 'REQUESTER'],
  'savings.approve': ['PROCUREMENT_MANAGER', 'FINANCE'],
  'performance.weights.manage': ['PROCUREMENT_MANAGER'],
  'portal.assessment': ['SUPPLIER'],
  'contract.terms.edit': ['BUYER', 'PROCUREMENT_MANAGER', 'LEGAL'],
  'contract.terms.verify': ['LEGAL'],
  'contract.obligation.manage': ['BUYER', 'PROCUREMENT_MANAGER', 'LEGAL'],
  'contract.obligation.record': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'LEGAL', 'FINANCE', 'SECURITY'],
  'contract.renewal.decide': ['PROCUREMENT_MANAGER'],
  // Faz 3: fiyat revizyonu ve SLA kredisi önerilir, ikinci kişi onaylar (öneren onaylayamaz); teminat finans/hukuk kaydı.
  'contract.commercial.propose': ['BUYER', 'PROCUREMENT_MANAGER', 'LEGAL', 'FINANCE'],
  'contract.commercial.approve': ['PROCUREMENT_MANAGER', 'LEGAL', 'FINANCE'],
  'contract.guarantee.manage': ['FINANCE', 'LEGAL', 'PROCUREMENT_MANAGER'],
  'holiday.manage': ['LEGAL', 'TENANT_ADMIN'],
  'po.read': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'FINANCE', 'AUDITOR'],
  'po.manage': ['BUYER', 'PROCUREMENT_MANAGER'],
  'receipt.record': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER'],
  'invoice.read': ['BUYER', 'PROCUREMENT_MANAGER', 'FINANCE', 'LEGAL', 'AUDITOR'],
  'invoice.manage': ['FINANCE'],
  'invoice.exception.approve': ['PROCUREMENT_MANAGER'],
  'invoice.approve': ['FINANCE'],
  'integration.ingest': ['FINANCE'],
  'tolerance.manage': ['FINANCE'],
  // Faz 5: tedarikçi değerlendirmesi, olay, performans, raporlar ve AI yönetişimi.
  'questionnaire.manage': ['SECURITY', 'PROCUREMENT_MANAGER'],
  'assessment.read': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'TECH_EVALUATOR', 'LEGAL', 'FINANCE', 'SECURITY', 'MASTER_DATA', 'AUDITOR'],
  'assessment.manage': ['BUYER', 'PROCUREMENT_MANAGER', 'SECURITY', 'MASTER_DATA'],
  'assessment.review': ['SECURITY', 'PROCUREMENT_MANAGER'],
  'risk.accept': ['SECURITY', 'PROCUREMENT_MANAGER'],
  'incident.report': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'TECH_EVALUATOR', 'LEGAL', 'FINANCE', 'SECURITY', 'MASTER_DATA'],
  'incident.verify': ['PROCUREMENT_MANAGER', 'SECURITY', 'LEGAL'],
  'incident.read': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'TECH_EVALUATOR', 'LEGAL', 'FINANCE', 'SECURITY', 'MASTER_DATA', 'AUDITOR'],
  'corrective.complete': ['REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'TECH_EVALUATOR', 'LEGAL', 'FINANCE', 'SECURITY', 'MASTER_DATA'],
  'performance.review': ['BUYER', 'PROCUREMENT_MANAGER'],
  'report.read': ['BUYER', 'PROCUREMENT_MANAGER', 'FINANCE', 'AUDITOR'],
  'ai.read': ['TENANT_ADMIN', 'AUDITOR', 'PROCUREMENT_MANAGER'],
  'ai.policy.manage': ['TENANT_ADMIN'],
  'audit.read': ['AUDITOR', 'TENANT_ADMIN'],
  // Faz 7: saklama, hukuki saklama, imha ve kiracı dışa aktarımı (T48). Kiracı yöneticisi tüm belgelere kendiliğinden erişmez:
  // dışa aktarım ve imha ikinci bir kişinin (hukuk) onayıyla yürür; öneren onaylayamaz.
  'retention.read': ['LEGAL', 'TENANT_ADMIN', 'AUDITOR'],
  'retention.manage': ['LEGAL'],
  'legal_hold.manage': ['LEGAL'],
  'disposal.propose': ['LEGAL', 'TENANT_ADMIN'],
  'disposal.approve': ['LEGAL'],
  'tenant.export.request': ['TENANT_ADMIN'],
  'tenant.export.approve': ['LEGAL'],
  // ERP mutabakatı ve yetkili tekrar gönderim.
  'integration.reconcile': ['FINANCE', 'AUDITOR'],
  'integration.replay': ['FINANCE'],
  // Lira Defteri (D80): bulgular kuralla hesaplanır; talep ve kapatma satınalma/finans, tahsil kaydı yalnız finans.
  'recovery.read': ['BUYER', 'PROCUREMENT_MANAGER', 'FINANCE', 'LEGAL', 'AUDITOR'],
  'recovery.manage': ['BUYER', 'PROCUREMENT_MANAGER', 'FINANCE'],
  'recovery.settle': ['FINANCE'],
  'recovery.settings': ['FINANCE'],
  'task.read': ROLES.filter((r) => r !== 'SUPPLIER' && r !== 'PLATFORM_OPS'),
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(roles: readonly string[], permission: Permission): boolean {
  const allowed: readonly string[] = PERMISSIONS[permission];
  return roles.some((r) => allowed.includes(r));
}
