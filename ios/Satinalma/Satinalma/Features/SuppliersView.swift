import SwiftUI

/// Sekme içi gezinme hedefleri; değer tabanlı bağlantı, iç içe hedeflerin (olay ayrıntısı) çalışması için gerekli.
enum SupplierRoute: Hashable { case incidents }

/// Tedarikçiler sekmesi (v2): salt okunur tedarikçi listesi (`/api/v1/suppliers`) ve en üstte "Olaylar" girişi.
/// Olay listesi, bildirimi, ayrıntısı ve faaliyet tamamlama eskiden Kayıtlar'daydı; işlevleri değişmeden buraya taşındı.
struct SuppliersList: View {
    @Environment(SessionStore.self) private var session
    @State private var items: [SupplierRow]?
    @State private var error: Notice?
    @State private var query = ""

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Section {
                NavigationLink(value: SupplierRoute.incidents) { Label("Olaylar", systemImage: "exclamationmark.bubble") }
            } footer: { Text("Olay bildirimi ve düzeltici faaliyetler.") }
            Section("Tedarikçiler") {
                Loadable(value: items, error: error, retry: load) { rows in
                    let shown = filtered(rows)
                    if shown.isEmpty { ContentUnavailableView(query.isEmpty ? "Tedarikçi yok" : "Eşleşen tedarikçi yok", systemImage: "building.2") }
                    ForEach(shown) { s in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.legalName).font(.body.weight(.semibold))
                            AdaptiveStack {
                                Text(Labels.supplierStatus[s.status] ?? "Bilinmeyen durum").font(.caption.weight(.semibold))
                                    .foregroundStyle(s.status == "ACTIVE" ? Color.secondary : Color.orange)
                                if let tail = s.taxIdTail { Text(tail).font(.caption.monospaced()).foregroundStyle(.secondary) }
                                else { Text("Vergi kimliği doğrulanmadı").font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .navigationTitle("Tedarikçiler")
        .navigationDestination(for: SupplierRoute.self) { _ in IncidentsList() }
        .navigationDestination(for: IncidentRow.self) { IncidentView(incidentId: $0.id) }
        .searchable(text: $query, prompt: "Ünvan ara")
        .refreshable { await load() }
        .task { await load() }
    }

    private func filtered(_ rows: [SupplierRow]) -> [SupplierRow] {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? rows : rows.filter { $0.legalName.localizedStandardContains(q) }
    }

    private func load() async {
        do { let (l, _): (SupplierList, String?) = try await session.get("/api/v1/suppliers"); items = l.items; error = nil } catch { self.error = Notice.from(error) }
    }
}
