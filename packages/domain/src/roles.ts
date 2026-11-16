// Rol ve izin eşlemesi. UI gizlemesi yetki değildir; API her işlemde bu tabloyu kullanır.
// v2 (D93/D95): 12 rol 5 role indi. Roller yalnız bu izin tablosunda kullanılır (SQL/RLS'de değil).
// Eşleme (eski -> v2):
//   TENANT_ADMIN, PLATFORM_OPS -> ADMIN
//   BUYER, PROCUREMENT_MANAGER, MASTER_DATA, LEGAL, FINANCE -> PROCUREMENT
//   REQUESTER, TECH_EVALUATOR, SECURITY -> DEPARTMENT_USER
//   SUPPLIER -> SUPPLIER, AUDITOR -> AUDITOR
export const V2_ROLES = ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'SUPPLIER', 'AUDITOR'] as const;
export type Role = (typeof V2_ROLES)[number];
// Eski içe aktarmalar için takma ad.
export const ROLES = V2_ROLES;

export const LEGACY_ROLE_MAP: Record<string, Role> = {
  TENANT_ADMIN: 'ADMIN', PLATFORM_OPS: 'ADMIN',
  BUYER: 'PROCUREMENT', PROCUREMENT_MANAGER: 'PROCUREMENT', MASTER_DATA: 'PROCUREMENT', LEGAL: 'PROCUREMENT', FINANCE: 'PROCUREMENT',
  REQUESTER: 'DEPARTMENT_USER', TECH_EVALUATOR: 'DEPARTMENT_USER', SECURITY: 'DEPARTMENT_USER',
  SUPPLIER: 'SUPPLIER', AUDITOR: 'AUDITOR',
};

// Saklanan rol kodlarını (eski ya da v2) tekilleştirilmiş v2 rollerine çevirir; bilinmeyen kod düşer.
export function normalizeRoles(stored: readonly string[]): Role[] {
  const out = new Set<Role>();
  for (const r of stored) {
    const v2 = (V2_ROLES as readonly string[]).includes(r) ? (r as Role) : LEGACY_ROLE_MAP[r];
    if (v2) out.add(v2);
  }
  return [...out];
}

// Bölüm kapsamı olmadan tüm bölümleri gören roller.
export const SEES_ALL_DEPARTMENTS: readonly Role[] = ['ADMIN', 'PROCUREMENT', 'AUDITOR'];

// v2'de kaldırılan izinler: tabloda boş listeyle durur (çağıranlar derlenir), hiçbir rol kullanamaz.
export const REMOVED_PERMISSIONS: readonly string[] = [
  'approval.policy.manage',
  'bank.change.decide',
  'po.read',
  'po.manage',
  'receipt.record',
  'invoice.approve',
  'invoice.exception.approve',
  'tolerance.manage',
  'recovery.read',
  'recovery.manage',
  'recovery.settle',
  'recovery.settings',
  'retention.read',
  'retention.manage',
  'legal_hold.manage',
  'disposal.propose',
  'disposal.approve',
];

export const PERMISSIONS = {
  'document.upload': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'document.read': ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR'],
  'supplier.read': ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR'],
  'supplier.approve': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'supplier.activate': ['PROCUREMENT'],
  'supplier.identity.resolve': ['PROCUREMENT'],
  'bank.change.decide': [],
  // Bölüm kullanıcısı da sözleşme açar/düzenler (D93 brief: korunan işlev).
  'contract.manage': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'contract.read': ['ADMIN', 'PROCUREMENT', 'AUDITOR'],
  'signature.requirement.define': ['PROCUREMENT'],
  'signature.review': ['PROCUREMENT'],
  'signature.analyze': ['PROCUREMENT'],
  'signature.custody.record': ['PROCUREMENT'],
  'signature.exception.request': ['PROCUREMENT'],
  'signature.exception.decide': ['PROCUREMENT'],
  'signature.finalize': ['PROCUREMENT'],
  'project.read': ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR'],
  'project.manage': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'project.publish.approve': ['PROCUREMENT'],
  'rfq.answer': ['PROCUREMENT'],
  'bid.submit': ['SUPPLIER'],
  'bid.score': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'evaluation.create': ['PROCUREMENT'],
  'award.propose': ['PROCUREMENT'],
  'award.decide': ['PROCUREMENT'],
  // Onay motoru: adım rolü kodda doğrulanır; bu izin karar ucuna erişimi açar. Politika yönetimi ve yayını ayrı kişiler.
  'approval.decide': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'approval.policy.manage': [],
  'sourcing.exception.request': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'savings.approve': ['PROCUREMENT'],
  'performance.weights.manage': ['PROCUREMENT'],
  'portal.assessment': ['SUPPLIER'],
  'contract.terms.edit': ['PROCUREMENT'],
  'contract.terms.verify': ['PROCUREMENT'],
  'contract.obligation.manage': ['PROCUREMENT'],
  'contract.obligation.record': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'contract.renewal.decide': ['PROCUREMENT'],
  // Faz 3: fiyat revizyonu ve SLA kredisi önerilir, ikinci kişi onaylar (öneren onaylayamaz); teminat finans/hukuk kaydı.
  'contract.commercial.propose': ['PROCUREMENT'],
  'contract.commercial.approve': ['PROCUREMENT'],
  'contract.guarantee.manage': ['PROCUREMENT'],
  'holiday.manage': ['ADMIN', 'PROCUREMENT'],
  'po.read': [],
  'po.manage': [],
  'receipt.record': [],
  'invoice.read': ['ADMIN', 'PROCUREMENT', 'AUDITOR'],
  'invoice.manage': ['PROCUREMENT'],
  'invoice.exception.approve': [],
  'invoice.approve': [],
  'integration.ingest': ['PROCUREMENT'],
  'tolerance.manage': [],
  // Faz 5: tedarikçi değerlendirmesi, olay, performans, raporlar ve AI yönetişimi.
  'questionnaire.manage': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'assessment.read': ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR'],
  'assessment.manage': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'assessment.review': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'risk.accept': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'incident.report': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'incident.verify': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'incident.read': ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR'],
  'corrective.complete': ['PROCUREMENT', 'DEPARTMENT_USER'],
  'performance.review': ['PROCUREMENT'],
  'report.read': ['ADMIN', 'PROCUREMENT', 'AUDITOR'],
  'ai.read': ['ADMIN', 'PROCUREMENT', 'AUDITOR'],
  'ai.policy.manage': ['ADMIN'],
  'audit.read': ['ADMIN', 'AUDITOR'],
  // Faz 7: saklama, hukuki saklama, imha ve kiracı dışa aktarımı (T48). Kiracı yöneticisi tüm belgelere kendiliğinden erişmez:
  // dışa aktarım ve imha ikinci bir kişinin (hukuk) onayıyla yürür; öneren onaylayamaz.
  'retention.read': [],
  'retention.manage': [],
  'legal_hold.manage': [],
  'disposal.propose': [],
  'disposal.approve': [],
  'tenant.export.request': ['ADMIN'],
  'tenant.export.approve': ['PROCUREMENT'],
  // ERP mutabakatı ve yetkili tekrar gönderim.
  'integration.reconcile': ['PROCUREMENT', 'AUDITOR'],
  'integration.replay': ['PROCUREMENT'],
  // Lira Defteri (D80): bulgular kuralla hesaplanır; talep ve kapatma satınalma/finans, tahsil kaydı yalnız finans.
  'recovery.read': [],
  'recovery.manage': [],
  'recovery.settle': [],
  'recovery.settings': [],
  'task.read': ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR'],
  // v2 (D93): departman listesi iç rollere açık; departman tanımı ve üyelik departmanı ataması yalnız Yönetici.
  'department.read': ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR'],
  'department.manage': ['ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

// Eski rol kodlarıyla gelen çağrılar da çalışsın diye girdi önce v2'ye normalize edilir.
export function can(roles: readonly string[], permission: Permission): boolean {
  const allowed: readonly string[] = PERMISSIONS[permission];
  return normalizeRoles(roles).some((r) => allowed.includes(r));
}
