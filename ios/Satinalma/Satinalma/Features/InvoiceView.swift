import SwiftUI

/// Faturalar sekmesi (v2 D93): liste salt okunur; eşleşme durumu web ile aynı (Eşleşti / Eşleşmedi / Hukuken iptal/ret).
/// Eşleşmeyenler önce, sonra tarih (yeni → eski).
struct InvoicesList: View {
    @Environment(SessionStore.self) private var session
    @State private var items: [InvoiceRow]?
    @State private var error: Notice?
    @State private var query = ""
    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Loadable(value: items, error: error, retry: load) { all in
                let rows = filtered(all)
                if rows.isEmpty { ContentUnavailableView(query.isEmpty ? "Fatura yok" : "Eşleşen fatura yok", systemImage: "doc.text") }
                ForEach(rows.sorted { (rank($0), $1.issueDate) < (rank($1), $0.issueDate) }) { x in
                    NavigationLink(value: x) {
                        VStack(alignment: .leading, spacing: 2) {
                            AdaptiveStack { Text(x.invoiceNo).font(.body.weight(.semibold)); Text(x.matchText).font(.caption).foregroundStyle(x.matched == true ? Color.secondary : Color.orange) }
                            Text(x.supplierName).font(.subheadline)
                            if let name = x.contract?.displayName {
                                Text("Sözleşme: \(name)").font(.caption).foregroundStyle(.secondary)
                            }
                            if let note = Labels.supplierNote(x.supplierStatus, verified: x.supplierIdentityVerified) { Text(note).font(.caption).foregroundStyle(.orange) }
                            Text("Departman: \(x.departmentName ?? "Departmansız")").font(.caption).foregroundStyle(.secondary)
                            Text("\(Fmt.money(x.netAmount, x.currency)) · \(Fmt.date(x.issueDate))").font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
                        }.accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .navigationTitle("Faturalar")
        .searchable(text: $query, prompt: "Fatura no veya tedarikçi")
        .navigationDestination(for: InvoiceRow.self) { InvoiceView(invoiceId: $0.id) }
        .refreshable { await load() }
        .task { await load() }
    }
    private func filtered(_ rows: [InvoiceRow]) -> [InvoiceRow] {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? rows : rows.filter { $0.invoiceNo.localizedStandardContains(q) || $0.supplierName.localizedStandardContains(q) }
    }
    private func rank(_ x: InvoiceRow) -> Int { x.legalStatus != "RECEIVED" ? 2 : x.matched == true ? 1 : 0 }
    private func load() async {
        do { let (l, _): (InvoiceList, String?) = try await session.get("/api/v1/invoices"); items = l.items; error = nil } catch { self.error = Notice.from(error) }
    }
}

/// Fatura ayrıntısı, salt okunur (v2 D93): tutar, firma, departman, tahsis hedefi ve kalan bulgular görünür.
/// Onay, ret ve istisna kararı bu sistemde verilmez; ödeme ERP'de yürür.
struct InvoiceView: View {
    let invoiceId: String
    @Environment(SessionStore.self) private var session
    @State private var data: InvoiceDetail?
    @State private var error: Notice?

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Loadable(value: data, error: error, retry: load) { d in
                Section {
                    // Büyük başlık gezinme çubuğunda tek satırdır ve AX5'te kesilir; fatura numarası burada sarılarak tam okunur.
                    Text(verbatim: d.invoice.invoiceNo).font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel("Fatura \(d.invoice.invoiceNo)").accessibilityAddTraits(.isHeader)
                    LabeledContent("Tür", value: Labels.invoiceKind[d.invoice.kind] ?? "Fatura")
                    LabeledContent("Tedarikçi", value: d.invoice.supplierName)
                    if let note = Labels.supplierNote(d.invoice.supplierStatus, verified: d.invoice.supplierIdentityVerified) { LabeledContent("Tedarikçi durumu") { Text(note).foregroundStyle(.orange) } }
                    LabeledContent("Departman", value: d.invoice.departmentName ?? "Departmansız")
                    LabeledContent("Tarih", value: Fmt.date(d.invoice.issueDate))
                    LabeledContent("Eşleşme", value: d.matchText)
                    LabeledContent("Net", value: Fmt.money(d.check.netAmount, d.invoice.currency))
                    LabeledContent("KDV", value: Fmt.money(d.check.taxTotal, d.invoice.currency))
                    LabeledContent("Vergi dahil", value: Fmt.money(d.check.grossAmount, d.invoice.currency))
                    if let doc = d.invoice.documentVersionId {
                        NavigationLink("Kaynak belgeyi aç") { DocumentPreview(documentVersionId: doc, expectedSha256: d.invoice.documentSha256, title: d.invoice.invoiceNo) }
                    }
                }
                if let m = d.match { InvoiceMatchSection(match: m, currency: d.invoice.currency) }
                Section("Satırlar ve eşleştirme") {
                    ForEach(d.lines) { l in
                        VStack(alignment: .leading, spacing: 4) {
                            LabeledContent("\(l.lineNo). \(l.description)", value: "\(Fmt.qty(l.quantity)) \(l.unit) · \(Fmt.money(l.netAmount, d.invoice.currency))")
                            let targets = d.allocations.filter { $0.lineNo == l.lineNo }
                            if targets.isEmpty { Text("Sözleşmeye bağlanmadı").font(.footnote).foregroundStyle(.secondary) }
                            // Hedef yalnız metin: eski sipariş bağı numarasıyla görünür, sipariş ekranı yok.
                            ForEach(Array(targets.enumerated()), id: \.offset) { _, a in Label(a.targetText, systemImage: "arrow.turn.down.right").font(.footnote) }
                        }.accessibilityElement(children: .combine)
                    }
                }
                Section {
                    if d.visibleIssues.isEmpty { Text("Bulgu yok.").foregroundStyle(.secondary) }
                    ForEach(d.visibleIssues) { x in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(Labels.issueSeverity[x.severity] ?? "Bulgu") · Çözen: \(Labels.role[x.ownerRole] ?? "Satınalma")").font(.caption.weight(.semibold))
                                .foregroundStyle(x.severity == "BLOCK" ? Color.red : Color.orange)
                            Text(x.message).font(.subheadline)
                        }.accessibilityElement(children: .combine)
                    }
                } header: { Text("Bulgular") } footer: { Text("Eşleştirme (tahsis) düzenleme web uygulamasında yapılır.") }
                if !d.decisions.isEmpty {
                    Section {
                        ForEach(Array(d.decisions.enumerated()), id: \.offset) { _, x in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(Labels.pastDecision[x.kind] ?? "Karar (v1 kaydı)") · \(x.decidedBy)").font(.subheadline)
                                Text([Fmt.date(x.decidedAt), x.reason].compactMap { $0 }.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary)
                            }.accessibilityElement(children: .combine)
                        }
                    } header: { Text("Karar geçmişi") } footer: { Text("Fatura onayı artık bu sistemde verilmez; ödeme ERP'de yürür.") }
                }
            }
        }
        .navigationTitle(data?.invoice.invoiceNo ?? "Fatura")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do { (data, _) = try await session.get("/api/v1/invoices/\(invoiceId)"); error = nil } catch { self.error = Notice.from(error) }
    }
}

/// Fatura ayrıntısında "Eşleşme" bölümü (v2 Faz 7, R11): sözleşme, proje, yöntem, kullanım. Salt okunur; elle bağlama web'de.
struct InvoiceMatchSection: View {
    let match: MatchInfo
    let currency: String
    var body: some View {
        Section {
            if let s = match.stateLabel { LabeledContent("Durum", value: s) }
            if let c = match.contract?.displayName { LabeledContent("Sözleşme", value: c) }
            if let p = match.project?.displayName { LabeledContent("Proje", value: p) }
            if let m = match.methodLabel { LabeledContent("Yöntem", value: m) }
            if let note = match.note, !note.isEmpty { LabeledContent("Not", value: note) }
            if match.contract == nil, let f = match.lastAutoFailure?.reasonLabel { Text(f).font(.footnote).foregroundStyle(.orange) }
            if let u = match.usage {
                let cur = u.currency ?? currency
                VStack(alignment: .leading, spacing: 2) {
                    LabeledContent("Kullanım", value: u.amount == nil ? "\(Fmt.money(u.used, cur)) (sözleşme tutarı yok)" : "\(Fmt.money(u.used, cur)) / \(Fmt.money(u.amount, cur))")
                    if let w = u.warning ?? (u.levelLabel == "Aşım" ? u.levelLabel : nil) { Text(w).font(.footnote.weight(.semibold)).foregroundStyle(.orange) }
                }.accessibilityElement(children: .combine)
            }
        } header: { Text("Eşleşme") } footer: { Text("Elle bağlama web uygulamasında yapılır.") }
    }
}
