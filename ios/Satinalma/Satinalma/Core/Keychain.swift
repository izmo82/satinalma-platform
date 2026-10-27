import Foundation
import Security

/// Oturum belirteci yalnız Keychain'de tutulur (UserDefaults değil). Cihaz kilitliyken erişilemez.
enum Keychain {
    private static let service = "com.example.satinalma.session"

    static func save(_ value: String, account: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        var attrs = query
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(attrs as CFDictionary, nil)
    }

    enum Read { case value(String), notFound, unavailable(OSStatus) }

    /// Okuma sonucu ayrıntılı: "yok" ile "şu an okunamıyor" (cihaz kilitli vb.) ayrılır; ikincisinde anahtar asla yeniden üretilmez.
    static func read(account: String) -> Read {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return .notFound }
        guard status == errSecSuccess, let data = out as? Data, let s = String(data: data, encoding: .utf8) else { return .unavailable(status) }
        return .value(s)
    }

    /// Yalnız yoksa ekler (var olanı silmez). Başarı döner.
    static func addIfAbsent(_ value: String, account: String) -> Bool {
        let attrs: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                    kSecValueData as String: Data(value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        return SecItemAdd(attrs as CFDictionary, nil) == errSecSuccess
    }

    static func load(account: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(account: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }
}
