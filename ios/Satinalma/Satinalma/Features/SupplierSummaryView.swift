import SwiftUI

/// Salt okunur tedarikçi özeti (v2 Faz 5, R16): aşama, VKN son 4 hane, iletişim, sorumlu ekip, belgeler ve geçerlilik,
/// açık ayrılış listesi bilgisi. Düzenleme, pasife alma ve başvuru incelemesi yalnız web'de (R16).
struct SupplierSummaryView: View {
    let supplierId: String
    let titleHint: String
    @Environment(SessionStore.self) private var session
    @State private var card: SupplierCardV2?
    @State private var error: Notice?

    init(supplier: SupplierRow) { supplierId = supplier.id; titleHint = supplier.legalName }
    init(supplierId: String, title: String = "Tedarikçi") { self.supplierId = supplierId; titleHint = title }

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Loadable(value: card, error: error, retry: load) { c in
                Section("Genel") {
                    Text(c.legalName).font(.headline)
                    row("Aşama", c.stageLabel ?? Labels.supplierStatus[c.status] ?? "Bilinmeyen durum")
                    if c.stageLabel != nil, let old = Labels.supplierStatus[c.status], old != c.stageLabel { row("Durum", old) }
                    row("Vergi kimliği", c.taxIdTail ?? "Doğrulanmadı")
                    row("Sorumlu ekip", c.profile?.responsibleDepartment?.name ?? "Atanmadı")
                }
                if let ob = c.offboarding, !ob.completed {
                    Section("Ayrılış") {
                        Label("Ayrılış kontrol listesi açık: \(ob.openCount) madde bekliyor. Listeyi web uygulamasında tamamlayın.", systemImage: "list.bullet.clipboard")
                            .font(.subheadline)
                    }
                }
                Section("İletişim") {
                    row("Kişi", c.profile?.contactName ?? "—")
                    row("E-posta", c.profile?.contactEmail ?? "—")
                    row("Telefon", c.profile?.contactPhone ?? "—")
                    row("Adres", c.profile?.address ?? "—")
                }
                documents(c)
                Section { Label("Düzenleme ve onay işlemleri web uygulamasında yapılır.", systemImage: "desktopcomputer").font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(card?.legalName ?? titleHint)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder private func documents(_ c: SupplierCardV2) -> some View {
        let docs = (c.supplierDocuments ?? []).filter(\.current)
        Section("Belgeler ve geçerlilik") {
            if docs.isEmpty { Text("Yüklenmiş belge yok.").foregroundStyle(.secondary) }
            ForEach(docs) { d in
                VStack(alignment: .leading, spacing: 2) {
                    Text(d.typeName).font(.body.weight(.semibold))
                    Text(d.validUntil.map { "Geçerlilik: \(Fmt.date($0))" } ?? "Geçerlilik tarihi yok").font(.subheadline).foregroundStyle(.secondary)
                    let b = DocumentValidity.badge(d.validity)
                    Label(d.validityLabel, systemImage: b?.icon ?? "checkmark.circle").font(.caption.weight(.semibold)).foregroundStyle(b?.color ?? .secondary)
                    if d.quarantined == true { Label("Karantinada", systemImage: "exclamationmark.shield").font(.caption).foregroundStyle(.red) }
                    if let av = d.avScanLabel { Text(av).font(.caption).foregroundStyle(.secondary) }
                }
                .accessibilityElement(children: .combine)
            }
            ForEach(Array((c.requiredMissing ?? []).enumerated()), id: \.offset) { _, m in
                Label("\(m.name ?? "Belge"): \(m.reasonLabel ?? "Eksik")", systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(.orange)
            }
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.caption).foregroundStyle(.secondary)
            Text(v).font(.body)
        }.accessibilityElement(children: .combine)
    }

    private func load() async {
        do { let (c, _): (SupplierCardV2, String?) = try await session.get("/api/v1/suppliers/\(supplierId)"); card = c; error = nil } catch { self.error = Notice.from(error) }
    }
}
