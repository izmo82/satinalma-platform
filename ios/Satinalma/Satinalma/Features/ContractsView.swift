import SwiftUI

/// Sözleşmeler sekmesi (v2): webdeki listeyle aynı uç (`/api/v1/contracts`, güncel sürümler). Satıra dokunmak sözleşme özetini
/// (Faz 3: durum, alanlar, onay zinciri) açar; satırdaki "İmza incelemesi" düğmesi mevcut imza kontrolü ekranını (`SignatureView`)
/// doğrudan açar (eski yol tek dokunuşla korunur; karar ETag ve belge hash'iyle gönderilir, değişmedi).
struct ContractsList: View {
    @Environment(SessionStore.self) private var session
    @State private var items: [ContractRow]?
    @State private var total = 0
    @State private var error: Notice?
    @State private var loadingMore = false
    @State private var moreError: Notice?
    @State private var openSummary: ContractRow?
    @State private var openSignature: ContractRow?

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Loadable(value: items, error: error, retry: load) { rows in
                if rows.isEmpty { ContentUnavailableView("Sözleşme yok", systemImage: "doc.richtext", description: Text("Erişiminizdeki güncel sözleşme sürümleri burada görünür.")) }
                ForEach(rows) { c in
                    // İki ayrı dokunma hedefi: satır gövdesi → özet (aile kimliği yoksa eski sunucu: imza), alttaki düğme → imza incelemesi.
                    VStack(alignment: .leading, spacing: 8) {
                        Button { if c.familyId != nil { openSummary = c } else { openSignature = c } } label: {
                            HStack(alignment: .top) {
                                ContractRowView(c: c)
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint(c.familyId != nil ? "Sözleşme özetini açar" : "İmza incelemesini açar")
                        if c.familyId != nil {
                            Button { openSignature = c } label: { Label("İmza incelemesi", systemImage: "signature").font(.subheadline) }
                                .buttonStyle(.borderless)
                                .accessibilityLabel("\(c.title): imza incelemesi")
                        }
                    }
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
        .navigationDestination(item: $openSignature) { SignatureView(contractVersionId: $0.id) }
        .navigationDestination(item: $openSummary) { c in if let f = c.familyId { ContractSummaryView(familyId: f) } }
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
            if let label = c.statusLabel { StatusBadge(code: c.status, label: label) }
            if let p = c.project, let code = p.code { Text("Proje: \(code)").font(.footnote).foregroundStyle(.secondary) }
            if let s = c.supplierNames, !s.isEmpty { Text("Tedarikçi: \(s.joined(separator: ", "))").font(.subheadline) }
            else if let s = c.supplier { Text("Tedarikçi: \(s.legalName)").font(.subheadline) }
            // v2 durum etiketi varken belge aşaması "Belge:" önekiyle ayrılır (durum "Taslak" ile karışmasın).
            Text("Sürüm \(c.versionNo) · \(c.statusLabel != nil ? "Belge: " : "")\(Labels.stage[c.stage] ?? "Aşama belirtilmedi")\(c.finalizedAt != nil ? " · Kesinleşti" : "")").font(.footnote).foregroundStyle(.secondary)
            Text("Departman: \(c.departmentName ?? "Departmansız")").font(.footnote).foregroundStyle(.secondary)
            Text(Labels.overall[c.signature.overall] ?? "İmza durumu bilinmiyor").font(.caption.weight(.semibold))
                .foregroundStyle(c.signature.overall == "COMPLETE" || c.signature.overall == "NOT_REQUIRED" ? Color.secondary : Color.orange)
            if !c.signature.missingParties.isEmpty { Text("Eksik imza: \(c.signature.missingParties.joined(separator: ", "))").font(.caption).foregroundStyle(.red) }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
