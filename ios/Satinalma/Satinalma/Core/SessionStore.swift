import Foundation
import Network
import Observation

@MainActor
@Observable
final class SessionStore {
    var me: Me?
    var isLoading = false
    var lastError: String?
    /// Ağ durumu: çevrimdışıyken nihai onay, kabul ve imza kararı gönderilmez (T44).
    private(set) var isOnline = true
    let api: APIClient

    private(set) var token: String? = Keychain.load(account: "token")
    var tenantId: String? = Keychain.load(account: "tenant")
    private let monitor = NWPathMonitor()

    init() {
        // Simülatörde yerel API; üretimde yapılandırmadan gelir. Mobil uygulamada sır tutulmaz.
        let configured = Bundle.main.object(forInfoDictionaryKey: "SPApiBaseURL") as? String
        let base = (configured?.hasPrefix("http") ?? false) ? configured! : "http://localhost:4100"
        api = APIClient(baseURL: URL(string: base)!)
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.isOnline = online }
        }
        monitor.start(queue: DispatchQueue(label: "sp.network"))
    }

    /// Yalnız geliştirme: sentetik kullanıcı. Üretimde ASWebAuthenticationSession ile OIDC + PKCE (bu sürümde yok).
    func devLogin(email: String) async {
        struct Body: Encodable, Sendable { let email: String }
        struct Res: Decodable, Sendable { let token: String }
        isLoading = true
        defer { isLoading = false }
        do {
            let (res, _): (Res, String?) = try await api.send("/api/v1/dev/token", method: "POST", body: Body(email: email), token: nil, tenantId: nil)
            token = res.token
            Keychain.save(res.token, account: "token")
            await refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func refresh() async {
        guard let token else { me = nil; return }
        do {
            let (m, _): (Me, String?) = try await api.send("/api/v1/me", token: token, tenantId: tenantId)
            if m.activeTenantId == nil, let first = m.memberships.first {
                tenantId = first.tenantId
                Keychain.save(first.tenantId, account: "tenant")
                let (m2, _): (Me, String?) = try await api.send("/api/v1/me", token: token, tenantId: tenantId)
                me = m2
            } else {
                me = m
            }
            lastError = nil
        } catch let e as APIError where e.status == 401 {
            logout()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func switchTenant(_ id: String) async {
        tenantId = id
        Keychain.save(id, account: "tenant")
        await refresh()
    }

    func logout() {
        token = nil; tenantId = nil; me = nil
        Keychain.delete(account: "token"); Keychain.delete(account: "tenant")
    }

    func get<T: Decodable & Sendable>(_ path: String) async throws -> (T, String?) {
        try await api.send(path, token: token, tenantId: tenantId)
    }

    /// Yazma isteği. Çevrimdışıysa hiç gönderilmez: mali kabul, onay ve imza kararı çevrimdışı yapılmaz.
    /// `idempotencyKey`: aynı form için sabit anahtar; yanıtı kaybolan istek tekrar gönderilirse sunucu ikinci kayıt açmaz.
    func post<T: Decodable & Sendable>(_ path: String, body: (any Encodable & Sendable)? = nil, ifMatch: String? = nil, idempotencyKey: String? = nil, method: String = "POST") async throws -> T {
        guard isOnline else { throw APIError(code: "offline", message: "Çevrimdışısınız; bu işlem yalnız bağlantı varken ve güncel kayıt üzerinde yapılır.") }
        let (r, _): (T, String?) = try await api.send(path, method: method, body: body, token: token, tenantId: tenantId, ifMatch: ifMatch, idempotencyKey: idempotencyKey)
        return r
    }

    func data(_ path: String) async throws -> (Data, String?) { try await api.data(path, token: token, tenantId: tenantId) }
}
