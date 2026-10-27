import SwiftUI

struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(DraftStore.self) private var drafts

    var body: some View {
        Group {
            if session.me != nil { MainTabs() } else { LoginView() }
        }
        .task { await session.refresh() }
        // Bağlantı gelince bekleyen taslaklar yüklenir; sunucu aynı dosyayı tekilleştirir.
        .onChange(of: session.isOnline) { _, online in
            if online, session.me != nil { Task { await drafts.uploadPending(session: session) } }
        }
    }
}

/// Webin küçültülmüş hali değil: görev, tarama, kayıtlar (kabul/olay) ve ayarlar (04 iOS).
struct MainTabs: View {
    @Environment(DraftStore.self) private var drafts
    @Environment(SessionStore.self) private var session
    private var pendingCount: Int { drafts.visible(userId: session.me?.user.id, tenantId: session.tenantId).filter { $0.state != .uploaded }.count }
    var body: some View {
        TabView {
            Tab("İşlerim", systemImage: "tray") { NavigationStack { TasksView() } }
            Tab("Tara", systemImage: "doc.viewfinder") { NavigationStack { ScanView() } }
                .badge(pendingCount)
            Tab("Kayıtlar", systemImage: "list.bullet.rectangle") { NavigationStack { RecordsView() } }
            Tab("Daha fazla", systemImage: "ellipsis.circle") { NavigationStack { MoreView() } }
        }
    }
}

struct LoginView: View {
    @Environment(SessionStore.self) private var session
    private let users: [(String, String)] = [
        ("alper.satinalma@example.test", "Satınalmacı + talep sahibi"), ("leyla.hukuk@example.test", "Hukuk"),
        ("kerem.hukuk@example.test", "Hukuk + satınalma yöneticisi"), ("ferda.finans@example.test", "Finans (fatura girişi)"),
        ("nur.finansonay@example.test", "Finans (fatura onayı)"), ("selin.guvenlik@example.test", "Bilgi güvenliği"), ("mine.anaveri@example.test", "Ana veri"),
    ]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label("Geliştirme oturumu — sentetik kullanıcılar. Üretimde kurumsal kimlik sağlayıcısı kullanılır.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                Section("Kullanıcı") {
                    ForEach(users, id: \.0) { email, role in
                        Button { Task { await session.devLogin(email: email) } } label: {
                            VStack(alignment: .leading) { Text(email); Text(role).font(.footnote).foregroundStyle(.secondary) }
                        }
                        .disabled(session.isLoading)
                    }
                }
                if let err = session.lastError { Section { Text(err).foregroundStyle(.red) } }
            }
            .navigationTitle("Satınalma")
        }
    }
}

struct MoreView: View {
    @Environment(SessionStore.self) private var session
    @Environment(DraftStore.self) private var drafts
    var body: some View {
        List {
            if let me = session.me {
                Section("Oturum") {
                    LabeledContent("Kullanıcı", value: me.user.displayName)
                    LabeledContent("Roller", value: me.roles.map { Labels.role[$0] ?? $0 }.joined(separator: ", "))
                    if me.memberships.count > 1 {
                        Picker("Kiracı", selection: Binding(get: { me.activeTenantId ?? "" }, set: { id in Task { await session.switchTenant(id) } })) {
                            ForEach(me.memberships) { Text($0.tenantName).tag($0.tenantId) }
                        }
                    } else {
                        LabeledContent("Kiracı", value: me.memberships.first { $0.tenantId == me.activeTenantId }?.tenantName ?? "—")
                    }
                    LabeledContent("Şirket kapsamı", value: (me.companies ?? []).map(\.name).joined(separator: ", ").ifEmpty("Şirket erişimi yok"))
                }
            }
            Section("Cihaz") {
                LabeledContent("Bağlantı", value: session.isOnline ? "Çevrimiçi" : "Çevrimdışı")
                LabeledContent("Bekleyen taslak", value: "\(drafts.visible(userId: session.me?.user.id, tenantId: session.tenantId).filter { $0.state != .uploaded }.count)")
                Text("Oturum belirteci ve taslak şifreleme anahtarı yalnız bu cihazın anahtar zincirinde tutulur.").font(.footnote).foregroundStyle(.secondary)
            }
            Button("Çıkış", role: .destructive) { session.logout() }
        }
        .navigationTitle("Daha fazla")
    }
}

extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
