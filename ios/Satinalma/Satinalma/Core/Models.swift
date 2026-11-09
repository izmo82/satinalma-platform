import Foundation

// API yanıt modelleri (web ile aynı sözleşme). Para ve miktar sunucudan ondalık metin olarak gelir; Double'a çevrilmez.

struct Me: Decodable, Sendable {
    struct User: Decodable, Sendable { let id: String; let email: String; let displayName: String }
    struct Membership: Decodable, Identifiable, Sendable { let tenantId: String; let tenantName: String; let roles: [String]; var id: String { tenantId } }
    struct Company: Decodable, Identifiable, Sendable, Hashable { let id: String; let name: String }
    let user: User
    let memberships: [Membership]
    let activeTenantId: String?
    let roles: [String]
    let companies: [Company]?
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

// MARK: Sipariş ve kabul

struct PurchaseOrderRow: Decodable, Identifiable, Sendable, Hashable {
    let id: String; let code: String; let currency: String; let status: String; let issuedAt: String; let supplierName: String; let contractTitle: String?; let total: String?
}
struct PurchaseOrderList: Decodable, Sendable { let items: [PurchaseOrderRow] }
struct PurchaseOrderDetail: Decodable, Sendable {
    struct PO: Decodable, Sendable { let id: String; let code: String; let currency: String; let status: String; let supplierName: String; let contractTitle: String?; let closeReason: String? }
    struct Line: Decodable, Identifiable, Sendable {
        let poLineId: String; let description: String; let unit: String; let kind: String; let orderedQty: String; let unitPrice: String; let receivedQty: String; let invoicedQty: String
        var id: String { poLineId }
    }
    struct Receipt: Decodable, Identifiable, Sendable { let id: String; let poLineId: String; let quantity: String; let note: String; let recordedAt: String; let recordedBy: String }
    struct Can: Decodable, Sendable { let receive: Bool }
    let po: PO; let lines: [Line]; let receipts: [Receipt]; let can: Can
}

// MARK: Fatura

struct InvoiceDetail: Decodable, Sendable {
    struct Invoice: Decodable, Sendable {
        let id: String; let kind: String; let invoiceNo: String; let issueDate: String; let currency: String; let supplierName: String
        let documentVersionId: String?; let documentSha256: String?; let createdByMe: Bool; let legalStatus: String
    }
    struct Line: Decodable, Identifiable, Sendable { let lineNo: Int; let description: String; let quantity: String; let unit: String; let netAmount: String; var id: Int { lineNo } }
    struct Issue: Decodable, Identifiable, Sendable { let code: String; let severity: String; let message: String; let ownerRole: String; var id: String { "\(code)-\(message)" } }
    struct Check: Decodable, Sendable { let issues: [Issue]; let canApprove: Bool; let needsException: Bool; let netAmount: String; let taxTotal: String; let grossAmount: String; let payable: String }
    struct Decision: Decodable, Sendable { let kind: String; let decidedBy: String; let decidedAt: String }
    struct Allocation: Decodable, Sendable { let lineNo: Int; let poId: String?; let poCode: String?; let poLineDescription: String?; let contractTitle: String? }
    struct Can: Decodable, Sendable { let approve: Bool }
    let invoice: Invoice; let lines: [Line]; let allocations: [Allocation]; let check: Check; let status: String; let decisions: [Decision]; let checkFingerprint: String; let can: Can
}

struct InvoiceRow: Decodable, Identifiable, Sendable, Hashable {
    let id: String; let kind: String; let invoiceNo: String; let issueDate: String; let currency: String; let supplierName: String; let netAmount: String?
    let legalStatus: String; let decision: String?
}
struct InvoiceList: Decodable, Sendable { let items: [InvoiceRow] }

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
    static let invoiceStatus: [String: String] = [
        "APPROVAL": "Finans onaylı", "REJECTION": "Reddedildi", "READY": "Onaya hazır", "NEEDS_EXCEPTION": "İstisna gerekli",
        "EXCEPTION_APPROVED": "İstisna onaylı, finans onayı bekliyor", "BLOCKED": "Engelli",
    ]
    static let issueSeverity: [String: String] = ["BLOCK": "Engel", "EXCEPTION": "İstisna", "REVIEW": "İnceleme"]
    static let role: [String: String] = [
        "REQUESTER": "Talep sahibi", "BUYER": "Satınalmacı", "PROCUREMENT_MANAGER": "Satınalma yöneticisi", "TECH_EVALUATOR": "Teknik değerlendirici",
        "LEGAL": "Hukuk", "FINANCE": "Finans", "SECURITY": "Bilgi güvenliği", "MASTER_DATA": "Ana veri", "TENANT_ADMIN": "Kiracı yöneticisi", "AUDITOR": "Denetçi",
    ]
    static let incidentStatus: [String: String] = ["REPORTED": "Bildirildi (iddia)", "UNDER_REVIEW": "İnceleniyor", "VERIFIED": "Doğrulandı", "REJECTED": "Doğrulanmadı", "CLOSED": "Kapandı"]
    static let category: [String: String] = [
        "QUALITY": "Kalite kusuru", "DELAY": "Gecikme", "OUTAGE": "Kesinti", "SLA": "SLA ihlali", "INVOICE_DISPUTE": "Fatura ihtilafı",
        "SECURITY": "Güvenlik", "PERSONAL_DATA": "Kişisel veri", "ETHICS": "Etik ihlal",
    ]
    static let poStatus: [String: String] = ["OPEN": "Açık", "CLOSED": "Kapatıldı", "CANCELLED": "İptal edildi"]
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
