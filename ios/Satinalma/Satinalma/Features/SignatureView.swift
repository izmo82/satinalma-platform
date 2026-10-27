import SwiftUI

/// İmza inceleme görevi (T45). Karar, okunan sürümün ETag'i ve belge hash'iyle gönderilir: arada yeni sürüm veya karar
/// geldiyse sunucu 409/412 döner ve ekran yenilenir (T44). Islak imza çizilmez/kopyalanmaz; yalnız görüntü teyidi.
struct SignatureView: View {
    let contractVersionId: String
    @Environment(SessionStore.self) private var session
    @State private var data: SignatureStatusResponse?
    @State private var etag: String?
    @State private var error: Notice?
    @State private var notice: Notice?
    @State private var reviewing: (SignatureStatusResponse.Requirement, Int)?

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            if let notice { NoticeView(notice: notice) }
            Loadable(value: data, error: error, retry: load) { s in
                // Uzun sözleşme adları gezinme başlığında kesilir; tam ad içerikte gösterilir.
                Text(s.contractVersion.title).font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader).listRowBackground(Color.clear)
                Section("Durum") {
                    LabeledContent("Sonuç", value: Labels.overall[s.status.overall] ?? s.status.overall)
                    LabeledContent("Otomatik tarama", value: Labels.detection[s.status.automaticCheck] ?? s.status.automaticCheck)
                    LabeledContent("Fiziksel asıl", value: Labels.custody[s.status.custody] ?? s.status.custody)
                    Text("İmza görüntüsü teyidi; ıslak mürekkep, kimlik/yetki veya hukuki geçerlilik kararı değildir.").font(.footnote).foregroundStyle(.secondary)
                }
                Section("Kaynak belge") {
                    NavigationLink("Özgün belgeyi aç (v\(s.contractVersion.versionNo))") {
                        DocumentPreview(documentVersionId: s.contractVersion.documentVersionId, expectedSha256: s.contractVersion.documentSha256, title: s.contractVersion.title)
                    }
                }
                Section("Taraflar") {
                    ForEach(s.status.requirements) { r in
                        VStack(alignment: .leading, spacing: 6) {
                            LabeledContent(r.partyName, value: Labels.requirement[r.state] ?? r.state)
                            if r.slots.isEmpty {
                                // e-imza veya sınıflandırılmamış yöntem: görüntü kararı verilmez; doğrulama/sınıflandırma webde hukuktadır.
                                Text("Bu taraf için görüntü incelemesi yok (e-imza doğrulaması veya yöntem sınıflandırması gerekiyor). Bu adım web uygulamasında yapılır.")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                            ForEach(r.slots, id: \.slot) { sl in
                                AdaptiveStack {
                                    Text("İmza \(sl.slot): \(Labels.decision[sl.decision] ?? sl.decision)\(sl.observedMark.map { " · \(Labels.mark[$0] ?? $0)" } ?? "")").font(.footnote)
                                    HSpacer()
                                    if canReview(s) {
                                        Button("Karar ver") { reviewing = (r, sl.slot) }.buttonStyle(.bordered).controlSize(.small)
                                            .accessibilityLabel("\(r.partyName) imza \(sl.slot) için karar ver")
                                    }
                                }
                            }
                        }
                    }
                }
                if !s.status.blockers.isEmpty {
                    Section("Tamamlanmak için") {
                        ForEach(Array(s.status.blockers.enumerated()), id: \.offset) { _, b in
                            Text("\(b.partyName.map { "\($0): " } ?? "")\(b.action)").font(.subheadline)
                        }
                    }
                }
                if s.contractVersion.finalizedAt != nil || s.contractVersion.supersededById != nil {
                    Section { Text(s.contractVersion.supersededById != nil ? "Bu sürümün yerini yenisi aldı; karar verilemez." : "İnceleme kesinleşti; yalnız okunur.").font(.footnote) }
                }
            }
        }
        .navigationTitle("İmza kontrolü").navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: Binding(get: { reviewing != nil }, set: { if !$0 { reviewing = nil } })) {
            if let (req, slot) = reviewing, let s = data {
                ReviewSheet(partyName: req.partyName, slot: slot) { body in
                    do {
                        let _: Empty = try await session.post("/api/v1/contract-versions/\(s.contractVersion.id)/signature-reviews",
                            body: ReviewBody(requirementId: req.id, slot: slot, decision: body.decision, observedMark: body.mark, rationale: body.rationale,
                                             page: body.page, documentSha256: s.contractVersion.documentSha256), ifMatch: etag)
                        notice = Notice(tone: .info, text: "İnceleme kararı kaydedildi.")
                        reviewing = nil
                    } catch {
                        notice = Notice.from(error); reviewing = nil
                    }
                    await load()
                }
            }
        }
    }

    private func canReview(_ s: SignatureStatusResponse) -> Bool {
        s.can.review && session.isOnline && s.contractVersion.finalizedAt == nil && s.contractVersion.supersededById == nil
    }

    private func load() async {
        do { (data, etag) = try await session.get("/api/v1/contract-versions/\(contractVersionId)/signature-status"); error = nil }
        catch { self.error = Notice.from(error) }
    }
}

private struct ReviewBody: Encodable, Sendable {
    let requirementId: String; let slot: Int; let decision: String; let observedMark: String; let rationale: String; let page: Int?; let documentSha256: String
}

struct ReviewInput { let decision: String; let mark: String; let rationale: String; let page: Int? }

struct ReviewSheet: View {
    let partyName: String
    let slot: Int
    let submit: (ReviewInput) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var decision = ""
    @State private var mark = ""
    @State private var rationale = ""
    @State private var page = ""
    @State private var busy = false

    private var marks: [String] { decision == "IMAGE_CONFIRMED" ? ["FULL_SIGNATURE"] : ["NONE", "STAMP_ONLY", "INITIALS_ONLY", "NAME_ONLY", "ILLEGIBLE", "FULL_SIGNATURE"] }

    var body: some View {
        NavigationStack {
            Form {
                Section("Karar") {
                    Picker("Karar", selection: $decision) {
                        Text("Seçin").tag("")
                        ForEach(["IMAGE_CONFIRMED", "MISSING", "UNCLEAR"], id: \.self) { Text(Labels.decision[$0]!).tag($0) }
                    }
                    Picker("Gözlenen işaret", selection: $mark) {
                        Text("Seçin").tag("")
                        ForEach(marks, id: \.self) { Text(Labels.mark[$0]!).tag($0) }
                    }
                    .disabled(decision.isEmpty)
                    TextField("Sayfa (varsa)", text: $page).keyboardType(.numberPad)
                }
                Section("Gerekçe") {
                    TextField("Ne görüldü, hangi sayfada", text: $rationale, axis: .vertical).lineLimit(3...6)
                }
                Section { Text("Karar, gözlenen işaret ve gerekçe (en az 3 karakter) zorunlu. Kaşe, paraf veya yazılı isim tam imza sayılmaz. Karar incelenen belge sürümüne bağlıdır.").font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle("\(partyName) · imza \(slot)")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: decision) { _, d in if d == "IMAGE_CONFIRMED" { mark = "FULL_SIGNATURE" } else if mark == "FULL_SIGNATURE" { mark = "" } }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Kaydet") { busy = true; Task { await submit(ReviewInput(decision: decision, mark: mark, rationale: rationale, page: Int(page))); busy = false } }
                        .disabled(busy || decision.isEmpty || mark.isEmpty || rationale.trimmingCharacters(in: .whitespaces).count < 3)
                }
            }
        }
    }
}
