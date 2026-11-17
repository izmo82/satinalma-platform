import SwiftUI

/// Risk aksiyonu sahibinin işi (v2 Faz 6, bütün faz incelemesi I2): `risk_action_owner` görevi bu ekranı açar.
/// Kayıt `GET /api/v1/risk/actions/mine` içinden kimlikle bulunur; sahip "Tamamlandı" işaretler (tamamlama notu zorunlu).
struct RiskActionItem: Decodable, Identifiable, Sendable {
    struct Ref: Decodable, Sendable { let id: String?; let name: String? }
    struct Can: Decodable, Sendable { let close: Bool? }
    let id: String; let assessmentId: String?; let assessmentVisible: Bool?; let supplier: Ref?; let year: Int?
    let kind: String?; let controlMethodLabel: String?; let title: String?; let description: String?
    let dueOn: String?; let overdue: Bool?; let status: String?; let completionNote: String?; let completedAt: String?; let can: Can?
}
struct RiskActionList: Decodable, Sendable { let items: [RiskActionItem] }

struct RiskActionView: View {
    let actionId: String
    let titleHint: String
    @Environment(SessionStore.self) private var session
    @State private var item: RiskActionItem?
    @State private var loaded = false
    @State private var error: Notice?
    @State private var note = ""
    @State private var confirming = false
    @State private var sending = false
    @State private var result: Notice?

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            if let item { content(item) }
            else if loaded && error == nil {
                ContentUnavailableView("Aksiyon bulunamadı", systemImage: "questionmark.folder", description: Text("Bu aksiyon artık size atanmış değil ya da kapanmış olabilir. İşlerim'i yenileyin."))
            } else if let error {
                ContentUnavailableView { Label("Yüklenemedi", systemImage: "exclamationmark.triangle") } description: { Text(error.text) } actions: { Button("Yeniden dene") { Task { await load() } } }
            } else { ProgressView("Yükleniyor").frame(maxWidth: .infinity, minHeight: 120) }
        }
        .navigationTitle("Risk aksiyonu").navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder private func content(_ x: RiskActionItem) -> some View {
        Section {
            Text(x.title ?? titleHint).font(.title3.bold()).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            if let s = x.supplier?.name { LabeledContent("Tedarikçi", value: s) }
            if let y = x.year { LabeledContent("Yıl", value: String(y)) }
            LabeledContent("Tür", value: RiskLabels.actionKind[x.kind ?? ""] ?? "Aksiyon")
            if let m = x.controlMethodLabel, !m.isEmpty { LabeledContent("Denetim yöntemi", value: m) }
            if let d = x.description, !d.isEmpty { Text(d).font(.subheadline) }
            if let due = x.dueOn {
                LabeledContent("Son tarih") {
                    Text(x.overdue == true ? "\(Fmt.date(due)) · gecikti" : Fmt.date(due)).foregroundStyle(x.overdue == true ? Color.red : Color.primary)
                }
            }
            LabeledContent("Durum", value: RiskLabels.actionStatus[x.status ?? ""] ?? (x.status ?? "—"))
            if let n = x.completionNote, !n.isEmpty { LabeledContent("Tamamlama notu", value: n) }
        }
        if x.can?.close == true, x.status == "OPEN" {
            Section {
                TextField("Tamamlama notu (zorunlu)", text: $note, axis: .vertical).lineLimit(2...6)
                    .accessibilityLabel("Tamamlama notu, zorunlu")
                Button { confirming = true } label: { Label(sending ? "Gönderiliyor…" : "Tamamlandı", systemImage: "checkmark.circle") }
                    .disabled(sending || !session.isOnline || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .confirmationDialog("Aksiyon tamamlandı olarak işaretlensin mi?", isPresented: $confirming, titleVisibility: .visible) {
                        Button("Tamamlandı") { Task { await complete(x) } }
                        Button("Vazgeç", role: .cancel) {}
                    } message: { Text("Bu işlem geri alınamaz; ilgili görev kapanır.") }
                if let result { NoticeView(notice: result) }
            } header: { Text("Tamamla") }
        } else if let result { Section { NoticeView(notice: result) } }
        if x.assessmentVisible == true, let aid = x.assessmentId {
            Section { NavigationLink { RiskAssessmentView(assessmentId: aid, title: x.supplier?.name ?? "Risk değerlendirmesi") } label: { Label("Değerlendirme özetini gör", systemImage: "chart.bar.doc.horizontal") } }
        }
    }

    private func load() async {
        do {
            let (l, _): (RiskActionList, String?) = try await session.get("/api/v1/risk/actions/mine")
            item = l.items.first { $0.id == actionId }; error = nil; loaded = true
        } catch { self.error = Notice.from(error) }
    }

    private struct DoneBody: Encodable, Sendable { let status: String; let completionNote: String }
    private func complete(_ x: RiskActionItem) async {
        sending = true; result = nil; defer { sending = false }
        do {
            let _: Empty = try await session.post("/api/v1/risk/actions/\(x.id)", body: DoneBody(status: "DONE", completionNote: note.trimmingCharacters(in: .whitespacesAndNewlines)), method: "PATCH")
            result = Notice(tone: .info, text: "Aksiyon tamamlandı olarak kaydedildi.")
            NotificationCenter.default.post(name: .tasksChanged, object: nil)
            await load()
        } catch let e as APIError {
            result = Notice(tone: e.isOffline || e.outcomeUnknown ? .warn : .error, text: e.message)
            if e.isConflict || e.outcomeUnknown { await load() }
        } catch { result = Notice.from(error) }
    }
}
