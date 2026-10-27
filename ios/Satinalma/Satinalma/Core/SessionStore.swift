import Foundation
import Observation

@MainActor
@Observable
final class SessionStore {
    var me: Me?
    var isLoading = false
    var lastError: String?
    let api: APIClient

    private(set) var token: String? = Keychain.load(account: "token")
    var tenantId: String? = Keychain.load(account: "tenant")

    init() {
        // Simülatörde yerel API; üretimde yapılandırmadan gelir. Mobil uygulamada sır tutulmaz.
        let base = Bundle.main.object(forInfoDictionaryKey: "SPApiBaseURL") as? String ?? "http://localhost:4100"
        api = APIClient(baseURL: URL(string: base)!)
    }

    /// Yalnız geliştirme: sentetik kullanıcı. Üretimde ASWebAuthenticationSession ile OIDC + PKCE.
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
        } catch {
            lastError = error.localizedDescription
        }
    }

    func logout() {
        token = nil; tenantId = nil; me = nil
        Keychain.delete(account: "token"); Keychain.delete(account: "tenant")
    }

    func get<T: Decodable & Sendable>(_ path: String) async throws -> (T, String?) {
        try await api.send(path, token: token, tenantId: tenantId)
    }
}
