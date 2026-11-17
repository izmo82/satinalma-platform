import SwiftUI

struct TasksView: View {
    @Environment(SessionStore.self) private var session
    @State private var tasks: [TaskItem]?
    @State private var error: Notice?
    @State private var total: Int?
    @State private var nextOffset: Int?
    @State private var loadingMore = false
    @State private var moreError: Notice?

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Loadable(value: tasks, error: error, retry: load) { items in
                if items.isEmpty { ContentUnavailableView("Bekleyen işiniz yok", systemImage: "tray", description: Text("Rolünüze atanmış işler burada görünür.")) }
                ForEach(items) { task in
                    if TaskDestination.opensOnMobile(task) {
                        NavigationLink(value: task) { TaskRow(task: task) }
                    } else {
                        // Mobil ekranı olmayan ya da bilinmeyen tür: gezinme yok, açıklama satırın içinde (çökme yok).
                        VStack(alignment: .leading, spacing: 4) {
                            TaskRow(task: task)
                            Label("Bu iş web uygulamasında yapılır.", systemImage: "desktopcomputer").font(.footnote).foregroundStyle(.secondary)
                        }.accessibilityElement(children: .combine)
                    }
                }
                // Persona K2: 200'den fazla işte sonraki sayfalar; sayı sunucu sayacıyla aynı.
                if let total, total > items.count || nextOffset != nil {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(items.count) / \(total) iş gösteriliyor").font(.footnote).foregroundStyle(.secondary)
                        if nextOffset != nil {
                            Button(loadingMore ? "Yükleniyor…" : "Daha fazla yükle") { Task { await loadMore() } }.disabled(loadingMore)
                        }
                        if let moreError { Text(moreError.text).font(.footnote).foregroundStyle(.red) }
                    }
                }
            }
        }
        .navigationTitle("İşlerim")
        .navigationDestination(for: TaskItem.self) { TaskDestination(task: $0) }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            let (list, _): (TaskList, String?) = try await session.get("/api/v1/tasks?view=mine")
            tasks = list.items; total = list.total; nextOffset = list.nextOffset; moreError = nil; error = nil
        }
        catch { self.error = Notice.from(error) }
    }

    private func loadMore() async {
        guard let offset = nextOffset, !loadingMore else { return }
        loadingMore = true; defer { loadingMore = false }
        do {
            let (list, _): (TaskList, String?) = try await session.get("/api/v1/tasks?view=mine&offset=\(offset)")
            let known = Set((tasks ?? []).map(\.id))
            tasks = (tasks ?? []) + list.items.filter { !known.contains($0.id) }
            nextOffset = list.nextOffset; total = list.total ?? total; moreError = nil
        } catch { moreError = Notice.from(error) }
    }
}

struct TaskRow: View {
    let task: TaskItem
    /// Sözleşme görevlerinin türü (Figma İşlerim kartlarındaki üst satır).
    static let kindLabel: [String: String] = [
        "contract_approval": "Sözleşme onayı", "contract_rejected": "Reddedilen sözleşme", "contract_resubmit": "Yeniden onaya gönderin",
        "contract_reminder": "Sözleşme bitişi",
        "supplier_application_review": "Tedarikçi başvurusu", "supplier_document_expired": "Tedarikçi belgesi", "supplier_document_renewed": "Tedarikçi belgesi",
        "supplier_document_av_error": "Tedarikçi belgesi", "supplier_offboarding": "Tedarikçi ayrılışı", "supplier_no_portal_user": "Portal kullanıcısı yok",
        "supplier_profile_change_request": "Tedarikçi değişiklik isteği",
        "risk_assessment_due": "Yıllık risk", "risk_assessment_department": "Yıllık risk", "risk_assessment_escalated": "Yıllık risk",
        "risk_quarterly_review": "Çeyreklik risk gözden geçirme", "risk_high_level": "Yıllık risk",
    ]
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AdaptiveStack {
                Text(Labels.severity[task.severity] ?? task.severity).font(.caption.weight(.semibold)).foregroundStyle(task.severity == "NORMAL" ? Color.secondary : Color.orange)
                if let ref = task.refNo { Text(ref).font(.caption.monospaced()).foregroundStyle(.secondary) }
                HSpacer()
                if let due = task.dueAt { Text("Son: \(Fmt.date(due))").font(.caption).foregroundStyle(.secondary) }
            }
            if let kind = TaskRow.kindLabel[task.kind] { Text(kind).font(.footnote).foregroundStyle(.secondary) }
            Text(task.title).font(.body.weight(.semibold))
            if task.kind == "contract_approval" { StatusBadge(code: "IN_APPROVAL", label: "Onayınızı bekliyor") }
            Text(task.reason).font(.subheadline).foregroundStyle(.secondary)
            Text(task.nextAction).font(.footnote)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Görevin bağlı olduğu kayıt: aynı API ve yetkiyle mobil ekran (T45); karşılığı olmayan tür için açık mesaj.
/// Fatura görevi salt okunur fatura ayrıntısını açar (v2: iOS fatura onayı kalktı).
struct TaskDestination: View {
    let task: TaskItem
    /// v2 Faz 5: web'de yapılan tedarikçi görevleri; dokunulunca "Bu iş web'de yapılır" bilgisi (R16).
    static let webOnlySupplierKinds: Set<String> = [
        "supplier_application_review", "supplier_document_expired", "supplier_document_av_error", "supplier_document_renewed",
        "supplier_offboarding", "supplier_no_portal_user", "supplier_profile_change_request",
    ]
    static func opensOnMobile(_ task: TaskItem) -> Bool { webOnlySupplierKinds.contains(task.kind) || opensOnMobile(task.entityType) }
    static func opensOnMobile(_ entityType: String) -> Bool {
        ["contract_version", "invoice", "incident", "document_version", "contract_approval_step", "contract_rejection", "contract_family", "contract_reminder", "risk_assessment"].contains(entityType)
    }
    var body: some View {
        if Self.webOnlySupplierKinds.contains(task.kind) { webOnly } else { mobile }
    }
    /// Başvuru incelemesi, belge yenileme, ayrılış ve portal kullanıcısı işleri web'de; kayıt tedarikçiyse salt okunur özet açılabilir.
    private var webOnly: some View {
        List {
            Section {
                Label("Bu iş web'de yapılır", systemImage: "desktopcomputer").font(.headline)
                Text(task.title).font(.body.weight(.semibold))
                Text(task.reason).font(.subheadline).foregroundStyle(.secondary)
                Text("Bu işlem için mobil ekran yok; aynı görev web uygulamasında açıktır.").font(.footnote).foregroundStyle(.secondary)
            }
            // Özet yalnız entityType "supplier" için: başvuru görevlerinde (supplier_application) kayıt kimliği tedarikçi kartı değildir.
            if task.entityType == "supplier" {
                Section { NavigationLink { SupplierSummaryView(supplierId: task.entityId, title: task.title) } label: { Label("Tedarikçi özetini gör", systemImage: "building.2") } }
            }
        }
        .navigationTitle("İş").navigationBarTitleDisplayMode(.inline)
    }
    @ViewBuilder private var mobile: some View {
        switch task.entityType {
        case "contract_version": SignatureView(contractVersionId: task.entityId)
        case "invoice": InvoiceView(invoiceId: task.entityId)
        case "incident": IncidentView(incidentId: task.entityId)
        case "document_version": DocumentPreview(documentVersionId: task.entityId, expectedSha256: nil, title: task.title)
        // v2 Faz 3: onay adımı → Sözleşme onayı; ret, yeniden gönder ve bitiş hatırlatıcısı (kimlik = aile) → sözleşme özeti.
        case "contract_approval_step": ContractApprovalView(stepId: task.entityId)
        case "contract_rejection", "contract_family", "contract_reminder": ContractSummaryView(familyId: task.entityId)
        // v2 Faz 6 (R15): risk görevi salt okunur özet açar; form web'de.
        case "risk_assessment": RiskAssessmentView(assessmentId: task.entityId, title: task.title)
        default:
            ContentUnavailableView("Bu iş webde yapılır", systemImage: "desktopcomputer",
                                   description: Text("\(task.title)\n\nBu kayıt türü için mobil ekran yok; aynı görev web uygulamasında açıktır."))
        }
    }
}
