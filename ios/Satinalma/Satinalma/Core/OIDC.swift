import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

/// Sunucunun bildirdiği oturum yapılandırması (`/api/v1/auth/config`). IdP adresleri derlemeye gömülmez; aynı uygulama her kurumda çalışır.
struct AuthConfig: Decodable, Sendable {
    let mode: String
    let issuer: String?
    let nativeClientId: String?
    let scope: String?
    let resource: String?
    let authorizationEndpoint: String?
    let tokenEndpoint: String?
    let endSessionEndpoint: String?
    let revocationEndpoint: String?
}

/// IdP'den alınan belirteçler. Yalnız Keychain'de (bu cihaz, kilit açıkken) tutulur; mobil uygulamada istemci sırrı yoktur.
struct TokenSet: Codable, Sendable {
    var accessToken: String
    var refreshToken: String?
    var idToken: String?
    var expiresAt: Date
}

/// Kurumsal giriş: OIDC yetkilendirme kodu + PKCE (S256), ASWebAuthenticationSession (RFC 8252). Yönlendirme `<paket kimliği>:/oauth/callback`.
enum OIDC {
    static var redirectScheme: String { Bundle.main.bundleIdentifier ?? "com.example.satinalma" }
    static var redirectURI: String { "\(redirectScheme):/oauth/callback" }

    struct Failure: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func randomURLSafe(_ bytes: Int = 32) -> String {
        var b = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &b)
        return Data(b).base64URL
    }

    /// Tarayıcı oturumu açar, kodu alır ve belirteçle değiştirir.
    @MainActor
    static func signIn(config c: AuthConfig) async throws -> TokenSet {
        guard let clientId = c.nativeClientId, let authz = c.authorizationEndpoint, let tokenUrl = c.tokenEndpoint, var comps = URLComponents(string: authz) else {
            throw Failure(message: "Kurumun mobil giriş ayarı yapılmamış (OIDC_NATIVE_CLIENT_ID). Sistem yöneticinize bildirin.")
        }
        let verifier = randomURLSafe(64)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        let state = randomURLSafe(), nonce = randomURLSafe()
        var items = [URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "client_id", value: clientId),
                     URLQueryItem(name: "redirect_uri", value: redirectURI), URLQueryItem(name: "scope", value: c.scope ?? "openid profile email"),
                     URLQueryItem(name: "state", value: state), URLQueryItem(name: "nonce", value: nonce),
                     URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "S256")]
        if let r = c.resource, !r.isEmpty { items.append(URLQueryItem(name: "resource", value: r)) }
        comps.queryItems = (comps.queryItems ?? []) + items
        guard let url = comps.url else { throw Failure(message: "Kimlik sağlayıcısı adresi geçersiz.") }

        let callback = try await browser(url)
        let q = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (n: String) in q.first { $0.name == n }?.value }
        if let err = value("error") { throw Failure(message: "Giriş tamamlanmadı: \(value("error_description") ?? err).") }
        guard value("state") == state, let code = value("code") else { throw Failure(message: "Giriş yanıtı bu isteğe ait değil; tekrar deneyin.") }

        var form = ["grant_type": "authorization_code", "code": code, "redirect_uri": redirectURI, "client_id": clientId, "code_verifier": verifier]
        if let r = c.resource, !r.isEmpty { form["resource"] = r }
        let tokens = try await token(tokenUrl, form: form, previous: nil)
        // Belirteç uç noktasından TLS ile doğrudan alındı; nonce kimlik belirtecinde eşleşmeli (yeniden oynatma).
        if let id = tokens.idToken, claims(id)["nonce"] as? String != nonce { throw Failure(message: "Kimlik belirteci doğrulanamadı; tekrar deneyin.") }
        return tokens
    }

    static func refresh(config c: AuthConfig, tokens: TokenSet) async throws -> TokenSet {
        guard let rt = tokens.refreshToken, let clientId = c.nativeClientId, let tokenUrl = c.tokenEndpoint else { throw Failure(message: "Oturumun süresi doldu; yeniden giriş yapın.") }
        return try await token(tokenUrl, form: ["grant_type": "refresh_token", "refresh_token": rt, "client_id": clientId], previous: tokens)
    }

    /// Çıkışta yenileme belirteci IdP'de iptal edilir (RFC 7009); tarayıcı açılmaz. Başarısızlık yerel çıkışı engellemez.
    static func revoke(config c: AuthConfig, tokens: TokenSet) async {
        guard let e = c.revocationEndpoint, let url = URL(string: e), let clientId = c.nativeClientId, let rt = tokens.refreshToken else { return }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 15
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var allowed = CharacterSet.urlQueryAllowed; allowed.remove(charactersIn: "+&=/?")
        let enc = { (v: String) in v.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
        r.httpBody = Data("token=\(enc(rt))&token_type_hint=refresh_token&client_id=\(enc(clientId))".utf8)
        _ = try? await URLSession.shared.data(for: r)
    }

    private static func token(_ endpoint: String, form: [String: String], previous: TokenSet?) async throws -> TokenSet {
        guard let url = URL(string: endpoint) else { throw Failure(message: "Kimlik sağlayıcısı adresi geçersiz.") }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 30
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var allowed = CharacterSet.urlQueryAllowed; allowed.remove(charactersIn: "+&=/?")
        r.httpBody = Data(form.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&").utf8)
        let data: Data, resp: URLResponse
        // Ağ hatası oturumu bitirmez (yenilemede çevrimdışı sayılır); yalnız IdP'nin reddi yeniden giriş ister.
        do { (data, resp) = try await URLSession.shared.data(for: r) } catch { throw previous == nil ? Failure(message: "Kimlik sağlayıcısına ulaşılamadı.") : APIError.offline() }
        struct Res: Decodable { let access_token: String; let refresh_token: String?; let id_token: String?; let expires_in: Double? }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let res = try? JSONDecoder().decode(Res.self, from: data) else {
            // Yenilemede yalnız IdP'nin açık reddi (400/401, ör. invalid_grant) oturumu bitirir; 5xx/429 gibi geçici
            // durumlar çevrimdışı sayılır, belirteçler korunur ve sonraki istekte yeniden denenir.
            if previous != nil, status != 400, status != 401 { throw APIError.offline() }
            throw Failure(message: previous == nil ? "Giriş kodu belirtece çevrilemedi; tekrar deneyin." : "Oturumun süresi doldu; yeniden giriş yapın.")
        }
        return TokenSet(accessToken: res.access_token, refreshToken: res.refresh_token ?? previous?.refreshToken, idToken: res.id_token ?? previous?.idToken,
                        expiresAt: Date().addingTimeInterval(res.expires_in ?? 300))
    }

    /// İmza doğrulaması yapılmaz (belirteç uç noktasından TLS ile geldi; API erişim belirtecini ayrıca doğrular); yalnız nonce okunur.
    private static func claims(_ jwt: String) -> [String: Any] {
        let parts = jwt.split(separator: ".")
        guard parts.count >= 2, let d = Data(base64URL: String(parts[1])), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return o
    }

    @MainActor
    private static func browser(_ url: URL) async throws -> URL {
        let anchor = PresentationAnchor()
        defer { withExtendedLifetime(anchor) {} } // sağlayıcı zayıf tutulur; oturum bitene kadar yaşamalı
        return try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: url, callback: .customScheme(redirectScheme)) { cb, err in
                if let cb { cont.resume(returning: cb); return }
                if (err as? ASWebAuthenticationSessionError)?.code == .canceledLogin { cont.resume(throwing: Failure(message: "Giriş iptal edildi.")); return }
                cont.resume(throwing: Failure(message: "Giriş penceresi açılamadı."))
            }
            s.presentationContextProvider = anchor
            // Geçici oturum: tarayıcı çerezi tutulmaz (ortak cihazda bir sonraki kişi önceki oturumla girmez); sistem onay penceresi çıkmaz.
            // Kurumsal SSO uzantısı (MDM) bu oturumda da çalışır.
            s.prefersEphemeralWebBrowserSession = true
            if !s.start() { cont.resume(throwing: Failure(message: "Giriş penceresi açılamadı.")) }
            anchor.session = s
        }
    }

    private final class PresentationAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
        var session: ASWebAuthenticationSession?
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            MainActor.assumeIsolated {
                UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
            }
        }
    }
}

extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    init?(base64URL s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        self.init(base64Encoded: b)
    }
}
