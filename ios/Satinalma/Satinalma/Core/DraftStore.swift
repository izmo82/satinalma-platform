import CryptoKit
import Foundation
import Observation
import UIKit

/// Taranan belge taslağı. Meta veri ve dosya şifreli saklanır (AES-GCM, anahtar Keychain'de; dosya koruması "complete").
/// Taslak, sunucu başarıyı bildirmeden silinmez (04 iOS). Sunucu aynı baytları hash ile tekilleştirdiği için
/// bağlantı koptuktan sonra tekrar yükleme yeni kayıt açmaz (T43). Taslak, onu oluşturan kullanıcıya ve kiracıya aittir.
struct Draft: Codable, Identifiable, Sendable, Hashable {
    enum State: String, Codable, Sendable { case pending, uploading, failed, uploaded }
    let id: UUID
    let createdAt: Date
    var title: String
    var kind: String
    var companyId: String
    var companyName: String
    var pageCount: Int
    var byteCount: Int
    var sha256: String
    var state: State
    var lastError: String?
    var attempts: Int
    /// Sunucu yanıtı (başarıda): belge sürümü ve işleme durumu.
    var documentVersionId: String?
    var serverMessage: String?
    var duplicate: Bool?
    /// Sahiplik: başka kullanıcının oturumunda listelenmez ve yüklenmez (yanlış kimlikle denetim kaydı oluşmaz).
    var ownerUserId: String?
    var tenantId: String?
    /// v2 Faz 3: sözleşme taslağı açıldıysa ailesi; "Alanları doğrula" aynı taslağı açar, ikinci taslak açılmaz.
    var contractFamilyId: String?
}

@MainActor
@Observable
final class DraftStore {
    private(set) var drafts: [Draft] = []
    /// Anahtar veya dizin şu an okunamıyor (ör. cihaz kilitli). Bu durumda hiçbir şey yazılmaz/silinmez; kilit açılınca yeniden denenir.
    private(set) var unavailableReason: String?
    private let dir: URL
    private var key: SymmetricKey?

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "Drafts", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        dir = base
        load()
        NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in if self?.unavailableReason != nil { self?.load() } }
        }
    }

    private var indexURL: URL { dir.appending(path: "index.bin") }
    private func fileURL(_ id: UUID) -> URL { dir.appending(path: "\(id.uuidString).bin") }

    /// Anahtar yalnız Keychain'de gerçekten yoksa üretilir; geçici okuma hatasında mevcut anahtar asla silinmez/değiştirilmez.
    private func load() {
        switch Keychain.read(account: "draft-key") {
        case .value(let saved):
            guard let raw = Data(base64Encoded: saved) else { unavailableReason = "Taslak anahtarı okunamadı."; return }
            key = SymmetricKey(data: raw)
        case .notFound:
            let k = SymmetricKey(size: .bits256)
            guard Keychain.addIfAbsent(k.withUnsafeBytes { Data($0) }.base64EncodedString(), account: "draft-key") else {
                unavailableReason = "Taslak anahtarı oluşturulamadı."; return
            }
            key = k
        case .unavailable:
            unavailableReason = "Cihaz kilidi açılınca taslaklar görünür."; return
        }
        guard FileManager.default.fileExists(atPath: indexURL.path) else { unavailableReason = nil; drafts = []; return }
        do {
            drafts = try JSONDecoder().decode([Draft].self, from: decrypt(Data(contentsOf: indexURL)))
            unavailableReason = nil
        } catch {
            // Dizin okunamadı: boş listeyle devam edilmez (sonraki kayıt eski taslakları siler). Dizin kenara alınır, taslaklar dosyalardan kurtarılır.
            let stamp = Int(Date().timeIntervalSince1970)
            try? FileManager.default.moveItem(at: indexURL, to: dir.appending(path: "index.corrupt-\(stamp)"))
            drafts = recover()
            unavailableReason = nil
            try? persist()
        }
        // Uygulama yükleme sırasında kapandıysa durum "bekliyor"a döner; tekrar yükleme güvenlidir (sunucu tekilleştirir).
        for i in drafts.indices where drafts[i].state == .uploading { drafts[i].state = .pending }
    }

    /// Dosyası okunabilen taslakları geri getirir; meta veri kaybolduğu için şirket/başlık yeniden seçilene kadar yüklenmez.
    private func recover() -> [Draft] {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey])) ?? []
        return files.compactMap { url -> Draft? in
            guard url.pathExtension == "bin", let id = UUID(uuidString: url.deletingPathExtension().lastPathComponent),
                  let data = try? decrypt(Data(contentsOf: url)) else { return nil }
            return Draft(id: id, createdAt: Date(), title: "Kurtarılan taslak", kind: "OTHER", companyId: "", companyName: "—", pageCount: 0, byteCount: data.count,
                         sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), state: .failed,
                         lastError: "Taslak listesi okunamadı; dosya korundu. Yüklemek için yeniden tarayın veya silin.", attempts: 0)
        }
    }

    private func encrypt(_ data: Data) throws -> Data {
        guard let key else { throw CocoaError(.fileReadNoPermission) }
        return try AES.GCM.seal(data, using: key).combined!
    }
    private func decrypt(_ data: Data) throws -> Data {
        guard let key else { throw CocoaError(.fileReadNoPermission) }
        return try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key)
    }
    private func write(_ data: Data, to url: URL) throws { try encrypt(data).write(to: url, options: [.atomic, .completeFileProtection]) }
    private func persist() throws { try write(JSONEncoder().encode(drafts), to: indexURL) }

    /// Oturumdaki kullanıcıya ait taslaklar (diğer kullanıcılarınki gizli kalır, silinmez). Sahiplik alanından önce kaydedilmiş taslaklar
    /// kaybolmasın diye gösterilir ama yüklenemez (kimin adına yükleneceği bilinmiyor); kullanıcı yeniden tarar veya siler.
    /// Yüklenmiş sahipsiz kayıtlar gösterilmez: içerik sunucuda, burada kaybedilecek bir şey yok ve başka kullanıcının kaydı gibi görünür.
    func visible(userId: String?, tenantId: String?) -> [Draft] {
        drafts.filter { ($0.ownerUserId == userId && $0.tenantId == tenantId) || ($0.ownerUserId == nil && $0.state != .uploaded) }
    }

    @discardableResult
    func add(pdf: Data, title: String, kind: String, company: Me.Company, pageCount: Int, userId: String, tenantId: String) throws -> Draft {
        if let unavailableReason { throw CocoaError(.fileWriteNoPermission, userInfo: [NSLocalizedDescriptionKey: unavailableReason]) }
        var d = Draft(id: UUID(), createdAt: Date(), title: title, kind: kind, companyId: company.id, companyName: company.name, pageCount: pageCount,
                      byteCount: pdf.count, sha256: SHA256.hash(data: pdf).map { String(format: "%02x", $0) }.joined(), state: .pending, lastError: nil, attempts: 0)
        d.ownerUserId = userId; d.tenantId = tenantId
        try write(pdf, to: fileURL(d.id))
        drafts.insert(d, at: 0)
        do { try persist() } catch {
            // Dizin yazılamadıysa dosya da geri alınır: kayıtsız (yeniden açılışta kaybolacak) taslak bırakılmaz; kullanıcı hatayı görür.
            drafts.removeAll { $0.id == d.id }
            try? FileManager.default.removeItem(at: fileURL(d.id))
            throw error
        }
        return d
    }

    /// Taranan sözleşme belgesi için açılan sözleşme taslağını (aile) bağlar.
    func setContractFamily(_ id: UUID, familyId: String) { update(id) { $0.contractFamilyId = familyId } }

    func payload(_ d: Draft) throws -> Data { try decrypt(Data(contentsOf: fileURL(d.id))) }

    private func update(_ id: UUID, _ change: (inout Draft) -> Void) {
        guard let i = drafts.firstIndex(where: { $0.id == id }) else { return }
        change(&drafts[i])
        try? persist()
    }

    /// Yükleme: başarıda dosya silinir, kayıt "yüklendi" olarak kalır (sunucu belge no ile). Hata/çevrimdışında taslak korunur.
    func upload(_ id: UUID, session: SessionStore) async {
        guard let d = drafts.first(where: { $0.id == id }), d.state != .uploaded, d.state != .uploading,
              d.ownerUserId == session.me?.user.id, d.tenantId == session.tenantId, !d.companyId.isEmpty else { return }
        update(id) { $0.state = .uploading; $0.attempts += 1; $0.lastError = nil }
        do {
            let data = try payload(d)
            let res: UploadResult = try await session.api.upload("/api/v1/documents", fields: ["companyId": d.companyId, "kind": d.kind, "title": d.title],
                                                                 fileName: "\(d.title).pdf", mimeType: "application/pdf", file: data, token: try await session.accessToken(), tenantId: session.tenantId)
            update(id) { $0.state = .uploaded; $0.documentVersionId = res.documentVersionId; $0.serverMessage = res.processing.message; $0.duplicate = res.duplicate }
            try? FileManager.default.removeItem(at: fileURL(id))
        } catch let e as APIError {
            update(id) {
                $0.state = e.isOffline || e.outcomeUnknown ? .pending : .failed
                $0.lastError = e.isOffline ? "Bağlantı yok; taslak bu cihazda şifreli olarak korunuyor."
                    : e.outcomeUnknown ? "Yanıt alınamadı; belge sunucuya ulaşmış olabilir. Tekrar yüklemek güvenlidir (aynı dosya ikinci kayıt açmaz)."
                    : e.message
            }
        } catch {
            update(id) { $0.state = .failed; $0.lastError = "Taslak okunamadı: \(error.localizedDescription)" }
        }
    }

    /// Bekleyen taslakları (bağlantı gelince) sırayla yükler; yalnız oturumdaki kullanıcınınkiler.
    func uploadPending(session: SessionStore) async {
        for d in visible(userId: session.me?.user.id, tenantId: session.tenantId) where d.state == .pending { await upload(d.id, session: session) }
    }

    /// Kullanıcının açık kararıyla silme. Yükleme sürerken silinmez (gönderilmekte olan belge geri çağrılamaz); false döner.
    @discardableResult
    func remove(_ id: UUID) -> Bool {
        guard let d = drafts.first(where: { $0.id == id }), d.state != .uploading else { return false }
        try? FileManager.default.removeItem(at: fileURL(id))
        drafts.removeAll { $0.id == id }
        try? persist()
        return true
    }
}
