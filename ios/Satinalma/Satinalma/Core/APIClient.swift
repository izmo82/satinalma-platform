import Foundation

/// Web ile aynı sürümlü API. Kiracı seçimi başlıkla bildirilir; yetki ve durum kararı sunucudadır.
struct APIError: Error, LocalizedError, Decodable {
    let code: String
    let message: String
    var status: Int = 0
    var errorDescription: String? { message }
    enum CodingKeys: String, CodingKey { case code, message }

    /// Çakışma/sürüm hatası: kullanıcıya "güncel hali yükleyin" denir; eski ekrandan karar verilmez (T44).
    var isConflict: Bool { status == 409 || status == 412 || status == 428 }
    /// Ağ hatası: istek sunucuya hiç ulaşmadı; işlem kaydedilmedi.
    var isOffline: Bool { status == 0 }
    /// İstek gönderildi ama yanıt gelmedi (zaman aşımı/bağlantı koptu): sunucu kaydetmiş olabilir. Tekrar göndermeden önce yenile.
    var outcomeUnknown: Bool { status == -1 }

    static func offline() -> APIError { APIError(code: "network", message: "Sunucuya ulaşılamadı; işlem kaydedilmedi.", status: 0) }
    static func unknownOutcome() -> APIError {
        APIError(code: "unknown_outcome", message: "Yanıt alınamadı; işlem sunucuda kaydedilmiş olabilir. Ekranı yenileyip kontrol edin.", status: -1)
    }
    /// Bağlantı hiç kurulamadıysa "kaydedilmedi"; istek gönderildikten sonra koptuysa "belirsiz".
    static func from(_ error: Error) -> APIError {
        switch (error as? URLError)?.code {
        case .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .internationalRoamingOff, .dataNotAllowed: offline()
        default: unknownOutcome()
        }
    }
}

private struct ErrorEnvelope: Decodable { let error: APIError }

struct APIClient: Sendable {
    let baseURL: URL
    private let urlSession: URLSession

    init(baseURL: URL, urlSession: URLSession = .shared) {
        self.baseURL = baseURL
        self.urlSession = urlSession
    }

    private func request(_ path: String, method: String, token: String?, tenantId: String?, ifMatch: String?) throws -> URLRequest {
        // Yol sorgu dizesi içerebilir; appending(path:) "?" karakterini kaçışlar.
        guard let url = URL(string: path, relativeTo: baseURL) else { throw URLError(.badURL) }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.timeoutInterval = 30
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let tenantId { r.setValue(tenantId, forHTTPHeaderField: "X-Tenant-Id") }
        if let ifMatch { r.setValue(ifMatch, forHTTPHeaderField: "If-Match") }
        return r
    }

    private func perform(_ r: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data, response: URLResponse
        do { (data, response) = try await urlSession.data(for: r) } catch { throw APIError.from(error) }
        guard let http = response as? HTTPURLResponse else { throw APIError.offline() }
        guard (200..<300).contains(http.statusCode) else {
            var err = (try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error)
                ?? APIError(code: "error", message: "İstek başarısız (\(http.statusCode)).")
            err.status = http.statusCode
            throw err
        }
        return (data, http)
    }

    func send<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: (any Encodable & Sendable)? = nil, token: String?, tenantId: String?, ifMatch: String? = nil, idempotencyKey: String? = nil) async throws -> (T, String?) {
        var r = try request(path, method: method, token: token, tenantId: tenantId, ifMatch: ifMatch)
        if let idempotencyKey { r.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONEncoder().encode(body)
        }
        let (data, http) = try await perform(r)
        let etag = http.value(forHTTPHeaderField: "ETag")
        if T.self == Empty.self { return (Empty() as! T, etag) }
        return (try JSONDecoder().decode(T.self, from: data), etag)
    }

    /// Belge baytları (önizleme için). Özgün dosya değiştirilmez; hash istemcide yeniden hesaplanır.
    func data(_ path: String, token: String?, tenantId: String?) async throws -> (Data, String?) {
        let (data, http) = try await perform(try request(path, method: "GET", token: token, tenantId: tenantId, ifMatch: nil))
        return (data, http.value(forHTTPHeaderField: "Content-Type"))
    }

    /// Çok parçalı belge yükleme (web ile aynı uç). Sunucu aynı baytları hash ile tekilleştirir: tekrar yükleme yeni kayıt açmaz (T43).
    func upload<T: Decodable & Sendable>(_ path: String, fields: [String: String], fileName: String, mimeType: String, file: Data, token: String?, tenantId: String?) async throws -> T {
        var r = try request(path, method: "POST", token: token, tenantId: tenantId, ifMatch: nil)
        let boundary = "sp-\(UUID().uuidString)"
        r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        r.timeoutInterval = 120
        var body = Data()
        for (k, v) in fields.sorted(by: { $0.key < $1.key }) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n".utf8))
        }
        let safeName = fileName.replacingOccurrences(of: "\"", with: "")
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(mimeType)\r\n\r\n".utf8))
        body.append(file)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        r.httpBody = body
        let (data, _) = try await perform(r)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

/// Gövdesi önemsiz yanıtlar için.
struct Empty: Decodable, Sendable {}
