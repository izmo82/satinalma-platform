import Foundation

/// Web ile aynı sürümlü API. Kiracı seçimi başlıkla bildirilir; yetki kararı sunucudadır.
struct APIError: Error, LocalizedError, Decodable {
    let code: String
    let message: String
    var status: Int = 0
    var errorDescription: String? { message }
    enum CodingKeys: String, CodingKey { case code, message }
}

private struct ErrorEnvelope: Decodable { let error: APIError }

struct APIClient: Sendable {
    let baseURL: URL
    private let urlSession: URLSession

    init(baseURL: URL, urlSession: URLSession = .shared) {
        self.baseURL = baseURL
        self.urlSession = urlSession
    }

    func send<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: (any Encodable & Sendable)? = nil, token: String?, tenantId: String?, ifMatch: String? = nil) async throws -> (T, String?) {
        // Yol sorgu dizesi içerebilir; appending(path:) "?" karakterini kaçışlar.
        guard let url = URL(string: path, relativeTo: baseURL) else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let tenantId { request.setValue(tenantId, forHTTPHeaderField: "X-Tenant-Id") }
        if let ifMatch { request.setValue(ifMatch, forHTTPHeaderField: "If-Match") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            var err = (try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error)
                ?? APIError(code: "error", message: "İstek başarısız (\(http.statusCode)).")
            err.status = http.statusCode
            throw err
        }
        let etag = http.value(forHTTPHeaderField: "ETag")
        return (try JSONDecoder().decode(T.self, from: data), etag)
    }
}
