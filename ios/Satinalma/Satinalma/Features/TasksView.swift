import SwiftUI

struct TasksView: View {
    @Environment(SessionStore.self) private var session
    @State private var tasks: [TaskItem]?
    @State private var error: Notice?

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Loadable(value: tasks, error: error, retry: load) { items in
                if items.isEmpty { ContentUnavailableView("Bekleyen işiniz yok", systemImage: "tray", description: Text("Rolünüze atanmış işler burada görünür.")) }
                ForEach(items) { task in
                    if TaskDestination.opensOnMobile(task.entityType) {
                        NavigationLink(value: task) { TaskRow(task: task) }
                    } else {
                        // Mobil ekranı olmayan ya da bilinmeyen tür: gezinme yok, açıklama satırın içinde (çökme yok).
                        VStack(alignment: .leading, spacing: 4) {
                            TaskRow(task: task)
                            Label("Bu iş web uygulamasında yapılır.", systemImage: "desktopcomputer").font(.footnote).foregroundStyle(.secondary)
                        }.accessibilityElement(children: .combine)
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
        do { let (list, _): (TaskList, String?) = try await session.get("/api/v1/tasks?view=mine"); tasks = list.items; error = nil }
        catch { self.error = Notice.from(error) }
    }
}

struct TaskRow: View {
    let task: TaskItem
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AdaptiveStack {
                Text(Labels.severity[task.severity] ?? task.severity).font(.caption.weight(.semibold)).foregroundStyle(task.severity == "NORMAL" ? Color.secondary : Color.orange)
                if let ref = task.refNo { Text(ref).font(.caption.monospaced()).foregroundStyle(.secondary) }
                HSpacer()
                if let due = task.dueAt { Text("Son: \(Fmt.date(due))").font(.caption).foregroundStyle(.secondary) }
            }
            Text(task.title).font(.body.weight(.semibold))
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
    static func opensOnMobile(_ entityType: String) -> Bool { ["contract_version", "invoice", "incident", "document_version"].contains(entityType) }
    var body: some View {
        switch task.entityType {
        case "contract_version": SignatureView(contractVersionId: task.entityId)
        case "invoice": InvoiceView(invoiceId: task.entityId)
        case "incident": IncidentView(incidentId: task.entityId)
        case "document_version": DocumentPreview(documentVersionId: task.entityId, expectedSha256: nil, title: task.title)
        default:
            ContentUnavailableView("Bu iş webde yapılır", systemImage: "desktopcomputer",
                                   description: Text("\(task.title)\n\nBu kayıt türü için mobil ekran yok; aynı görev web uygulamasında açıktır."))
        }
    }
}
