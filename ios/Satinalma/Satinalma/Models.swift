import Foundation

struct Me: Decodable, Sendable {
    struct User: Decodable, Sendable { let id: String; let email: String; let displayName: String }
    struct Membership: Decodable, Identifiable, Sendable { let tenantId: String; let tenantName: String; let roles: [String]; var id: String { tenantId } }
    let user: User
    let memberships: [Membership]
    let activeTenantId: String?
    let roles: [String]
}

struct TaskItem: Decodable, Identifiable, Sendable {
    let id: String
    let kind: String
    let entityType: String
    let entityId: String
    let title: String
    let reason: String
    let nextAction: String
    let severity: String
}

struct TaskList: Decodable, Sendable { let items: [TaskItem] }

struct SignatureStatusResponse: Decodable, Sendable {
    struct CV: Decodable, Sendable { let id: String; let title: String; let versionNo: Int; let documentSha256: String; let finalizedAt: String?; let supersededById: String? }
    struct Requirement: Decodable, Identifiable, Sendable {
        let id: String; let partyName: String; let signerRole: String; let state: String; let digital: String
    }
    struct Blocker: Decodable, Sendable { let code: String; let partyName: String?; let action: String }
    struct Status: Decodable, Sendable {
        let overall: String; let underlying: String; let automaticCheck: String; let custody: String
        let requirements: [Requirement]; let blockers: [Blocker]; let canFinalize: Bool
    }
    let contractVersion: CV
    let status: Status
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
    static let custody: [String: String] = ["UNKNOWN": "Fiziksel asıl: bilinmiyor", "RECEIPT_DECLARED": "Teslim beyan edildi", "CUSTODY_CONFIRMED": "Muhafaza teyit edildi"]
    static let severity: [String: String] = ["CRITICAL": "Kritik", "HIGH": "Yüksek", "NORMAL": "Normal"]
}
