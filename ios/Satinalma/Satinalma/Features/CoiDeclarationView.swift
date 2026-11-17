import SwiftUI

extension Notification.Name {
    /// Beyan verilince İşlerim yeniden yüklenir; görev listeden düşer.
    static let tasksChanged = Notification.Name("satinalma.tasksChanged")
}

/// Çıkar çatışması beyanı (v2 Faz 7, R11): proje adı, "Çıkar çatışmam yok" / "Çıkar çatışmam var" (açıklama en az 10 karakter).
/// Sunucu: GET/POST /api/v1/projects/:id/coi. Beyan eklenir, silinmez; son beyan geçerlidir.
struct CoiDeclarationView: View {
    let projectId: String
    let title: String
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var info: CoiInfo?
    @State private var error: Notice?
    @State private var kind: String?
    @State private var statement = ""
    @State private var sending = false
    @State private var notice: Notice?
    @State private var done = false
    private static let maxChars = 4000

    private var trimmed: String { statement.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { kind == "NONE" || (kind == "DECLARED" && trimmed.count >= 10) }

    struct CoiInfo: Decodable, Sendable {
        struct Latest: Decodable, Sendable { let kindLabel: String?; let statement: String?; let declaredAt: String? }
        struct Me: Decodable, Sendable { let participant: Bool?; let canDeclare: Bool?; let latest: Latest? }
        let me: Me?
    }
    private struct DeclBody: Encodable, Sendable { let kind: String; let statement: String? }

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Section {
                Text(verbatim: title).font(.headline).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                Text("Bu projenin değerlendirme ya da karar sürecinde yer aldınız. Lütfen çıkar çatışmanız olup olmadığını beyan edin.").font(.subheadline).foregroundStyle(.secondary)
            } header: { Text("Proje") }
            if let l = info?.me?.latest, let label = l.kindLabel {
                Section("Önceki beyanınız") {
                    Text([label, l.declaredAt.map { Fmt.date($0) }].compactMap { $0 }.joined(separator: " · ")).font(.subheadline)
                    if let s = l.statement, !s.isEmpty { Text(s).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            if done {
                Section { Label("Beyanınız kaydedildi.", systemImage: "checkmark.circle").foregroundStyle(.green) }
            } else if info == nil && error != nil {
                // Bilgi alınamadı: form gösterilmez, hata ve yeniden deneme.
            } else if info?.me?.canDeclare == false {
                Section { Text("Bu proje için beyan verme yetkiniz yok; beyan web uygulamasında ilgili kişi tarafından verilir.").font(.footnote).foregroundStyle(.secondary) }
            } else {
                Section {
                    choice("NONE", "Çıkar çatışmam yok")
                    choice("DECLARED", "Çıkar çatışmam var")
                    if kind == "DECLARED" {
                        TextField("Açıklama (en az 10 karakter)", text: $statement, axis: .vertical).lineLimit(3...8)
                            .accessibilityLabel("Çıkar çatışması açıklaması")
                            .accessibilityHint("En az 10 karakter gerekli.")
                            .onChange(of: statement) { _, v in if v.count > Self.maxChars { statement = String(v.prefix(Self.maxChars)) } }
                        if !trimmed.isEmpty && trimmed.count < 10 { Text("Açıklama en az 10 karakter olmalı.").font(.footnote).foregroundStyle(.orange) }
                    }
                } header: { Text("Beyanınız") }
                Section {
                    if let notice { NoticeView(notice: notice) }
                    Button(sending ? "Gönderiliyor…" : "Beyanı gönder") { Task { await send() } }
                        .disabled(!canSend || sending || !session.isOnline)
                }
            }
            if let error, info == nil { Section { NoticeView(notice: error); Button("Yeniden dene") { Task { await load() } } } }
        }
        .navigationTitle("Çıkar çatışması beyanı").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .task(id: done) {
            // Başarı sonrası kısa gösterim; görünüm kapanırsa görev iptal olur.
            guard done else { return }
            try? await Task.sleep(for: .milliseconds(900))
            if !Task.isCancelled { dismiss() }
        }
    }

    private func choice(_ value: String, _ label: String) -> some View {
        Button { kind = value } label: {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: kind == value ? "largecircle.fill.circle" : "circle").foregroundStyle(kind == value ? Color.accentColor : .secondary)
                Text(label).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityLabel(label).accessibilityAddTraits(kind == value ? [.isSelected] : [])
    }

    private func load() async {
        do { let (i, _): (CoiInfo, String?) = try await session.get("/api/v1/projects/\(projectId)/coi"); info = i; error = nil }
        catch { self.error = Notice.from(error) }
    }

    private func send() async {
        guard let kind, canSend, !sending else { return }
        sending = true; defer { sending = false }
        do {
            let _: Empty = try await session.post("/api/v1/projects/\(projectId)/coi", body: DeclBody(kind: kind, statement: kind == "DECLARED" ? trimmed : nil))
            done = true; notice = nil
            NotificationCenter.default.post(name: .tasksChanged, object: nil)
        } catch { notice = Notice.formResult(error) }
    }
}
