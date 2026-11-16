import Foundation
import Network
import Observation

@MainActor
@Observable
final class SessionStore {
    var me: Me?
    var isLoading = false
    var lastError: String?
    /// Ağ durumu: çevrimdışıyken imza kararı ve kayıt yazımı gönderilmez (T44).
    private(set) var isOnline = true
    let api: APIClient

    /// Geliştirme oturumu belirteci (yalnız DEBUG derlemesinde ve sunucu dev modundaysa).
    private var devToken: String? = Keychain.load(account: "token")
    /// Kurumsal oturum (OIDC). Erişim belirteci kısa ömürlü; yenileme belirteciyle sessizce yenilenir.
    private var oidcTokens: TokenSet? = Keychain.load(account: "oidc").flatMap { try? JSONDecoder().decode(TokenSet.self, from: Data($0.utf8)) }
    private(set) var authConfig: AuthConfig?
    private var refreshing: Task<TokenSet, Error>?
    var hasSession: Bool { devToken != nil || oidcTokens != nil }
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

    /// Sunucudan oturum yapılandırması: kurumsal IdP (OIDC) veya geliştirme modu.
    func loadAuthConfig() async {
        do {
            let (c, _): (AuthConfig, String?) = try await api.send("/api/v1/auth/config", token: nil, tenantId: nil)
            authConfig = c
        } catch {
            lastError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Kurumsal giriş: sistem tarayıcı oturumu (ASWebAuthenticationSession) + PKCE. Parola uygulamaya hiç girmez.
    func login() async {
        isLoading = true
        defer { isLoading = false }
        lastError = nil
        if authConfig == nil { await loadAuthConfig() }
        guard let c = authConfig, c.mode == "oidc" else { return }
        do {
            let t = try await OIDC.signIn(config: c)
            store(t)
            await refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }

    #if DEBUG
    /// Yalnız geliştirme derlemesi ve sunucu dev modundayken: sentetik kullanıcı. Yayın derlemesinde bu yol yoktur.
    func devLogin(email: String) async {
        struct Body: Encodable, Sendable { let email: String }
        struct Res: Decodable, Sendable { let token: String }
        isLoading = true
        defer { isLoading = false }
        do {
            let (res, _): (Res, String?) = try await api.send("/api/v1/dev/token", method: "POST", body: Body(email: email), token: nil, tenantId: nil)
            devToken = res.token
            Keychain.save(res.token, account: "token")
            await refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }
    #endif

    private func store(_ t: TokenSet) {
        oidcTokens = t
        if let d = try? JSONEncoder().encode(t), let s = String(data: d, encoding: .utf8) { Keychain.save(s, account: "oidc") }
    }

    /// Geçerli erişim belirteci; süresi dolmak üzereyse yenilenir (aynı anda tek yenileme).
    func accessToken() async throws -> String? {
        if let devToken { return devToken }
        guard let t = oidcTokens else { return nil }
        if t.expiresAt.timeIntervalSinceNow > 30 { return t.accessToken }
        if let refreshing { return try await refreshing.value.accessToken }
        if authConfig == nil { await loadAuthConfig() }
        guard let c = authConfig else { throw APIError.offline() }
        let task = Task { try await OIDC.refresh(config: c, tokens: t) }
        refreshing = task
        defer { refreshing = nil }
        do {
            let n = try await task.value
            store(n)
            return n.accessToken
        } catch let e as OIDC.Failure {
            logout(endIdpSession: false)
            throw APIError(code: "session_expired", message: e.message, status: 401)
        }
    }

    func refresh() async {
        guard hasSession else { me = nil; return }
        do {
            let token = try await accessToken()
            let (m, _): (Me, String?) = try await api.send("/api/v1/me", token: token, tenantId: tenantId)
            if m.activeTenantId == nil, let first = m.memberships.first {
                tenantId = first.tenantId
                Keychain.save(first.tenantId, account: "tenant")
                let (m2, _): (Me, String?) = try await api.send("/api/v1/me", token: token, tenantId: tenantId)
                me = m2
            } else {
                // Sunucu tek üyelikte kiracıyı kendisi seçer; taslaklar kiracıya bağlı saklandığı için yerelde de tutulur
                // (yoksa tarama taslağı sessizce kaydedilmiyordu).
                if tenantId == nil, let active = m.activeTenantId {
                    tenantId = active
                    Keychain.save(active, account: "tenant")
                }
                me = m
            }
            lastError = nil
        } catch let e as APIError where e.status == 401 {
            logout(endIdpSession: false)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func switchTenant(_ id: String) async {
        tenantId = id
        Keychain.save(id, account: "tenant")
        await refresh()
    }

    /// Yerel belirteçler hemen silinir; kurumsal oturumda yenileme belirteci IdP'de de iptal edilir.
    func logout(endIdpSession: Bool = true) {
        let tokens = oidcTokens
        devToken = nil; oidcTokens = nil; tenantId = nil; me = nil
        Keychain.delete(account: "token"); Keychain.delete(account: "oidc"); Keychain.delete(account: "tenant")
        if endIdpSession, let tokens, let c = authConfig { Task { await OIDC.revoke(config: c, tokens: tokens) } }
    }

    func get<T: Decodable & Sendable>(_ path: String) async throws -> (T, String?) {
        try await api.send(path, token: try await accessToken(), tenantId: tenantId)
    }

    /// Yazma isteği. Çevrimdışıysa hiç gönderilmez: imza kararı, olay ve faaliyet kaydı çevrimdışı yapılmaz.
    /// `idempotencyKey`: aynı form için sabit anahtar; yanıtı kaybolan istek tekrar gönderilirse sunucu ikinci kayıt açmaz.
    func post<T: Decodable & Sendable>(_ path: String, body: (any Encodable & Sendable)? = nil, ifMatch: String? = nil, idempotencyKey: String? = nil, method: String = "POST") async throws -> T {
        guard isOnline else { throw APIError(code: "offline", message: "Çevrimdışısınız; bu işlem yalnız bağlantı varken ve güncel kayıt üzerinde yapılır.") }
        let (r, _): (T, String?) = try await api.send(path, method: method, body: body, token: try await accessToken(), tenantId: tenantId, ifMatch: ifMatch, idempotencyKey: idempotencyKey)
        return r
    }

    func data(_ path: String) async throws -> (Data, String?) { try await api.data(path, token: try await accessToken(), tenantId: tenantId) }
}
