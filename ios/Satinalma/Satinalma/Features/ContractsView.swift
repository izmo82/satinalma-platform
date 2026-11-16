import SwiftUI

/// Sözleşmeler sekmesi (v2): webdeki listeyle aynı uç (`/api/v1/contracts`, güncel sürümler). Satır, mevcut imza kontrolü
/// ekranını (`SignatureView`) o sürüm için açar; karar ETag ve belge hash'iyle gönderilir (değişmedi).
struct ContractsList: View {
    @Environment(SessionStore.self) private var session
    @State private var items: [ContractRow]?
    @State private var total = 0
    @State private var error: Notice?
    @State private var loadingMore = false
    @State private var moreError: Notice?

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Loadable(value: items, error: error, retry: load) { rows in
                if rows.isEmpty { ContentUnavailableView("Sözleşme yok", systemImage: "doc.richtext", description: Text("Erişiminizdeki güncel sözleşme sürümleri burada görünür.")) }
                ForEach(rows) { c in
                    NavigationLink(value: c) { ContractRowView(c: c) }
                }
                if rows.count < total {
                    Section {
                        Button(loadingMore ? "Yükleniyor…" : "Daha fazla yükle") { Task { await loadMore() } }.disabled(loadingMore)
                        Text("\(total) sözleşmeden \(rows.count) tanesi gösteriliyor.").font(.footnote).foregroundStyle(.secondary)
                        if let moreError { NoticeView(notice: moreError) }
                    }
                }
            }
        }
        .navigationTitle("Sözleşmeler")
        .navigationDestination(for: ContractRow.self) { SignatureView(contractVersionId: $0.id) }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do { let (l, _): (ContractList, String?) = try await session.get("/api/v1/contracts"); items = l.items; total = l.total; error = nil; moreError = nil }
        catch { self.error = Notice.from(error) }
    }

    private func loadMore() async {
        loadingMore = true; defer { loadingMore = false }
        do {
            let (l, _): (ContractList, String?) = try await session.get("/api/v1/contracts?offset=\(items?.count ?? 0)")
            // Sayfalar arasında yeni sözleşme eklenirse aynı satır iki kez gelebilir.
            let known = Set((items ?? []).map(\.id))
            items = (items ?? []) + l.items.filter { !known.contains($0.id) }; total = l.total; moreError = nil
        } catch { moreError = Notice.from(error) }
    }
}

struct ContractRowView: View {
    let c: ContractRow
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(c.title).font(.body.weight(.semibold))
            if let s = c.supplierNames, !s.isEmpty { Text("Tedarikçi: \(s.joined(separator: ", "))").font(.subheadline) }
            Text("Sürüm \(c.versionNo) · \(Labels.stage[c.stage] ?? "Aşama belirtilmedi")\(c.finalizedAt != nil ? " · Kesinleşti" : "")").font(.footnote).foregroundStyle(.secondary)
            Text("Departman: \(c.departmentName ?? "Departmansız")").font(.footnote).foregroundStyle(.secondary)
            Text(Labels.overall[c.signature.overall] ?? "İmza durumu bilinmiyor").font(.caption.weight(.semibold))
                .foregroundStyle(c.signature.overall == "COMPLETE" || c.signature.overall == "NOT_REQUIRED" ? Color.secondary : Color.orange)
            if !c.signature.missingParties.isEmpty { Text("Eksik imza: \(c.signature.missingParties.joined(separator: ", "))").font(.caption).foregroundStyle(.red) }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
