import SwiftUI

/// Kayıtlar: sipariş/kabul ve olaylar (T45). Web ile aynı API ve yetki; mali kabul yalnız çevrimiçi.
struct RecordsView: View {
    @Environment(SessionStore.self) private var session
    @State private var tab = 0
    var body: some View {
        VStack(spacing: 0) {
            Picker("Kayıt türü", selection: $tab) {
                Text("Siparişler").tag(0); Text("Olaylar").tag(1)
                if session.me?.has("FINANCE", "BUYER", "PROCUREMENT_MANAGER", "LEGAL", "AUDITOR") == true { Text("Faturalar").tag(2) }
            }
                .pickerStyle(.segmented).padding(.horizontal).padding(.vertical, 8)
            if tab == 0 { PurchaseOrdersList() } else if tab == 1 { IncidentsList() } else { InvoicesList() }
        }
        .navigationTitle("Kayıtlar")
    }
}

/// Karar bekleyen faturalar önce; onaya hazır fatura görevden bağımsız açılabilir (finans onayı mobilde).
struct InvoicesList: View {
    @Environment(SessionStore.self) private var session
    @State private var items: [InvoiceRow]?
    @State private var error: Notice?
    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Loadable(value: items, error: error, retry: load) { rows in
                if rows.isEmpty { ContentUnavailableView("Fatura yok", systemImage: "doc.text") }
                ForEach(rows.sorted { ($0.decision == nil ? 0 : 1, $1.issueDate) < ($1.decision == nil ? 0 : 1, $0.issueDate) }) { x in
                    NavigationLink(value: x) {
                        VStack(alignment: .leading, spacing: 2) {
                            AdaptiveStack { Text(x.invoiceNo).font(.body.weight(.semibold)); Text(x.decision.map { Labels.invoiceStatus[$0] ?? $0 } ?? (x.blocked == true ? "Engelli" : "Karar bekliyor")).font(.caption).foregroundStyle(.secondary) }
                            Text(x.supplierName).font(.subheadline)
                            if let note = Labels.supplierNote(x.supplierStatus, verified: x.supplierIdentityVerified) { Text(note).font(.caption).foregroundStyle(.orange) }
                            Text(Fmt.money(x.netAmount, x.currency)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
                        }.accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .navigationDestination(for: InvoiceRow.self) { InvoiceView(invoiceId: $0.id) }
        .refreshable { await load() }
        .task { await load() }
    }
    private func load() async {
        do { let (l, _): (InvoiceList, String?) = try await session.get("/api/v1/invoices"); items = l.items; error = nil } catch { self.error = Notice.from(error) }
    }
}

struct PurchaseOrdersList: View {
    @Environment(SessionStore.self) private var session
    @State private var items: [PurchaseOrderRow]?
    @State private var error: Notice?
    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Loadable(value: items, error: error, retry: load) { rows in
                if rows.isEmpty { ContentUnavailableView("Sipariş yok", systemImage: "shippingbox") }
                ForEach(rows) { p in
                    NavigationLink(value: p) {
                        VStack(alignment: .leading, spacing: 2) {
                            AdaptiveStack { Text(p.code).font(.body.weight(.semibold)); if p.status != "OPEN" { Text(Labels.poStatus[p.status] ?? p.status).font(.caption).foregroundStyle(.secondary) } }
                            Text(p.supplierName).font(.subheadline).lineLimit(2)
                            Text(Fmt.money(p.total, p.currency)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
                        }.accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .navigationDestination(for: PurchaseOrderRow.self) { PurchaseOrderView(id: $0.id) }
        .refreshable { await load() }
        .task { await load() }
    }
    private func load() async {
        do { let (l, _): (PurchaseOrderList, String?) = try await session.get("/api/v1/purchase-orders"); items = l.items; error = nil }
        catch { self.error = Notice.from(error) }
    }
}

struct PurchaseOrderView: View {
    let id: String
    @Environment(SessionStore.self) private var session
    @State private var data: PurchaseOrderDetail?
    @State private var error: Notice?
    @State private var notice: Notice?
    @State private var receiving: PurchaseOrderDetail.Line?

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            if let notice { NoticeView(notice: notice) }
            Loadable(value: data, error: error, retry: load) { d in
                Section {
                    LabeledContent("Tedarikçi", value: d.po.supplierName)
                    LabeledContent("Durum", value: Labels.poStatus[d.po.status] ?? d.po.status)
                    if let c = d.po.contractTitle { LabeledContent("Sözleşme", value: c) }
                    if let r = d.po.closeReason { Text(r).font(.footnote).foregroundStyle(.secondary) }
                }
                Section("Kalemler") {
                    ForEach(d.lines) { l in
                        let open = (Decimal(string: l.orderedQty) ?? 0) - (Decimal(string: l.receivedQty) ?? 0)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(l.description).font(.body.weight(.semibold))
                            Text("Sipariş \(Fmt.qty(l.orderedQty)) \(l.unit) × \(Fmt.money(l.unitPrice, d.po.currency)) · kabul \(Fmt.qty(l.receivedQty)) · faturalanan \(Fmt.qty(l.invoicedQty))").font(.footnote.monospacedDigit())
                            if d.can.receive && d.po.status == "OPEN" && open > 0 {
                                Button(l.kind == "SERVICE" ? "Hizmet kabulü kaydet" : "Mal kabulü kaydet") { receiving = l }
                                    .buttonStyle(.bordered).disabled(!session.isOnline)
                            }
                        }.accessibilityElement(children: .contain)
                    }
                }
                Section("Kabul geçmişi") {
                    if d.receipts.isEmpty { Text("Henüz kabul yok.").foregroundStyle(.secondary) }
                    ForEach(d.receipts) { r in
                        VStack(alignment: .leading) {
                            let ln = d.lines.first { $0.poLineId == r.poLineId }
                            Text("\((Decimal(string: r.quantity) ?? 0) < 0 ? "Ters kabul" : "Kabul"): \(Fmt.qty(r.quantity)) \(ln?.unit ?? "") · \(ln?.description ?? "")").font(.subheadline)
                            Text("\(r.note) · \(r.recordedBy) · \(Fmt.date(r.recordedAt))").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle(data?.po.code ?? "Sipariş")
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $receiving) { line in
            ReceiptSheet(line: line) { q, note, from, to, key in
                struct Body: Encodable, Sendable { let quantity: String; let note: String; let periodFrom: String?; let periodTo: String? }
                // Hata formun içinde gösterilir ve form açık kalır: anahtar korunur, belirsiz sonuçta tekrar gönderim aynı kaydı bulur.
                do { let _: Empty = try await session.post("/api/v1/po-lines/\(line.poLineId)/receipts", body: Body(quantity: q, note: note, periodFrom: from, periodTo: to), idempotencyKey: key) }
                catch { await load(); throw error }
                notice = Notice(tone: .info, text: "Kabul kaydedildi."); receiving = nil
                await load()
            }
        }
    }
    private func load() async {
        do { (data, _) = try await session.get("/api/v1/purchase-orders/\(id)"); error = nil } catch { self.error = Notice.from(error) }
    }
}

struct ReceiptSheet: View {
    let line: PurchaseOrderDetail.Line
    let submit: (String, String, String?, String?, String) async throws -> Void
    /// Bu form için sabit tekrar anahtarı: yanıt kaybolup tekrar gönderilse de tek kabul kaydı açılır.
    @State private var key = UUID().uuidString
    @State private var notice: Notice?
    /// Sonuç belirsizse alanlar kilitlenir: aynı anahtarla yalnız aynı içerik tekrar gönderilir (sunucu farklı içeriği reddeder).
    @State private var locked = false
    @Environment(\.dismiss) private var dismiss
    @State private var qty = ""
    @State private var note = ""
    @State private var from = Date()
    @State private var to = Date()
    @State private var busy = false
    private var iso: DateFormatter { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "Europe/Istanbul"); return f }
    private var remaining: String {
        let r = (Decimal(string: line.orderedQty) ?? 0) - (Decimal(string: line.receivedQty) ?? 0)
        return NSDecimalNumber(decimal: r).stringValue
    }
    private var valid: Bool { Decimal(string: qty.replacingOccurrences(of: ",", with: ".")).map { $0 > 0 } ?? false && note.trimmingCharacters(in: .whitespaces).count >= 3 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Miktar (\(line.unit))", text: $qty).keyboardType(.decimalPad).disabled(locked).foregroundStyle(locked ? .secondary : .primary)
                    TextField("Not: ne teslim alındı", text: $note, axis: .vertical).disabled(locked).foregroundStyle(locked ? .secondary : .primary)
                } header: { Text(line.description) } footer: {
                    Text(locked ? "Bu gönderim kaydedildiyse kalan miktar azalmıştır; alanlar kilitli, aynı içerik ikinci kez kaydedilmez."
                         : "Kalan: \(Fmt.qty(remaining)) \(line.unit). Miktar ve not (en az 3 karakter) zorunlu.")
                }
                if line.kind == "SERVICE" {
                    Section("Hizmet dönemi") { DatePicker("Başlangıç", selection: $from, displayedComponents: .date); DatePicker("Bitiş", selection: $to, in: from..., displayedComponents: .date) }.disabled(locked)
                }
                if let notice { NoticeView(notice: notice) }
                Section { Text("Kabul görevi kabulün kendisi değildir; bu kayıt mali kabul olarak siparişe işlenir. Kayıt silinmez, düzeltme ters kabulle yapılır.").font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle("Kabul kaydı").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(locked ? "Tekrar gönder" : "Kaydet") {
                        busy = true; notice = nil
                        Task {
                            do { try await submit(qty.replacingOccurrences(of: ",", with: "."), note, line.kind == "SERVICE" ? iso.string(from: from) : nil, line.kind == "SERVICE" ? iso.string(from: to) : nil, key) }
                            catch { notice = Notice.formResult(error); if (error as? APIError)?.outcomeUnknown == true { locked = true } }
                            busy = false
                        }
                    }.disabled(busy || !valid)
                    .overlay { if busy { ProgressView() } }
                }
            }
        }
    }
}

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
        .navigationDestination(for: IncidentRow.self) { IncidentView(incidentId: $0.id) }
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
                            Text("\(Labels.role[a.ownerRole] ?? a.ownerRole) · hedef \(Fmt.date(a.dueDate)) · \(a.status == "OPEN" ? "Açık" : a.status == "DONE" ? "Doğrulama bekliyor" : "Doğrulandı")").font(.footnote)
                            if a.status == "OPEN" && d.can.roles.contains(a.ownerRole) {
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
    /// Sonuç belirsizse alanlar kilitlenir (bkz. ReceiptSheet).
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
