import CryptoKit
import PDFKit
import SwiftUI

/// Kaynak belge önizlemesi: sunucudaki özgün baytlar indirilir ve yalnız ekranda çizilir; dosya değiştirilmez.
/// İstemci SHA-256'yı yeniden hesaplar ve kayıtlı hash ile karşılaştırır (T46).
struct DocumentPreview: View {
    let documentVersionId: String
    let expectedSha256: String?
    let title: String
    /// v2 Faz 4: öneri/bulgu kaynağı sayfası (1'den başlar); verilmezse ilk sayfa.
    var page: Int? = nil
    @Environment(SessionStore.self) private var session
    @State private var pdf: PDFDocument?
    @State private var image: UIImage?
    @State private var sha: String?
    @State private var error: Notice?

    var body: some View {
        VStack(spacing: 0) {
            if let sha {
                let ok = expectedSha256.map { $0 == sha }
                // Karşılaştırılacak kayıtlı hash yoksa doğrulandı simgesi gösterilmez.
                Label(ok == nil ? "SHA-256 \(sha.prefix(12))… (karşılaştırılacak kayıtlı değer yok)" : ok! ? "Özgün dosya · hash eşleşiyor" : "Hash eşleşmiyor — belgeyi kullanmayın",
                      systemImage: ok == nil ? "number" : ok! ? "checkmark.seal" : "xmark.octagon")
                    .font(.footnote).foregroundStyle(ok == false ? Color.red : Color.secondary).padding(8)
            }
            if let page, pdf != nil { Text("Sayfa \(page)").font(.footnote.weight(.semibold)).padding(.bottom, 4) }
            if let pdf { PDFKitView(document: pdf, page: page).accessibilityLabel("\(title) belge önizlemesi") }
            else if let image { ScrollView([.horizontal, .vertical]) { Image(uiImage: image).resizable().scaledToFit() }.accessibilityLabel("\(title) görüntüsü") }
            else if let error { ContentUnavailableView("Belge açılamadı", systemImage: "doc.questionmark", description: Text(error.text)) }
            else { ProgressView("Belge yükleniyor").frame(maxHeight: .infinity) }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                let (data, type) = try await session.data("/api/v1/document-versions/\(documentVersionId)/content")
                sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                if type?.contains("pdf") == true { pdf = PDFDocument(data: data) } else if let img = UIImage(data: data) { image = img }
                else { error = Notice(tone: .warn, text: "Bu belge türü (örn. XML) mobilde önizlenmez; webde açın.") }
            } catch { self.error = Notice.from(error) }
        }
    }
}

struct PDFKitView: UIViewRepresentable {
    let document: PDFDocument
    var page: Int? = nil
    func makeUIView(context: Context) -> PagedPDFView {
        let v = PagedPDFView(); v.autoScales = true; v.displayMode = .singlePageContinuous; v.document = document
        v.pendingPage = page
        return v
    }
    func updateUIView(_ v: PagedPDFView, context: Context) {
        if v.document !== document { v.document = document; v.pendingPage = page; v.appliedPage = nil }
        // Sayfa değişince yeniden atlanır (ör. başka bir bulgunun sayfası).
        if page != v.appliedPage { v.pendingPage = page }
        v.applyPendingPageIfReady()
    }
}

/// v2 Faz 4: PDFView yerleşim yapılmadan `go(to:)` çağrılırsa ilk sayfada kalır. Sayfaya geçiş pencereye bağlanıp
/// boyut aldıktan sonra (yerleşimde, ana kuyrukta) yapılır.
final class PagedPDFView: PDFView {
    var pendingPage: Int?
    var appliedPage: Int?
    override func didMoveToWindow() { super.didMoveToWindow(); applyPendingPageIfReady() }
    override func layoutSubviews() { super.layoutSubviews(); applyPendingPageIfReady() }
    func applyPendingPageIfReady() {
        guard let target = pendingPage, window != nil, bounds.width > 0, bounds.height > 0 else { return }
        pendingPage = nil
        DispatchQueue.main.async { [weak self] in
            guard let self, let doc = self.document, target >= 1, let p = doc.page(at: min(target, doc.pageCount) - 1) else { return }
            self.go(to: p)
            self.appliedPage = target
        }
    }
}
