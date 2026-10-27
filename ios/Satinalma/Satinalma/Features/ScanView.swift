import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import VisionKit

/// Tara (04 iOS): çok sayfalı tarama (kamera, fotoğraflar veya PDF), sayfa döndürme/silme, kalite kontrolü, şifreli taslak ve
/// tekrar yükleme. Taslak sunucu başarıyı bildirmeden silinmez; aynı dosyanın tekrar yüklenmesi yeni kayıt açmaz (T43).
struct ScanView: View {
    @Environment(SessionStore.self) private var session
    @Environment(DraftStore.self) private var drafts
    @State private var pages: [ScanPage] = []
    @State private var importedPDF: Data?
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var notice: Notice?
    @State private var removing: Draft?

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            if let notice { NoticeView(notice: notice) }
            if pages.isEmpty && importedPDF == nil {
                Section {
                    if VNDocumentCameraViewController.isSupported {
                        Button { showCamera = true } label: { Label("Kamerayla tara", systemImage: "camera.viewfinder") }
                    } else {
                        Label("Bu cihazda belge kamerası yok; fotoğraf veya PDF seçin.", systemImage: "camera").font(.footnote).foregroundStyle(.secondary)
                    }
                    PhotosPicker(selection: $photoItems, maxSelectionCount: 30, matching: .images) { Label("Fotoğraflardan seç", systemImage: "photo.on.rectangle") }
                    Button { showFiles = true } label: { Label("PDF dosyası seç", systemImage: "doc") }
                } footer: { Text("Belge önce bu cihazda şifreli taslak olarak saklanır; bağlantı varsa hemen yüklenir, yoksa bağlantı gelince.") }
            } else {
                ScanComposer(pages: $pages, importedPDF: $importedPDF) { pdf, count, title, kind, company in
                    do {
                        guard let me = session.me, let tenant = session.tenantId else { return }
                        let d = try drafts.add(pdf: pdf, title: title, kind: kind, company: company, pageCount: count, userId: me.user.id, tenantId: tenant)
                        pages = []; importedPDF = nil
                        notice = Notice(tone: .info, text: session.isOnline ? "Taslak şifreli olarak kaydedildi; yükleniyor." : "Çevrimdışı: taslak şifreli olarak saklandı; bağlantı gelince yüklenir.")
                        if session.isOnline {
                            await drafts.upload(d.id, session: session)
                            if let r = drafts.drafts.first(where: { $0.id == d.id }) {
                                notice = r.state == .uploaded ? Notice(tone: .info, text: "Yüklendi: \(r.serverMessage ?? "")") : Notice(tone: .warn, text: r.lastError ?? "Yüklenmedi; taslak korunuyor.")
                            }
                        }
                    } catch { notice = Notice(tone: .error, text: "Taslak kaydedilemedi: \(error.localizedDescription)") }
                }
            }
            Section("Taslaklar ve yüklemeler") {
                if let reason = drafts.unavailableReason { Label(reason, systemImage: "lock").font(.footnote).foregroundStyle(.orange) }
                let mine = drafts.visible(userId: session.me?.user.id, tenantId: session.tenantId)
                if mine.isEmpty { Text("Taslak yok.").foregroundStyle(.secondary) }
                ForEach(mine) { d in DraftRow(draft: d, onUpload: { Task { await drafts.upload(d.id, session: session) } }, onRemove: { removing = d }) }
            }
        }
        .navigationTitle("Tara")
        .fullScreenCover(isPresented: $showCamera) { DocumentCamera { imgs in pages = imgs.map { ScanPage(image: $0) } } .ignoresSafeArea() }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.pdf]) { result in
            guard case .success(let url) = result else { return }
            let ok = url.startAccessingSecurityScopedResource(); defer { if ok { url.stopAccessingSecurityScopedResource() } }
            importedPDF = try? Data(contentsOf: url)
        }
        .onChange(of: photoItems) { _, items in
            // Seçim temizlenince (aşağıda) yeniden tetiklenir; boş seçim sayfaları silmemeli.
            guard !items.isEmpty else { return }
            Task {
                var out: [ScanPage] = []
                for i in items { if let data = try? await i.loadTransferable(type: Data.self), let img = UIImage(data: data) { out.append(ScanPage(image: img)) } }
                pages = out; photoItems = []
            }
        }
        .confirmationDialog("Taslağı sil", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Sil", role: .destructive) {
                if let d = removing, !drafts.remove(d.id) { notice = Notice(tone: .warn, text: "Taslak şu an yükleniyor; silinemez. Yükleme bitince tekrar deneyin.") }
            }
        } message: { Text(removing?.state == .uploaded ? "Yükleme kaydı listeden kaldırılır; sunucudaki belge etkilenmez." : "Bu taslak henüz yüklenmedi; silinirse geri getirilemez.") }
    }
}

struct ScanPage: Identifiable {
    let id = UUID()
    var image: UIImage
    var rotation = 0
    /// Kalite: kısa kenarı 1000 pikselden küçük sayfa metni okunamayabilir (uyarı; engel değil).
    var lowResolution: Bool { min(image.size.width * image.scale, image.size.height * image.scale) < 1000 }
}

struct ScanComposer: View {
    @Binding var pages: [ScanPage]
    @Binding var importedPDF: Data?
    let save: (Data, Int, String, String, Me.Company) async -> Void
    @Environment(SessionStore.self) private var session
    @State private var title = ""
    @State private var kind = "INVOICE"
    @State private var companyId = ""
    @State private var busy = false
    private let maxBytes = 25 * 1024 * 1024
    private var companies: [Me.Company] { session.me?.companies ?? [] }

    var body: some View {
        Section("Sayfalar") {
            if let pdf = importedPDF { Label("PDF seçildi · \(ByteCountFormatter.string(fromByteCount: Int64(pdf.count), countStyle: .file))", systemImage: "doc.fill") }
            ScrollView(.horizontal) {
                HStack(spacing: 12) {
                    ForEach(Array(pages.enumerated()), id: \.element.id) { i, p in
                        VStack(spacing: 6) {
                            Image(uiImage: p.image).resizable().scaledToFit().rotationEffect(.degrees(Double(p.rotation))).frame(width: 96, height: 128).clipped()
                                .border(p.lowResolution ? Color.orange : Color.secondary.opacity(0.3)).accessibilityLabel("Sayfa \(i + 1)\(p.lowResolution ? ", düşük çözünürlük" : "")")
                            HStack {
                                Button { pages[i].rotation = (pages[i].rotation + 90) % 360 } label: { Image(systemName: "rotate.right") }.accessibilityLabel("Sayfa \(i + 1) döndür")
                                Button(role: .destructive) { pages.remove(at: i) } label: { Image(systemName: "trash") }.accessibilityLabel("Sayfa \(i + 1) sil")
                            }.buttonStyle(.bordered).controlSize(.small)
                        }
                    }
                }.padding(.vertical, 4)
            }
            if pages.contains(where: \.lowResolution) { Label("Düşük çözünürlüklü sayfa var; metin okunamayabilir. Gerekirse yeniden tarayın.", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange) }
        }
        Section("Belge") {
            TextField("Başlık", text: $title)
            Picker("Tür", selection: $kind) { ForEach(["INVOICE", "CONTRACT", "QUOTE", "OTHER"], id: \.self) { Text(Labels.documentKind[$0]!).tag($0) } }
            Picker("Şirket", selection: $companyId) { Text("Seçin").tag(""); ForEach(companies) { Text($0.name).tag($0.id) } }
        }
        .onAppear { if companyId.isEmpty, companies.count == 1 { companyId = companies[0].id } }
        Section {
            Button { Task { await finish() } } label: { Label("Taslak olarak kaydet ve yükle", systemImage: "square.and.arrow.up") }
                .disabled(busy || title.trimmingCharacters(in: .whitespaces).count < 2 || companyId.isEmpty || (pages.isEmpty && importedPDF == nil))
            Button("Vazgeç", role: .destructive) { pages = []; importedPDF = nil }
        }
    }

    private func finish() async {
        guard let company = session.me?.companies?.first(where: { $0.id == companyId }) else { return }
        busy = true; defer { busy = false }
        let pdf = importedPDF ?? renderPDF(pages)
        guard pdf.count <= maxBytes else { return }
        await save(pdf, importedPDF != nil ? 0 : pages.count, title.trimmingCharacters(in: .whitespaces), kind, company)
    }

    /// Sayfaları A4 PDF'e çizer (döndürme uygulanır). Özgün tarama görüntüsü yerine bu PDF yüklenir ve hash'i taslakta saklanır.
    private func renderPDF(_ pages: [ScanPage]) -> Data {
        let a4 = CGRect(x: 0, y: 0, width: 595, height: 842)
        return UIGraphicsPDFRenderer(bounds: a4).pdfData { ctx in
            for p in pages {
                ctx.beginPage()
                let img = rotated(p.image, degrees: p.rotation)
                let scale = min(a4.width / img.size.width, a4.height / img.size.height)
                let size = CGSize(width: img.size.width * scale, height: img.size.height * scale)
                img.draw(in: CGRect(x: (a4.width - size.width) / 2, y: (a4.height - size.height) / 2, width: size.width, height: size.height))
            }
        }
    }

    private func rotated(_ image: UIImage, degrees: Int) -> UIImage {
        guard degrees % 360 != 0 else { return image }
        let swap = degrees % 180 != 0
        let size = swap ? CGSize(width: image.size.height, height: image.size.width) : image.size
        return UIGraphicsImageRenderer(size: size).image { c in
            c.cgContext.translateBy(x: size.width / 2, y: size.height / 2)
            c.cgContext.rotate(by: CGFloat(degrees) * .pi / 180)
            image.draw(in: CGRect(x: -image.size.width / 2, y: -image.size.height / 2, width: image.size.width, height: image.size.height))
        }
    }
}

struct DraftRow: View {
    let draft: Draft
    let onUpload: () -> Void
    let onRemove: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AdaptiveStack {
                Text(draft.title).font(.body.weight(.semibold))
                HSpacer()
                Text(state).font(.caption.weight(.semibold)).foregroundStyle(draft.state == .uploaded ? Color.green : draft.state == .failed ? Color.red : Color.orange)
            }
            Text("\(Labels.documentKind[draft.kind] ?? draft.kind) · \(draft.companyName) · \(ByteCountFormatter.string(fromByteCount: Int64(draft.byteCount), countStyle: .file))").font(.footnote).foregroundStyle(.secondary)
            if let m = draft.serverMessage { Text(m + (draft.duplicate == true ? " (Bu dosya daha önce yüklenmişti; yeni kayıt açılmadı.)" : "")).font(.footnote) }
            if let e = draft.lastError { Text(e).font(.footnote).foregroundStyle(.orange) }
            if draft.ownerUserId == nil && draft.state != .uploaded { Text("Sahibi kayıtlı olmayan eski taslak: kimin adına yükleneceği bilinmediği için yüklenmez. Yeniden tarayın veya silin.").font(.footnote).foregroundStyle(.orange) }
            HStack {
                if (draft.state == .pending || draft.state == .failed) && draft.ownerUserId != nil && !draft.companyId.isEmpty { Button(draft.attempts > 0 ? "Tekrar yükle" : "Yükle", action: onUpload).buttonStyle(.bordered) }
                if draft.state == .uploading { ProgressView() }
                Spacer()
                if draft.state == .uploaded { Button("Listeden kaldır", action: onRemove).buttonStyle(.borderless).accessibilityHint("Yalnız bu cihazdaki kaydı kaldırır; sunucudaki belge silinmez.") }
                else if draft.state != .uploading { Button("Sil", role: .destructive, action: onRemove).buttonStyle(.borderless) }
            }
        }
        .accessibilityElement(children: .contain)
    }
    private var state: String {
        switch draft.state { case .pending: "Yüklenmedi"; case .uploading: "Yükleniyor"; case .failed: "Hata"; case .uploaded: "Yüklendi" }
    }
}

/// VisionKit belge kamerası: kenar algılama, kırpma ve perspektif düzeltme sistemde yapılır.
struct DocumentCamera: UIViewControllerRepresentable {
    let onScan: ([UIImage]) -> Void
    @Environment(\.dismiss) private var dismiss
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController(); vc.delegate = context.coordinator; return vc
    }
    func updateUIViewController(_ vc: VNDocumentCameraViewController, context: Context) {}
    @MainActor final class Coordinator: NSObject, @preconcurrency VNDocumentCameraViewControllerDelegate {
        let parent: DocumentCamera
        init(_ p: DocumentCamera) { parent = p }
        func documentCameraViewController(_ c: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            parent.onScan((0..<scan.pageCount).map { scan.imageOfPage(at: $0) }); parent.dismiss()
        }
        func documentCameraViewControllerDidCancel(_ c: VNDocumentCameraViewController) { parent.dismiss() }
        func documentCameraViewController(_ c: VNDocumentCameraViewController, didFailWithError error: Error) { parent.dismiss() }
    }
}
