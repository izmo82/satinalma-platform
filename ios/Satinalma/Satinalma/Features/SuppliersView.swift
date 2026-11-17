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
    @State private var stageFilter = SupplierStageFilter.all

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Section {
                NavigationLink(value: SupplierRoute.incidents) { Label("Olaylar", systemImage: "exclamationmark.bubble") }
            } footer: { Text("Olay bildirimi ve düzeltici faaliyetler.") }
            Section("Tedarikçiler") {
                Loadable(value: items, error: error, retry: load) { rows in
                    let shown = filtered(rows)
                    Picker("Aşama", selection: $stageFilter) {
                        ForEach(SupplierStageFilter.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.menu)
                    if shown.isEmpty { ContentUnavailableView(query.isEmpty && stageFilter == .all ? "Tedarikçi yok" : "Eşleşen tedarikçi yok", systemImage: "building.2") }
                    ForEach(shown) { s in
                        NavigationLink(value: s) { SupplierListRow(s: s) }
                    }
                }
            }
        }
        .navigationTitle("Tedarikçiler")
        .navigationDestination(for: SupplierRoute.self) { _ in IncidentsList() }
        .navigationDestination(for: SupplierRow.self) { SupplierSummaryView(supplier: $0) }
        .navigationDestination(for: IncidentRow.self) { IncidentView(incidentId: $0.id) }
        .searchable(text: $query, prompt: "Ünvan ara")
        .refreshable { await load() }
        .task { await load() }
    }

    private func filtered(_ rows: [SupplierRow]) -> [SupplierRow] {
        let q = query.trimmingCharacters(in: .whitespaces)
        return rows.filter { stageFilter.matches($0) && (q.isEmpty || $0.legalName.localizedStandardContains(q)) }
    }

    private func load() async {
        do { let (l, _): (SupplierList, String?) = try await session.get("/api/v1/suppliers"); items = l.items; error = nil } catch { self.error = Notice.from(error) }
    }
}

/// Aşama süzgeci (R1 aşamaları); istemci tarafında, liste zaten tam yüklü. `stage` yoksa (eski sunucu) durumdan türetilir.
enum SupplierStageFilter: String, CaseIterable, Identifiable {
    case all, candidate, approved, passive, rejected
    var id: String { rawValue }
    var label: String {
        switch self { case .all: "Tümü"; case .candidate: "Aday"; case .approved: "Onaylı"; case .passive: "Pasif"; case .rejected: "Reddedildi" }
    }
    func matches(_ s: SupplierRow) -> Bool {
        guard self != .all else { return true }
        let stage = s.stage ?? SupplierRow.stage(forStatus: s.status)
        switch self {
        case .candidate: return stage == "CANDIDATE"
        case .approved: return stage == "APPROVED"
        case .passive: return stage == "PASSIVE"
        case .rejected: return stage == "REJECTED"
        case .all: return true
        }
    }
}

struct SupplierListRow: View {
    let s: SupplierRow
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(s.legalName).font(.body.weight(.semibold))
            AdaptiveStack {
                Text(s.stageLabel ?? Labels.supplierStatus[s.status] ?? "Bilinmeyen durum").font(.caption.weight(.semibold))
                    .foregroundStyle(s.status == "ACTIVE" ? Color.secondary : Color.orange)
                // Eski ayrıntı kaybolmasın: Pasif içinde Askıda/Arşiv, Onaylı (koşullu) vb.
                if s.stageLabel != nil, s.status != "ACTIVE", let old = Labels.supplierStatus[s.status], let st = s.stageLabel, !st.localizedCaseInsensitiveContains(old) {
                    Text(old).font(.caption).foregroundStyle(.secondary)
                }
                if let tail = s.taxIdTail { Text(tail).font(.caption.monospaced()).foregroundStyle(.secondary) }
                else { Text("Vergi kimliği doğrulanmadı").font(.caption).foregroundStyle(.secondary) }
            }
            if let alert = s.documentAlert, let b = DocumentValidity.badge(alert) {
                Label(b.text, systemImage: b.icon).font(.caption.weight(.semibold)).foregroundStyle(b.color)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Belge geçerliliği rozeti (metin + simge; renk tek başına anlam taşımaz).
enum DocumentValidity {
    static func badge(_ code: String) -> (text: String, icon: String, color: Color)? {
        switch code {
        case "EXPIRED": ("Belge süresi doldu", "exclamationmark.triangle.fill", .red)
        case "EXPIRING": ("Belge süresi yaklaşıyor", "clock.badge.exclamationmark", .orange)
        default: nil
        }
    }
}
