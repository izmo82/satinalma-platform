import SwiftUI

/// Olaylar (T45): liste, bildirim, ayrıntı ve düzeltici faaliyet tamamlama. v2'de Tedarikçiler sekmesinden açılır (eskiden Kayıtlar);
/// web ile aynı API ve yetki, işlevler değişmedi. Yazma yalnız çevrimiçi.
/// Satırın hedefi (`IncidentRow` → `IncidentView`) yığın kökünde (`SuppliersList`) tanımlıdır.
struct IncidentsList: View {
    @Environment(SessionStore.self) private var session
    @State private var data: IncidentList?
    @State private var error: Notice?
    @State private var reporting = false
    @State private var notice: Notice?
    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            if let notice { NoticeView(notice: notice) }
            Loadable(value: data, error: error, retry: load) { d in
                if d.items.isEmpty { ContentUnavailableView("Olay yok", systemImage: "checkmark.shield") }
                ForEach(d.items) { x in
                    NavigationLink(value: x) {
                        VStack(alignment: .leading, spacing: 2) {
                            AdaptiveStack { Text(x.code).font(.caption.monospaced()); Text(Labels.incidentStatus[x.status] ?? x.status).font(.caption.weight(.semibold)); if x.disputeOpen { Text("İtiraz açık").font(.caption).foregroundStyle(.orange) } }
                            Text(x.title).font(.body.weight(.semibold))
                            Text("\(x.supplierName) · \(Labels.severity[x.severity] ?? x.severity)").font(.footnote).foregroundStyle(.secondary)
                        }.accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .navigationTitle("Olaylar")
        .toolbar { if data?.can.report == true { Button { reporting = true } label: { Label("Olay bildir", systemImage: "plus") }.disabled(!session.isOnline) } }
        .sheet(isPresented: $reporting) { ReportIncidentSheet { code in notice = Notice(tone: .info, text: "\(code) bildirildi."); await load() } }
        .refreshable { await load() }
        .task { await load() }
    }
    private func load() async {
        do { (data, _) = try await session.get("/api/v1/incidents"); error = nil } catch { self.error = Notice.from(error) }
    }
}

struct IncidentView: View {
    let incidentId: String
    @Environment(SessionStore.self) private var session
    @State private var data: IncidentDetail?
    @State private var error: Notice?
    @State private var notice: Notice?
    @State private var completing: IncidentDetail.Action?
    @State private var note = ""

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            if let notice { NoticeView(notice: notice) }
            Loadable(value: data, error: error, retry: load) { d in
                Section {
                    Text(d.incident.title).font(.headline)
                    LabeledContent("Durum", value: Labels.incidentStatus[d.incident.status] ?? d.incident.status)
                    LabeledContent("Olay tarihi", value: Fmt.date(d.incident.occurredOn))
                    LabeledContent("Tedarikçi", value: d.incident.supplierName)
                    LabeledContent("Kategori", value: Labels.category[d.incident.category] ?? d.incident.category)
                    LabeledContent("Şiddet", value: Labels.severity[d.incident.severity] ?? d.incident.severity)
                    Text(d.scoreImpact.counted ? "Puan etkisi: −\(d.scoreImpact.penalty ?? 0)" : "Puana yansımıyor: \(d.scoreImpact.reason ?? "")").font(.footnote)
                }
                Section("Olay") { Text(d.incident.description); if let i = d.incident.impact { Text("Etki: \(i)").font(.footnote) } }
                Section("Düzeltici faaliyet") {
                    if d.actions.isEmpty { Text("Faaliyet yok.").foregroundStyle(.secondary) }
                    ForEach(d.actions) { a in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(a.title).font(.subheadline.weight(.semibold))
                            Text("\(Labels.role[a.ownerRole] ?? "Sorumlu rol") · hedef \(Fmt.date(a.dueDate)) · \(a.status == "OPEN" ? "Açık" : a.status == "DONE" ? "Doğrulama bekliyor" : "Doğrulandı")").font(.footnote)
                            // Eski (v1) sorumlu rol kodu v2 rolüne eşlenerek karşılaştırılır (web ile aynı).
                            if a.status == "OPEN" && d.can.roles.map(Labels.v2Role).contains(Labels.v2Role(a.ownerRole)) {
                                Button("Tamamlandı olarak işaretle") { completing = a }.buttonStyle(.bordered).disabled(!session.isOnline)
                            }
                        }
                    }
                }
                Section("Zaman çizelgesi") {
                    ForEach(Array(d.events.enumerated()), id: \.offset) { _, e in
                        VStack(alignment: .leading) {
                            Text(Labels.event[e.kind] ?? e.kind).font(.subheadline.weight(.semibold))
                            if let n = e.note, e.kind != "REPORTED" { Text(n).font(.subheadline) }
                            Text("\(e.actor) · \(Fmt.date(e.at))").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                Section { Text("Doğrulama, itiraz ve kapanış web uygulamasında yetkili tarafından yapılır.").font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(data?.incident.code ?? "Olay")
        .refreshable { await load() }
        .task { await load() }
        .alert("Faaliyeti tamamla", isPresented: Binding(get: { completing != nil }, set: { if !$0 { completing = nil } })) {
            TextField("Ne yapıldı ve kanıtı", text: $note)
            Button("Kaydet") {
                guard let a = completing else { return }
                Task {
                    struct Body: Encodable, Sendable { let note: String }
                    do { let _: Empty = try await session.post("/api/v1/corrective-actions/\(a.id)/complete", body: Body(note: note)); notice = Notice(tone: .info, text: "Faaliyet tamamlandı; bağımsız doğrulama bekliyor.") }
                    catch { notice = Notice.from(error) }
                    note = ""; await load()
                }
            }
            Button("Vazgeç", role: .cancel) { note = "" }
        } message: { Text("En az 10 karakter. Faaliyeti tamamlayan kişi doğrulayamaz.") }
    }
    private func load() async {
        do { (data, _) = try await session.get("/api/v1/incidents/\(incidentId)"); error = nil } catch { self.error = Notice.from(error) }
    }
}

struct ReportIncidentSheet: View {
    let onDone: (String) async -> Void
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var suppliers: [SupplierOption] = []
    @State private var supplierId = ""
    @State private var category = "QUALITY"
    @State private var severity = "MEDIUM"
    @State private var title = ""
    @State private var description = ""
    @State private var occurredOn = Date()
    @State private var notice: Notice?
    @State private var busy = false
    @State private var key = UUID().uuidString
    /// Sonuç belirsizse alanlar kilitlenir: aynı anahtarla yalnız aynı içerik tekrar gönderilir (sunucu farklı içeriği reddeder).
    @State private var locked = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Tedarikçi", selection: $supplierId) { Text("Seçin").tag(""); ForEach(suppliers) { Text($0.displayName).tag($0.id) } }
                    Picker("Kategori", selection: $category) { ForEach(Labels.category.keys.sorted(), id: \.self) { Text(Labels.category[$0]!).tag($0) } }
                    Picker("Şiddet", selection: $severity) { ForEach(["LOW", "MEDIUM", "HIGH", "CRITICAL"], id: \.self) { Text(Labels.severity[$0]!).tag($0) } }
                    DatePicker("Olay tarihi", selection: $occurredOn, in: ...Date(), displayedComponents: .date)
                }.disabled(locked)
                Section("Olay") {
                    TextField("Başlık", text: $title)
                    TextField("Ne oldu (gözlem; suçlama değil)", text: $description, axis: .vertical).lineLimit(3...8)
                }.disabled(locked).foregroundStyle(locked ? .secondary : .primary)
                if let notice { NoticeView(notice: notice) }
                Section { Text("Bildirim iddiadır; doğrulama başka bir yetkilinindir.").font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle("Olay bildir").navigationBarTitleDisplayMode(.inline)
            .task { if let (r, _) = try? await session.get("/api/v1/supplier-options") as (SupplierOptions, String?) { suppliers = r.items } }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(locked ? "Tekrar gönder" : "Bildir") { Task { await send() } }.overlay { if busy { ProgressView() } }.disabled(busy || supplierId.isEmpty || title.count < 5 || description.count < 10) }
            }
        }
    }
    private func send() async {
        struct Body: Encodable, Sendable { let supplierId: String; let category: String; let severity: String; let title: String; let description: String; let occurredOn: String }
        struct Res: Decodable, Sendable { let code: String }
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "Europe/Istanbul")
        busy = true; notice = nil; defer { busy = false }
        do {
            let r: Res = try await session.post("/api/v1/incidents", body: Body(supplierId: supplierId, category: category, severity: severity, title: title, description: description, occurredOn: f.string(from: occurredOn)), idempotencyKey: key)
            notice = Notice(tone: .info, text: "\(r.code) bildirildi.")
            await onDone(r.code); dismiss()
        } catch { notice = Notice.formResult(error); if (error as? APIError)?.outcomeUnknown == true { locked = true } }
    }
}
