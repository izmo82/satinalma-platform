import SwiftUI

struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(DraftStore.self) private var drafts

    var body: some View {
        Group {
            // Kimlik etkin kiracıya bağlı: kiracı değişince sekmeler, gezinme yığınları ve profil sayfası yeniden kurulur;
            // her liste yeni kiracı için yüklenir, eski kiracının satırı ya da açık ayrıntı ekranı kalmaz.
            if let me = session.me { MainTabs().id(me.activeTenantId) } else { LoginView() }
        }
        .task { await session.refresh() }
        // Bağlantı gelince bekleyen taslaklar yüklenir; sunucu aynı dosyayı tekilleştirir.
        .onChange(of: session.isOnline) { _, online in
            if online, session.me != nil { Task { await drafts.uploadPending(session: session) } }
        }
    }
}

/// Beş sekme (v2 D93, onaylı Figma): İşlerim, Sözleşmeler, Tara (bekleyen taslak rozeti), Tedarikçiler, Faturalar.
/// Eski "Daha fazla" içeriği her sekme kökündeki profil düğmesinden açılan sayfadadır (dokunuş sayısı aynı).
struct MainTabs: View {
    @Environment(DraftStore.self) private var drafts
    @Environment(SessionStore.self) private var session
    private var pendingCount: Int { drafts.visible(userId: session.me?.user.id, tenantId: session.tenantId).filter { $0.state != .uploaded }.count }
    var body: some View {
        TabView {
            Tab("İşlerim", systemImage: "tray") { NavigationStack { TasksView().profileButton() } }
            Tab("Sözleşmeler", systemImage: "doc.richtext") { NavigationStack { ContractsList().profileButton() } }
            Tab("Tara", systemImage: "doc.viewfinder") { NavigationStack { ScanView().profileButton() } }
                .badge(pendingCount)
            Tab("Tedarikçiler", systemImage: "building.2") { NavigationStack { SuppliersList().profileButton() } }
            Tab("Faturalar", systemImage: "doc.text") { NavigationStack { InvoicesList().profileButton() } }
        }
    }
}

/// Sekme kökündeki profil düğmesi: oturum, kiracı, cihaz bilgisi ve çıkış sayfasını açar.
private struct ProfileButton: ViewModifier {
    @State private var presented = false
    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { presented = true } label: { Label("Profil ve oturum", systemImage: "person.crop.circle") }
                }
            }
            .sheet(isPresented: $presented) { NavigationStack { ProfileView() } }
    }
}

extension View {
    func profileButton() -> some View { modifier(ProfileButton()) }
}

struct LoginView: View {
    @Environment(SessionStore.self) private var session
    #if DEBUG
    /// Sentetik kullanıcılar ve v2 rolleri (apps/api/src/devdata.ts).
    private let users: [(String, String)] = [
        ("alper.satinalma@example.test", "Satınalma + Departman kullanıcısı (Bilgi Teknolojileri)"), ("leyla.hukuk@example.test", "Satınalma"),
        ("kerem.hukuk@example.test", "Satınalma"), ("ferda.finans@example.test", "Satınalma (fatura girişi)"),
        ("nur.finansonay@example.test", "Satınalma"), ("selin.guvenlik@example.test", "Departman kullanıcısı (Bilgi Teknolojileri)"), ("mine.anaveri@example.test", "Satınalma"),
        ("tolga.teknik@example.test", "Departman kullanıcısı (Bilgi Teknolojileri)"), ("tamer.yonetici@example.test", "Yönetici"),
        ("deniz.denetci@example.test", "Denetçi"), ("ece.cokkiracili@example.test", "Satınalma (iki kiracı)"),
    ]
    #endif

    var body: some View {
        NavigationStack {
            List {
                switch session.authConfig?.mode {
                case "oidc":
                    Section {
                        Button { Task { await session.login() } } label: {
                            Label(session.isLoading ? "Giriş yapılıyor…" : "Kurumsal hesapla giriş yap", systemImage: "person.badge.key")
                        }
                        .disabled(session.isLoading)
                    } footer: {
                        Text("Giriş kurumunuzun kimlik sağlayıcısında yapılır; parolanız bu uygulamaya girilmez. Oturum belirteci yalnız bu cihazın anahtar zincirinde tutulur.")
                    }
                case "dev":
                    #if DEBUG
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
                    #else
                    Section { Text("Bu sunucu geliştirme modunda; yayın derlemesi yalnız kurumsal girişle çalışır.").foregroundStyle(.secondary) }
                    #endif
                default:
                    Section {
                        if session.lastError == nil { ProgressView("Oturum ayarları alınıyor…") }
                        Button("Tekrar dene") { Task { await session.loadAuthConfig() } }
                    }
                }
                if let err = session.lastError { Section { Text(err).foregroundStyle(.red) } }
            }
            .navigationTitle("Satınalma")
            .task { if session.authConfig == nil { await session.loadAuthConfig() } }
        }
    }
}

/// Profil ve oturum (eski "Daha fazla" sekmesi): kullanıcı, roller, departmanlar, kiracı seçimi, şirket kapsamı, cihaz, çıkış.
struct ProfileView: View {
    @Environment(SessionStore.self) private var session
    @Environment(DraftStore.self) private var drafts
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            if let me = session.me {
                Section("Oturum") {
                    LabeledContent("Kullanıcı", value: me.user.displayName)
                    LabeledContent("Roller", value: Labels.roleNames(me.roles))
                    LabeledContent("Departmanlar", value: me.allDepartments == true ? "Tüm departmanlar" : (me.departments ?? []).map(\.name).joined(separator: ", ").ifEmpty("Departman atanmadı"))
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
            Button("Çıkış", role: .destructive) { dismiss(); session.logout() }
        }
        .navigationTitle("Profil")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Kapat") { dismiss() } } }
    }
}

extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
