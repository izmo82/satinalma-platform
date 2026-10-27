import SwiftUI

struct RootView: View {
    @Environment(SessionStore.self) private var session

    var body: some View {
        Group {
            if session.me != nil {
                MainTabs()
            } else {
                LoginView()
            }
        }
        .task { await session.refresh() }
    }
}

/// Webin küçültülmüş hali değil: görev, tarama, kayıtlar ve ayarlar odaklı.
struct MainTabs: View {
    var body: some View {
        TabView {
            Tab("İşlerim", systemImage: "tray") { NavigationStack { TasksView() } }
            Tab("Tara", systemImage: "doc.viewfinder") { NavigationStack { ScanPlaceholderView() } }
            Tab("Daha fazla", systemImage: "ellipsis.circle") { NavigationStack { MoreView() } }
        }
    }
}

struct LoginView: View {
    @Environment(SessionStore.self) private var session
    private let users = ["leyla.hukuk@example.test", "alper.satinalma@example.test", "mine.anaveri@example.test"]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label("Geliştirme oturumu — sentetik kullanıcılar. Üretimde kurumsal kimlik sağlayıcısı kullanılır.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                Section("Kullanıcı") {
                    ForEach(users, id: \.self) { email in
                        Button(email) { Task { await session.devLogin(email: email) } }
                            .disabled(session.isLoading)
                    }
                }
                if let err = session.lastError {
                    Section { Text(err).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Satınalma")
        }
    }
}

struct TasksView: View {
    @Environment(SessionStore.self) private var session
    @State private var tasks: [TaskItem] = []
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        List {
            if let error {
                ContentUnavailableView("Görevler yüklenemedi", systemImage: "wifi.exclamationmark", description: Text(error))
            } else if !loading && tasks.isEmpty {
                ContentUnavailableView("Bekleyen işiniz yok", systemImage: "tray")
            }
            ForEach(tasks) { task in
                NavigationLink(value: task) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(Labels.severity[task.severity] ?? task.severity).font(.caption).foregroundStyle(task.severity == "NORMAL" ? Color.secondary : Color.orange)
                        Text(task.title).font(.body.weight(.semibold))
                        Text(task.reason).font(.subheadline).foregroundStyle(.secondary)
                        Text(task.nextAction).font(.footnote)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .overlay { if loading { ProgressView("Yükleniyor") } }
        .navigationTitle("İşlerim")
        .navigationDestination(for: TaskItem.self) { task in
            if task.entityType == "contract_version" { SignatureStatusView(contractVersionId: task.entityId) }
            else { Text("Bu kayıt türü için mobil ekran henüz yok; webde açın.").padding() }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            let (list, _): (TaskList, String?) = try await session.get("/api/v1/tasks?view=mine")
            tasks = list.items; error = nil
        } catch { self.error = error.localizedDescription }
        loading = false
    }
}

extension TaskItem: Hashable {
    static func == (a: TaskItem, b: TaskItem) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

/// Salt okunur imza durumu: taraf listesi ve ayrı katmanlar. Karar verme çevrimiçi sürüm kilidiyle (Faz 6).
struct SignatureStatusView: View {
    let contractVersionId: String
    @Environment(SessionStore.self) private var session
    @State private var data: SignatureStatusResponse?
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if let s = data {
                Section("Durum") {
                    LabeledContent("Sonuç", value: Labels.overall[s.status.overall] ?? s.status.overall)
                    LabeledContent("Otomatik tarama", value: Labels.detection[s.status.automaticCheck] ?? s.status.automaticCheck)
                    LabeledContent("Fiziksel asıl", value: Labels.custody[s.status.custody] ?? s.status.custody)
                    Text("İmza görüntüsü teyidi; ıslak mürekkep, kimlik/yetki veya hukuki geçerlilik kararı değildir.").font(.footnote).foregroundStyle(.secondary)
                }
                Section("Taraflar") {
                    ForEach(s.status.requirements) { r in
                        LabeledContent(r.partyName, value: Labels.requirement[r.state] ?? r.state)
                    }
                }
                if !s.status.blockers.isEmpty {
                    Section("Tamamlanmak için") {
                        ForEach(Array(s.status.blockers.enumerated()), id: \.offset) { _, b in
                            Text("\(b.partyName.map { "\($0): " } ?? "")\(b.action)").font(.subheadline)
                        }
                    }
                }
            }
        }
        .navigationTitle(data?.contractVersion.title ?? "İmza kontrolü")
        .task {
            do { (data, _) = try await session.get("/api/v1/contract-versions/\(contractVersionId)/signature-status") }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct ScanPlaceholderView: View {
    var body: some View {
        ContentUnavailableView("Belge tarama Faz 6'da", systemImage: "doc.viewfinder",
                               description: Text("VisionKit ile çok sayfalı tarama, şifreli çevrimdışı taslak ve tekrar yükleme bu ekrana gelecek."))
            .navigationTitle("Tara")
    }
}

struct MoreView: View {
    @Environment(SessionStore.self) private var session
    var body: some View {
        List {
            if let me = session.me {
                Section("Oturum") {
                    LabeledContent("Kullanıcı", value: me.user.displayName)
                    LabeledContent("Kiracı", value: me.memberships.first { $0.tenantId == me.activeTenantId }?.tenantName ?? "—")
                }
            }
            Button("Çıkış", role: .destructive) { session.logout() }
        }
        .navigationTitle("Daha fazla")
    }
}
