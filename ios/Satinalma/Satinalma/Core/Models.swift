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
struct TaskList: Decodable, Sendable { let items: [TaskItem] }

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
    let id: String; let title: String; let versionNo: Int; let stage: String; let finalizedAt: String?
    let supplierNames: [String]?; let departmentName: String?; let signature: Signature
}
struct ContractList: Decodable, Sendable { let items: [ContractRow]; let total: Int }

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
