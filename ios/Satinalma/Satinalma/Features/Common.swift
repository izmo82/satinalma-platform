import SwiftUI

/// Hata ve durum mesajı: çakışmada "güncel hali yükleyin", çevrimdışında "kaydedilmedi" denir; başarı gibi gösterilmez.
struct Notice: Equatable {
    enum Tone { case info, warn, error }
    let tone: Tone
    let text: String

    static func from(_ error: Error) -> Notice {
        if let e = error as? APIError {
            // Aynı tekrar anahtarı farklı içerikle: kayıt değişmedi, yalnız sunucunun açıklaması gösterilir.
            if e.code == "idempotency_mismatch" { return Notice(tone: .warn, text: e.message) }
            if e.isConflict { return Notice(tone: .warn, text: "\(e.message) Kayıt güncellendi; ekran yenilendi, kararı yeniden gözden geçirin.") }
            if e.outcomeUnknown { return Notice(tone: .warn, text: e.message) }
            return Notice(tone: e.isOffline ? .warn : .error, text: e.message)
        }
        return Notice(tone: .error, text: error.localizedDescription)
    }

    /// Açık kalan form için: belirsiz sonuçta ekran yenileme değil, aynı içerikle güvenli tekrar gönderim önerilir.
    static func formResult(_ error: Error) -> Notice {
        if let e = error as? APIError, e.outcomeUnknown {
            return Notice(tone: .warn, text: "Yanıt alınamadı; kayıt sunucuda oluşmuş olabilir. \"Tekrar gönder\" güvenlidir: aynı içerik ikinci kayıt açmaz. Alanlar bu yüzden kilitli; vazgeçerseniz listeyi yenileyip kontrol edin.")
        }
        return from(error)
    }
}

struct NoticeView: View {
    let notice: Notice
    var body: some View {
        Label(notice.text, systemImage: notice.tone == .info ? "checkmark.circle" : notice.tone == .warn ? "exclamationmark.triangle" : "xmark.octagon")
            .foregroundStyle(notice.tone == .info ? Color.green : notice.tone == .warn ? Color.orange : Color.red)
            .font(.subheadline)
            .accessibilityAddTraits(.isStaticText)
    }
}

/// Çevrimdışı uyarısı: okunan veriler gösterilebilir ama karar ve kabul gönderilmez.
struct OfflineBanner: View {
    @Environment(SessionStore.self) private var session
    var body: some View {
        if !session.isOnline {
            Label("Çevrimdışı: onay, kabul ve imza kararı gönderilemez. Taramalar şifreli taslak olarak saklanır.", systemImage: "wifi.slash")
                .font(.footnote).padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.15)).accessibilityElement(children: .combine)
        }
    }
}

/// Yüklenen veri durumu: yükleniyor / hata / boş / içerik.
struct Loadable<T: Sendable, Content: View>: View {
    let value: T?
    let error: Notice?
    let retry: () async -> Void
    @ViewBuilder let content: (T) -> Content
    var body: some View {
        if let value { content(value) }
        else if let error {
            ContentUnavailableView {
                Label("Yüklenemedi", systemImage: "exclamationmark.triangle")
            } description: { Text(error.text) } actions: { Button("Yeniden dene") { Task { await retry() } } }
        } else {
            ProgressView("Yükleniyor").frame(maxWidth: .infinity, minHeight: 120)
        }
    }
}

/// Erişilebilirlik metin boyutlarında yatay satırı dikeye çevirir: kelimeler bölünmez, kontrol kaybolmaz (T41, 04 Dynamic Type).
struct AdaptiveStack<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var size
    var spacing: CGFloat = 6
    @ViewBuilder let content: () -> Content
    var body: some View {
        if size.isAccessibilitySize { VStack(alignment: .leading, spacing: spacing, content: content) }
        else { HStack(spacing: spacing, content: content) }
    }
}

/// Yalnız yatay düzende boşluk bırakır; dikey (erişilebilirlik) düzende yer kaplamaz.
struct HSpacer: View {
    @Environment(\.dynamicTypeSize) private var size
    var body: some View { if !size.isAccessibilitySize { Spacer(minLength: 0) } }
}
