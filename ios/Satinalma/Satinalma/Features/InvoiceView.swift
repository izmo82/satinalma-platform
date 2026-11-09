import SwiftUI

/// Kaynaklı onay (04 iOS, T44): tutar, firma, bulgular ve sorumlu rol görünür. Onay, görülen kontrol sonucunun parmak iziyle
/// (If-Match) gönderilir; arada tahsis/sipariş/kabul değiştiyse sunucu 409 döner. Çevrimdışı onay yok.
struct InvoiceView: View {
    let invoiceId: String
    @Environment(SessionStore.self) private var session
    @State private var data: InvoiceDetail?
    @State private var error: Notice?
    @State private var notice: Notice?
    @State private var confirming = false
    @State private var busy = false

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            if let notice { NoticeView(notice: notice) }
            Loadable(value: data, error: error, retry: load) { d in
                Section {
                    LabeledContent("Tedarikçi", value: d.invoice.supplierName)
                    if let note = Labels.supplierNote(d.invoice.supplierStatus, verified: d.invoice.supplierIdentityVerified) { LabeledContent("Tedarikçi durumu") { Text(note).foregroundStyle(.orange) } }
                    LabeledContent("Durum", value: Labels.invoiceStatus[d.status] ?? d.status)
                    LabeledContent("Net", value: Fmt.money(d.check.netAmount, d.invoice.currency))
                    LabeledContent("KDV", value: Fmt.money(d.check.taxTotal, d.invoice.currency))
                    LabeledContent("Vergi dahil", value: Fmt.money(d.check.grossAmount, d.invoice.currency))
                    if let doc = d.invoice.documentVersionId {
                        NavigationLink("Kaynak belgeyi aç") { DocumentPreview(documentVersionId: doc, expectedSha256: d.invoice.documentSha256, title: d.invoice.invoiceNo) }
                    }
                }
                Section("Satırlar") {
                    ForEach(d.lines) { l in LabeledContent("\(l.lineNo). \(l.description)", value: "\(Fmt.qty(l.quantity)) \(l.unit) · \(Fmt.money(l.netAmount, d.invoice.currency))") }
                    // Bulguyu çözmek için bağlı siparişe (kabul kaydı) doğrudan geçiş.
                    ForEach(Array(Set(d.allocations.compactMap { a in a.poId.map { "\($0)|\(a.poCode ?? "")" } })).sorted(), id: \.self) { v in
                        let parts = v.split(separator: "|", maxSplits: 1).map(String.init)
                        NavigationLink("Siparişi aç: \(parts.count > 1 ? parts[1] : "")") { PurchaseOrderView(id: parts[0]) }
                    }
                }
                Section("Neden eşleşmedi ve kim çözer") {
                    if d.check.issues.isEmpty { Text("Bulgu yok.").foregroundStyle(.secondary) }
                    ForEach(d.check.issues) { x in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(Labels.issueSeverity[x.severity] ?? x.severity) · Çözen: \(Labels.role[x.ownerRole] ?? x.ownerRole)").font(.caption.weight(.semibold))
                                .foregroundStyle(x.severity == "BLOCK" ? Color.red : Color.orange)
                            Text(x.message).font(.subheadline)
                        }.accessibilityElement(children: .combine)
                    }
                }
                if d.decisions.contains(where: { $0.kind == "APPROVAL" || $0.kind == "REJECTION" }) {
                    Section("Karar") { ForEach(Array(d.decisions.enumerated()), id: \.offset) { _, x in Text("\(x.kind == "APPROVAL" ? "Finans onayı" : x.kind == "REJECTION" ? "Ret" : "İstisna onayı") · \(x.decidedBy) · \(Fmt.date(x.decidedAt))").font(.footnote) } }
                } else if d.can.approve {
                    Section {
                        if d.invoice.createdByMe { Text("Faturayı siz girdiniz; görev ayrılığı gereği başka bir finans kullanıcısı onaylar.").font(.footnote) }
                        else {
                            let enabled = !busy && session.isOnline && d.check.canApprove && d.status != "NEEDS_EXCEPTION"
                            Button { confirming = true } label: { Label("Finans onayı", systemImage: "checkmark.seal") }
                                .disabled(!enabled).foregroundStyle(enabled ? Color.accentColor : Color.secondary)
                            if !session.isOnline { Text("Onay yalnız çevrimiçi ve güncel kayıt üzerinde verilir.").font(.footnote).foregroundStyle(.secondary) }
                            else if !d.check.canApprove || d.status == "NEEDS_EXCEPTION" { Text("Engel veya istisna gerektiren bulgu varken onaylanamaz.").font(.footnote).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
        }
        .navigationTitle(data?.invoice.invoiceNo ?? "Fatura")
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog("Faturayı onayla", isPresented: $confirming, titleVisibility: .visible) {
            Button("Onayla: \(Fmt.money(data?.check.grossAmount, data?.invoice.currency ?? "TRY"))") { Task { await approve() } }
        } message: { Text("Onay, şu an gördüğünüz kontrol sonucuna bağlıdır. Ödeme bu uygulamadan yapılmaz.") }
    }

    private func approve() async {
        guard let d = data else { return }
        busy = true; defer { busy = false }
        do { let _: Empty = try await session.post("/api/v1/invoices/\(d.invoice.id)/approve", ifMatch: d.checkFingerprint); notice = Notice(tone: .info, text: "Fatura onaylandı.") }
        catch { notice = Notice.from(error) }
        await load()
    }

    private func load() async {
        do { (data, _) = try await session.get("/api/v1/invoices/\(invoiceId)"); error = nil } catch { self.error = Notice.from(error) }
    }
}
