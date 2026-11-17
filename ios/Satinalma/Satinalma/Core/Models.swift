import Foundation

// API yanıt modelleri (web ile aynı sözleşme). Para ve miktar sunucudan ondalık metin olarak gelir; Double'a çevrilmez.

struct Me: Decodable, Sendable {
    struct User: Decodable, Sendable { let id: String; let email: String; let displayName: String }
    struct Membership: Decodable, Identifiable, Sendable { let tenantId: String; let tenantName: String; let roles: [String]; var id: String { tenantId } }
    struct Company: Decodable, Identifiable, Sendable, Hashable { let id: String; let name: String }
    struct Department: Decodable, Identifiable, Sendable, Hashable { let id: String; let name: String }
    let user: User
    let memberships: [Membership]
    let activeTenantId: String?
    let roles: [String]
    let companies: [Company]?
    /// v2 (D93): aktif üyeliğin departmanları; `allDepartments` rolden türetilir (Yönetici, Satınalma, Denetçi). Eski sunucuda yok.
    let departments: [Department]?
    let allDepartments: Bool?
    func has(_ roles: String...) -> Bool { self.roles.contains { roles.contains($0) } }
}

struct TaskItem: Decodable, Identifiable, Sendable, Hashable {
    let id: String
    let kind: String
    let entityType: String
    let entityId: String
    let title: String
    let reason: String
    let nextAction: String
    let severity: String
    let dueAt: String?
    let refNo: String?
}
struct TaskList: Decodable, Sendable {
    let items: [TaskItem]
    /// Persona K2: sayfalama (sunucu 200'lük sayfalar). Eski sunucu yanıtında yoksa nil (tek sayfa).
    let total: Int?
    let nextOffset: Int?
}

// MARK: İmza

struct SignatureStatusResponse: Decodable, Sendable {
    struct CV: Decodable, Sendable {
        let id: String; let title: String; let versionNo: Int; let documentVersionId: String; let documentSha256: String
        let finalizedAt: String?; let supersededById: String?; let etag: String
    }
    struct Slot: Decodable, Sendable, Hashable { let slot: Int; let decision: String; let observedMark: String? }
    struct Requirement: Decodable, Identifiable, Sendable {
        let id: String; let partyName: String; let signerRole: String; let state: String; let digital: String; let slots: [Slot]
    }
    struct Blocker: Decodable, Sendable { let code: String; let partyName: String?; let action: String }
    struct Status: Decodable, Sendable {
        let overall: String; let underlying: String; let automaticCheck: String; let custody: String
        let requirements: [Requirement]; let blockers: [Blocker]; let canFinalize: Bool
    }
    struct Can: Decodable, Sendable { let review: Bool; let finalize: Bool }
    let contractVersion: CV
    let status: Status
    let can: Can
}

// MARK: Fatura

/// Fatura ayrıntısı (salt okunur, v2 D93): onay/ret/istisna kalktı; v1'de verilmiş kararlar geçmiş olarak görünür.
struct InvoiceDetail: Decodable, Sendable {
    struct Invoice: Decodable, Sendable {
        let id: String; let kind: String; let invoiceNo: String; let issueDate: String; let currency: String; let supplierName: String
        let documentVersionId: String?; let documentSha256: String?; let legalStatus: String
        let supplierStatus: String?; let supplierIdentityVerified: Bool?
        let departmentName: String?
    }
    struct Line: Decodable, Identifiable, Sendable { let lineNo: Int; let description: String; let quantity: String; let unit: String; let netAmount: String; var id: Int { lineNo } }
    struct Issue: Decodable, Identifiable, Sendable { let code: String; let severity: String; let message: String; let ownerRole: String; var id: String { "\(code)-\(message)" } }
    struct Check: Decodable, Sendable { let issues: [Issue]; let netAmount: String; let taxTotal: String; let grossAmount: String; let payable: String }
    struct Decision: Decodable, Sendable { let kind: String; let decidedBy: String; let decidedAt: String; let reason: String? }
    struct Allocation: Decodable, Sendable {
        let lineNo: Int; let poLineId: String?; let contractVersionId: String?; let poCode: String?; let poLineDescription: String?; let contractTitle: String?
        /// Hedef metin olarak: sözleşme adı; eski sipariş bağı numarasıyla düz metin (siparişler kalktı, bağlantı yok).
        var targetText: String {
            if poLineId != nil {
                return "Sipariş \(poCode ?? "(erişiminiz dışında)")" + (poLineDescription.map { " · \($0)" } ?? "") + (contractTitle.map { " · Sözleşme: \($0)" } ?? "")
            }
            if let contractTitle { return "Sözleşme: \(contractTitle)" }
            return contractVersionId == nil ? "Bağsız" : "Sözleşme (erişiminiz dışında)"
        }
    }
    let invoice: Invoice; let lines: [Line]; let allocations: [Allocation]; let check: Check; let decisions: [Decision]

    /// Web ile aynı eşleşme durumu: hukuken iptal/ret ayrı; satırı olan ve tahsisi engelleyen bulgusu (eksik, fazla, başka
    /// tedarikçi ya da şirkete tahsis) olmayan fatura "Eşleşti" (alan adı paketi `MATCH_BLOCKING_CODES` ile aynı liste).
    var matched: Bool { !lines.isEmpty && !allocations.isEmpty && !check.issues.contains { Labels.matchBlockingCodes.contains($0.code) } }
    var matchText: String {
        if invoice.legalStatus != "RECEIVED" { return "Hukuken iptal/ret" }
        return matched ? "Eşleşti" : "Eşleşmedi"
    }
    /// Kaldırılan üçlü eşleştirme/tolerans bulguları gösterilmez (alan adı paketi `REMOVED_ISSUE_CODES` ile aynı liste).
    var visibleIssues: [Issue] { check.issues.filter { !Labels.removedIssueCodes.contains($0.code) } }
}

struct InvoiceRow: Decodable, Identifiable, Sendable, Hashable {
    let id: String; let kind: String; let invoiceNo: String; let issueDate: String; let currency: String; let supplierName: String; let netAmount: String?
    let legalStatus: String
    let supplierStatus: String?; let supplierIdentityVerified: Bool?
    let matched: Bool?; let departmentName: String?
    var matchText: String { legalStatus != "RECEIVED" ? "Hukuken iptal/ret" : matched == true ? "Eşleşti" : "Eşleşmedi" }
}
struct InvoiceList: Decodable, Sendable { let items: [InvoiceRow] }

// MARK: Sözleşme ve tedarikçi listeleri (v2 sekmeleri)

struct ContractRow: Decodable, Identifiable, Sendable, Hashable {
    struct Signature: Decodable, Sendable, Hashable { let overall: String; let missingParties: [String] }
    struct Ref: Decodable, Sendable, Hashable { let id: String; let code: String?; let title: String? }
    struct Supplier: Decodable, Sendable, Hashable { let id: String; let legalName: String; let status: String }
    let id: String; let title: String; let versionNo: Int; let stage: String; let finalizedAt: String?
    let supplierNames: [String]?; let departmentName: String?; let signature: Signature
    // v2 Faz 3 (Görev 4): türetilmiş durum ve özet alanları. Eski sunucuda yok; satır yine imza durumuyla görünür.
    let familyId: String?; let status: String?; let statusLabel: String?
    let project: Ref?; let supplier: Supplier?; let endDate: String?; let indefinite: Bool?; let amount: String?; let currency: String?
}
struct ContractList: Decodable, Sendable { let items: [ContractRow]; let total: Int }

// MARK: Sözleşme v2 (Faz 3: ekleme, onay zinciri)

struct UserRef: Decodable, Sendable, Hashable { let id: String; let displayName: String }

/// `GET /api/v1/contracts/:familyId/v2` (Görev 4). Durum sunucuda türetilir; istemci yalnız gösterir.
struct ContractV2: Decodable, Sendable {
    struct Family: Decodable, Sendable { let id: String; let code: String; let title: String; let companyId: String; let departmentId: String?; let departmentName: String?; let createdBy: UserRef?; let intakeFlow: Bool }
    struct Fields: Decodable, Sendable {
        let projectId: String?; let supplierId: String?; let contractType: String?; let contractTypeLabel: String?; let ownerUserId: String?
        let signedOn: String?; let indefinite: Bool; let contractNo: String?
        let termsId: String?; let termsVerified: Bool?
        let currency: String?; let valueType: String?; let amount: String?; let limitBasis: String?; let startDate: String?; let endDate: String?
        let autoRenewal: Bool?; let renewalMonths: Int?; let noticeAmount: Int?; let noticeUnit: String?; let noticePeriod: String?
    }
    struct Missing: Decodable, Sendable, Hashable { let field: String; let label: String }
    struct Status: Decodable, Sendable { let code: String; let label: String }
    struct Step: Decodable, Identifiable, Sendable {
        let id: String; let order: Int; let kind: String; let kindLabel: String; let assignedUser: UserRef?; let viaDeputy: Bool; let deputyUser: UserRef?
        let decision: String?; let decidedAt: String?; let decidedBy: UserRef?; let reason: String?; let current: Bool
    }
    struct Chain: Decodable, Sendable {
        let id: String; let status: String; let submittedBy: UserRef?; let submittedAt: String?; let note: String?; let closedAt: String?; let cancelReason: String?
        let steps: [Step]
    }
    struct Project: Decodable, Sendable { let id: String; let code: String?; let title: String?; let visible: Bool }
    /// `vkn`: v2 Faz 4 — VKN önerisi kayıtlı kartla karşılaştırılır (kesin eşitlik; yapay zekâ eşleştirmez). Eski sunucuda yok.
    struct Supplier: Decodable, Sendable { let id: String; let legalName: String; let status: String; let vkn: String? }
    struct Document: Decodable, Sendable { let contractVersionId: String; let versionNo: Int; let documentVersionId: String?; let filename: String?; let sha256: String? }
    struct Can: Decodable, Sendable { let edit: Bool; let submit: Bool; let decide: Bool }
    let family: Family; let fields: Fields; let missing: [Missing]; let status: Status; let legacy: Bool
    let chain: Chain?; let chainCount: Int
    let project: Project?; let supplier: Supplier?; let owner: UserRef?; let document: Document?; let can: Can
    /// v2 Faz 4 (Görev 5): ön inceleme özeti; `contract.review.read` yoksa ya da inceleme yoksa null, eski sunucuda yok.
    let review: ReviewSummary?
}

// MARK: Sözleşme yapay zekâsı (v2 Faz 4, D109)

/// Okuma (AI06) ya da inceleme (AI14) işi. `provider` yönlenmeyen işte (NOT_ALLOWED, NO_PROVIDER, WAITING_QUOTA) null.
struct AiRun: Decodable, Sendable {
    let id: String; let status: String; let reason: String?; let provider: String?; let isTestProvider: Bool; let providerLabel: String?
    let promptVersion: String?; let responseModel: String?; let createdAt: String; let finishedAt: String?
    var active: Bool { status == "QUEUED" || status == "RUNNING" }
    /// Çalışmayan (yönlenmemiş ya da bekleyen) iş: yeniden istemek ücret yaratmaz.
    var waiting: Bool { ["WAITING_QUOTA", "NO_PROVIDER", "NOT_ALLOWED"].contains(status) }
}

/// `GET /api/v1/contracts/:id/extractions` (Görev 4). Alanlar CONTRACT_AI_FIELDS sırasında; iş bitmediyse boş.
struct ContractExtractions: Decodable, Sendable {
    struct Field: Decodable, Identifiable, Sendable {
        let id: String; let field: String; let label: String; let value: String?; let page: Int?; let evidence: String?
        let confidence: String; let flags: [String]; let requiresHuman: Bool; let critical: Bool; let prefill: Bool
        let decision: String; let decidedBy: UserRef?; let decidedAt: String?
    }
    struct Can: Decodable, Sendable { let request: Bool }
    let familyId: String; let contractVersionId: String; let documentVersionId: String
    let run: AiRun?; let fields: [Field]; let can: Can
}

/// `POST /api/v1/contracts/:id/extractions` ve `/reviews` yanıtı (yalnız gerekli alanlar).
struct AiRequestResult: Decodable, Sendable { let runId: String?; let status: String; let reason: String? }

struct ReviewTemplateRef: Decodable, Sendable { let code: String; let versionNo: Int }

/// `GET /api/v1/contracts/:id/v2` içindeki `review` (Görev 5).
struct ReviewSummary: Decodable, Sendable {
    let id: String; let score: Int; let threshold: Int; let belowThreshold: Bool; let stale: Bool; let template: ReviewTemplateRef?; let modelId: String?
    let isTestProvider: Bool; let providerLabel: String?; let createdAt: String; let disclaimer: String; let advice: String?
}

/// `GET /api/v1/contracts/:id/reviews` (Görev 5). Puan yalnız bilgidir: onay vermez, engellemez.
struct ContractReviews: Decodable, Sendable {
    struct Finding: Decodable, Identifiable, Sendable {
        let id: String; let category: String; let categoryLabel: String; let kind: String; let severity: String; let title: String
        let quote: String?; let page: Int?; let templateRef: String?; let suggestion: String?; let verified: Bool; let sourceLabel: String?
    }
    struct SubScore: Decodable, Identifiable, Sendable { let category: String; let label: String; let score: Int?; var id: String { category } }
    struct Base: Decodable, Identifiable, Sendable {
        let id: String; let score: Int; let documentVersionId: String; let template: ReviewTemplateRef?; let modelId: String?; let promptVersion: String
        let rubricVersion: String; let isTestProvider: Bool; let providerLabel: String?; let stale: Bool; let createdAt: String
    }
    struct Current: Decodable, Sendable {
        let id: String; let score: Int; let documentVersionId: String; let template: ReviewTemplateRef?; let modelId: String?; let promptVersion: String
        let rubricVersion: String; let isTestProvider: Bool; let providerLabel: String?; let stale: Bool; let createdAt: String
        let subScoreList: [SubScore]; let summary: String?; let templateNote: String?; let findings: [Finding]
    }
    struct Can: Decodable, Sendable { let request: Bool }
    let familyId: String; let contractVersionId: String; let documentVersionId: String; let templateVersionId: String?
    let current: Current?; let run: AiRun?; let history: [Base]
    let threshold: Int; let belowThreshold: Bool; let advice: String?; let disclaimer: String; let can: Can
}

/// `GET /api/v1/contract-approvals/mine` (Görev 5): İşlerim'deki onay görevleriyle aynı küme.
struct MyApprovals: Decodable, Sendable {
    struct Item: Decodable, Identifiable, Sendable {
        struct Contract: Decodable, Sendable { let familyId: String; let code: String; let title: String }
        let stepId: String; let taskId: String; let order: Int; let stepCount: Int; let kindLabel: String; let asDeputy: Bool
        let contract: Contract; let canDecide: Bool
        var id: String { stepId }
    }
    let items: [Item]
}

struct ApprovalDecisionResult: Decodable, Sendable {
    struct Next: Decodable, Sendable { let kindLabel: String }
    let chainStatus: String; let nextStep: Next?; let contract: ContractV2
}

struct ApprovalPreview: Decodable, Sendable {
    struct Step: Decodable, Identifiable, Sendable { let order: Int; let kind: String; let kindLabel: String; let userId: String; let displayName: String; let viaDeputy: Bool; var id: Int { order } }
    let ok: Bool; let steps: [Step]?; let message: String?
}

struct ContractDraftCreated: Decodable, Sendable {
    struct Duplicate: Decodable, Sendable { let familyId: String; let code: String; let title: String }
    let familyId: String; let duplicateOf: Duplicate?
}

struct ContractSubmitResult: Decodable, Sendable { let chainId: String; let contract: ContractV2 }

struct ProjectOption: Decodable, Identifiable, Sendable, Hashable { let id: String; let code: String; let title: String; let departmentId: String?; let departmentName: String? }
struct ProjectOptions: Decodable, Sendable { let items: [ProjectOption] }
struct DepartmentOptions: Decodable, Sendable { let items: [Me.Department] }
struct MemberOption: Decodable, Identifiable, Sendable, Hashable { let id: String; let displayName: String }
struct CandidateSupplier: Decodable, Sendable { let id: String; let legalName: String; let status: String; let existing: Bool }

enum ContractLabels {
    static let types: [(String, String)] = [("SERVICE", "Hizmet"), ("HARDWARE", "Donanım"), ("MAINTENANCE", "Bakım-destek"), ("NDA", "Gizlilik"), ("CONSULTING", "Danışmanlık"), ("OTHER", "Diğer")]
    static let limitBasis: [String: String] = ["NET": "KDV hariç", "GROSS": "KDV dahil"]
    static let noticeUnit: [String: String] = ["DAY": "gün", "MONTH": "ay"]
    static let decision: [String: String] = ["APPROVED": "Onayladı", "REJECTED": "Reddetti"]
    static let chainStatus: [String: String] = ["OPEN": "Onayda", "APPROVED": "Onaylandı", "REJECTED": "Reddedildi", "CANCELLED": "İptal edildi"]
    /// Durum etiketi rengi: kırmızı eksik/ret/süre doldu, turuncu onayda/eski kayıt, yeşil yürürlükte, gri taslak.
    static func tone(_ code: String?) -> Notice.Tone? {
        switch code {
        case "INCOMPLETE", "REJECTED", "EXPIRED": .error
        case "IN_APPROVAL", "LEGACY": .warn
        case "APPROVED": .info
        default: nil
        }
    }
}

struct SupplierRow: Decodable, Identifiable, Sendable, Hashable {
    let id: String; let status: String; let taxIdType: String?; let taxId: String?; let legalName: String; let identityReviewRequired: Bool
    /// Vergi kimliğinin yalnız son 4 hanesi gösterilir (mobilde yeni veri açılmaz).
    var taxIdTail: String? {
        guard let taxId, !identityReviewRequired else { return nil }
        return "\(taxIdType ?? "VKN") ••••\(taxId.suffix(4))"
    }
}
struct SupplierList: Decodable, Sendable { let items: [SupplierRow] }

// MARK: Olay

struct IncidentRow: Decodable, Identifiable, Sendable, Hashable {
    let id: String; let code: String; let title: String; let occurredOn: String; let severity: String; let category: String; let status: String
    let disputeOpen: Bool; let supplierName: String; let openActions: Int
}
struct IncidentList: Decodable, Sendable { struct Can: Decodable, Sendable { let report: Bool }; let items: [IncidentRow]; let can: Can }
struct IncidentDetail: Decodable, Sendable {
    struct Incident: Decodable, Sendable {
        let id: String; let code: String; let title: String; let description: String; let impact: String?; let occurredOn: String; let status: String; let severity: String
        let category: String; let disputeOpen: Bool; let supplierName: String; let reportedBy: String; let reportedAt: String
    }
    struct Event: Decodable, Sendable { let kind: String; let note: String?; let at: String; let actor: String }
    struct Action: Decodable, Identifiable, Sendable { let id: String; let title: String; let ownerRole: String; let dueDate: String; let status: String; let doneNote: String? }
    struct ScoreImpact: Decodable, Sendable { let counted: Bool; let penalty: Int?; let reason: String? }
    struct Can: Decodable, Sendable { let verify: Bool; let report: Bool; let roles: [String] }
    let incident: Incident; let events: [Event]; let actions: [Action]; let scoreImpact: ScoreImpact; let can: Can
}
// `label` aynı adlı kayıtları ayırt eder (D82); eski sunucu yanıtında yoksa ünvan gösterilir.
struct SupplierOption: Decodable, Identifiable, Sendable, Hashable { let id: String; let legalName: String; let status: String; let label: String?
    var displayName: String { label ?? legalName } }
struct SupplierOptions: Decodable, Sendable { let items: [SupplierOption] }

// MARK: Belge

struct UploadResult: Decodable, Sendable {
    struct Processing: Decodable, Sendable { let stage: String; let message: String }
    let documentId: String; let documentVersionId: String; let sha256: String; let duplicate: Bool; let basicCheckStatus: String; let processing: Processing
}

/// Web ile aynı durum dili (apps/web/src/lib/labels.ts).
enum Labels {
    static let overall: [String: String] = [
        "NOT_REQUIRED": "İmza gerekmiyor", "NOT_REVIEWED": "İnceleme bekliyor", "COMPLETE": "İmza kanıtları tamam",
        "INCOMPLETE": "Eksik", "UNCLEAR": "Belirsiz", "EXCEPTION_ACTIVE": "Eksik — yetkili istisna ile işlem",
    ]
    static let requirement: [String: String] = [
        "SATISFIED": "Kanıt tamam", "PENDING": "İnceleme bekliyor", "MISSING": "İmza eksik (insan teyidi)", "UNCLEAR": "Belirsiz", "INVALID": "E-imza geçersiz",
    ]
    static let detection: [String: String] = [
        "NOT_PROCESSED": "Otomatik tarama yapılmadı", "CANDIDATE_FOUND": "İmza görüntüsü adayı bulundu (AI)",
        "NOT_DETECTED": "İmza görüntüsü bulunamadı — inceleme gerekli", "UNCLEAR": "Algılama belirsiz", "ERROR": "Otomatik kontrol hata verdi",
        "UNSUPPORTED": "Otomatik kontrol yapılamadı",
    ]
    static let custody: [String: String] = ["UNKNOWN": "Bilinmiyor", "RECEIPT_DECLARED": "Teslim beyan edildi", "CUSTODY_CONFIRMED": "Muhafaza teyit edildi"]
    static let event: [String: String] = ["REPORTED": "Bildirildi", "REVIEW_STARTED": "Ön inceleme başladı", "VERIFIED": "Doğrulandı", "REJECTED": "Doğrulanmadı",
        "DISPUTED": "Tedarikçi itirazı", "DISPUTE_RESOLVED": "İtiraz sonuçlandı", "DUPLICATE": "Mükerrer işaretlendi", "CLOSED": "Kapandı", "REOPENED": "Yeniden açıldı", "NOTE": "Not"]
    static let severity: [String: String] = ["CRITICAL": "Kritik", "HIGH": "Yüksek", "NORMAL": "Normal", "MEDIUM": "Orta", "LOW": "Düşük"]
    static let decision: [String: String] = ["IMAGE_CONFIRMED": "İmza görüntüsü teyit edildi", "MISSING": "İmza eksik", "UNCLEAR": "Belirsiz", "PENDING": "Karar yok"]
    static let mark: [String: String] = ["FULL_SIGNATURE": "Tam imza", "STAMP_ONLY": "Yalnız kaşe", "INITIALS_ONLY": "Yalnız paraf", "NAME_ONLY": "Yalnız yazılı isim", "NONE": "İşaret yok", "ILLEGIBLE": "Okunamıyor"]
    /// Kayıt üzerindeki tedarikçi notu (web `supplierRecordNote` ile aynı metin, D83); aktif ve doğrulanmış firmada nil.
    static func supplierNote(_ status: String?, verified: Bool?) -> String? {
        var notes: [String] = []
        if let status, status != "ACTIVE" { notes.append(supplierStatus[status] ?? "Bilinmeyen durum") }
        if verified == false { notes.append("vergi kimliği doğrulanmadı") }
        return notes.isEmpty ? nil : notes.joined(separator: " · ")
    }
    static let supplierStatus: [String: String] = [
        "CANDIDATE": "Aday", "CONDITIONAL": "Koşullu", "ACTIVE": "Aktif", "SUSPENDED": "Askıda", "ARCHIVED": "Arşiv", "REJECTED": "Reddedildi", "MERGED": "Birleştirildi",
    ]
    /// v1'de verilmiş fatura kararları salt okunur geçmiş olarak görünür (web `PAST_DECISION` ile aynı).
    static let pastDecision: [String: String] = ["APPROVAL": "Onaylandı (v1 kaydı)", "REJECTION": "Reddedildi (v1 kaydı)", "EXCEPTION_APPROVAL": "İstisna onaylandı (v1 kaydı)"]
    static let invoiceKind: [String: String] = ["INVOICE": "Fatura", "CREDIT_NOTE": "İade / alacak", "ADVANCE": "Avans"]
    /// Kaldırılan bulgu kodları (packages/domain `REMOVED_ISSUE_CODES`, D93): sipariş/kabul, tolerans ve istisna bulguları.
    static let matchBlockingCodes: Set<String> = ["UNALLOCATED", "OVER_ALLOCATED", "SUPPLIER_MISMATCH", "COMPANY_MISMATCH"]
    static let removedIssueCodes: Set<String> = ["RECEIPT_MISSING", "OVER_ORDER", "PRICE_MISMATCH", "UNIT_MISMATCH", "PO_CANCELLED", "CURRENCY_MISMATCH", "CREDIT_EXCEEDS", "NO_CONTRACT"]
    static let stage: [String: String] = ["DRAFT": "Taslak", "EXECUTION": "İmza aşaması", "ARCHIVE_IMPORT": "Arşivden alındı"]
    static let issueSeverity: [String: String] = ["BLOCK": "Engel", "EXCEPTION": "İstisna", "REVIEW": "İnceleme"]
    /// v2 rol kodu (D93): eski kodlar beş role eşlenir (web `roleLabel` ile aynı eşleme).
    static let v2Roles: [String: String] = [
        "ADMIN": "ADMIN", "TENANT_ADMIN": "ADMIN", "PLATFORM_OPS": "ADMIN",
        "PROCUREMENT": "PROCUREMENT", "BUYER": "PROCUREMENT", "PROCUREMENT_MANAGER": "PROCUREMENT", "MASTER_DATA": "PROCUREMENT", "LEGAL": "PROCUREMENT", "FINANCE": "PROCUREMENT",
        "DEPARTMENT_USER": "DEPARTMENT_USER", "REQUESTER": "DEPARTMENT_USER", "TECH_EVALUATOR": "DEPARTMENT_USER", "SECURITY": "DEPARTMENT_USER",
        "SUPPLIER": "SUPPLIER", "AUDITOR": "AUDITOR",
    ]
    static func v2Role(_ code: String) -> String { v2Roles[code] ?? code }
    static let role: [String: String] = v2Roles.mapValues { [
        "ADMIN": "Yönetici", "PROCUREMENT": "Satınalma", "DEPARTMENT_USER": "Departman kullanıcısı", "SUPPLIER": "Tedarikçi", "AUDITOR": "Denetçi",
    ][$0]! }
    /// Rol listesi Türkçe adlarla, tekrarsız (ör. eski BUYER + PROCUREMENT tek "Satınalma"). Bilinmeyen kod ham gösterilmez.
    static func roleNames(_ codes: [String]) -> String {
        var seen: [String] = []
        for c in codes { let n = role[c] ?? "Diğer rol"; if !seen.contains(n) { seen.append(n) } }
        return seen.isEmpty ? "Rol yok" : seen.joined(separator: ", ")
    }
    static let incidentStatus: [String: String] = ["REPORTED": "Bildirildi (iddia)", "UNDER_REVIEW": "İnceleniyor", "VERIFIED": "Doğrulandı", "REJECTED": "Doğrulanmadı", "CLOSED": "Kapandı"]
    static let category: [String: String] = [
        "QUALITY": "Kalite kusuru", "DELAY": "Gecikme", "OUTAGE": "Kesinti", "SLA": "SLA ihlali", "INVOICE_DISPUTE": "Fatura ihtilafı",
        "SECURITY": "Güvenlik", "PERSONAL_DATA": "Kişisel veri", "ETHICS": "Etik ihlal",
    ]
    static let documentKind: [String: String] = ["INVOICE": "Fatura", "CONTRACT": "Sözleşme", "QUOTE": "Teklif", "OTHER": "Diğer"]
}

/// Ondalık metni Türkçe gösterir (hesap yapmaz). "1234.5" → "1.234,50"
enum Fmt {
    static func money(_ s: String?, _ currency: String) -> String {
        guard let s, let d = Decimal(string: s) else { return "—" }
        let f = NumberFormatter(); f.locale = Locale(identifier: "tr_TR"); f.numberStyle = .currency; f.currencyCode = currency
        return f.string(from: d as NSDecimalNumber) ?? "\(s) \(currency)"
    }
    /// Para birimi bilinmeyen tutar: tr-TR, simgesiz, en az 2 ondalık (fazlası korunur; kayan noktaya çevrilmez).
    static func amount(_ s: String) -> String {
        guard let d = Decimal(string: s) else { return s }
        let f = NumberFormatter(); f.locale = Locale(identifier: "tr_TR"); f.numberStyle = .decimal; f.minimumFractionDigits = 2; f.maximumFractionDigits = 6
        return f.string(from: d as NSDecimalNumber) ?? s
    }
    static func qty(_ s: String) -> String {
        guard let d = Decimal(string: s) else { return s }
        let f = NumberFormatter(); f.locale = Locale(identifier: "tr_TR"); f.numberStyle = .decimal; f.maximumFractionDigits = 6
        return f.string(from: d as NSDecimalNumber) ?? s
    }
    static func date(_ iso: String?) -> String {
        guard let iso else { return "—" }
        let p = ISO8601DateFormatter(); p.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let day = DateFormatter(); day.locale = Locale(identifier: "tr_TR"); day.dateStyle = .medium
        if let d = p.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) { day.timeStyle = .short; return day.string(from: d) }
        let only = DateFormatter(); only.dateFormat = "yyyy-MM-dd"; only.timeZone = TimeZone(identifier: "Europe/Istanbul")
        if let d = only.date(from: String(iso.prefix(10))) { return day.string(from: d) }
        return iso
    }
}
