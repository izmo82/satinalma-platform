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
  'audit.read': ['AUDITOR', 'TENANT_ADMIN'],
  'task.read': ROLES.filter((r) => r !== 'SUPPLIER' && r !== 'PLATFORM_OPS'),
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(roles: readonly string[], permission: Permission): boolean {
  const allowed: readonly string[] = PERMISSIONS[permission];
  return roles.some((r) => allowed.includes(r));
}
