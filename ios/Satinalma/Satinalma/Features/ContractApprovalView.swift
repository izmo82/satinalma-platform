import SwiftUI

/// Sözleşme onayı (Figma iOS 4, v2 Faz 3 R4–R6): tutar, süre, proje, departman, ön inceleme alanı (Faz 4'e kadar boş durum),
/// onay zinciri ("· siz") ve Reddet (gerekçe sayfası) / Onayla. Karar yetkisi sunucuda (`can.decide`); görev ayrılığı ve
/// sıra hataları sunucunun Türkçe mesajıyla gösterilir.
/// İşlerim görevinden adım kimliğiyle (`stepId`), sözleşme özetinden aile kimliğiyle (`familyId`) açılır.
struct ContractApprovalView: View {
    var stepId: String?
    var familyId: String?
    @Environment(SessionStore.self) private var session
    @State private var contract: ContractV2?
    @State private var resolvedFamily: String?
    @State private var error: Notice?
    @State private var notice: Notice?
    @State private var busy = false
    @State private var confirmApprove = false
    @State private var rejecting = false
    @State private var stepGone = false

    private var meId: String? { session.me?.user.id }
    /// Karar verilecek adım: görevin adımı, yoksa zincirin sıradaki adımı.
    /// Karar verilecek adım: zincirin sıradaki adımı (varsa), yoksa görevin adımı (sunucu yine adımı denetler).
    private var decisionStepId: String? { contract?.chain?.steps.first(where: \.current)?.id ?? stepId }

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            if let notice { NoticeView(notice: notice) }
            if stepGone && contract == nil {
                ContentUnavailableView("Bu onay adımı artık sizde değil", systemImage: "checkmark.seal",
                                       description: Text("Adım karara bağlanmış, zincir kapanmış ya da başka kişiye devredilmiş olabilir. İşlerim listesini yenileyin."))
            } else {
                Loadable(value: contract, error: error, retry: load) { c in
                    ContractHeaderCard(c: c)
                    Section("Ön inceleme") { AIReviewEmptyState() }
                    Section("Onay zinciri") { ApprovalChainView(c: c, meId: meId) }
                    if let doc = c.document, let dv = doc.documentVersionId {
                        Section("Belge") {
                            NavigationLink("Sözleşme belgesini aç (sürüm \(doc.versionNo))") {
                                DocumentPreview(documentVersionId: dv, expectedSha256: doc.sha256, title: c.family.title)
                            }
                            NavigationLink("İmza incelemesi") { SignatureView(contractVersionId: doc.contractVersionId) }
                        }
                    }
                    if !c.can.decide {
                        Section {
                            Text(noDecisionReason(c)).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Sözleşme onayı")
        .safeAreaInset(edge: .bottom) {
            if let c = contract, c.can.decide, decisionStepId != nil {
                AdaptiveStack(spacing: 12) {
                    Button { rejecting = true } label: { Text("Reddet").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered).tint(.red)
                    Button { confirmApprove = true } label: { Text(busy ? "Gönderiliyor…" : "Onayla").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                }
                .controlSize(.large)
                .disabled(busy || !session.isOnline)
                .padding()
                .background(.bar)
            }
        }
        .confirmationDialog("Sözleşmeyi onaylıyor musunuz?", isPresented: $confirmApprove, titleVisibility: .visible) {
            Button("Onayla") { Task { await decide("APPROVED", reason: nil) } }
        } message: { Text("Kararınız onay zincirine işlenir ve geri alınamaz.") }
        .sheet(isPresented: $rejecting) {
            RejectReasonSheet { reason in await decide("REJECTED", reason: reason) }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private func noDecisionReason(_ c: ContractV2) -> String {
        if let ch = c.chain, ch.status != "OPEN" { return "Onay zinciri kapandı (\(ContractLabels.chainStatus[ch.status] ?? "kapalı")); karar beklenmiyor." }
        if c.family.createdBy?.id == meId || c.chain?.submittedBy?.id == meId { return "Kendi eklediğiniz ya da onaya gönderdiğiniz sözleşmeye onay kararı veremezsiniz (görev ayrılığı)." }
        return "Sıradaki onay adımı sizde değil; karar düğmeleri yalnız sıradaki onaycıya görünür."
    }

    private func load() async {
        do {
            var fid = resolvedFamily ?? familyId
            if fid == nil, let stepId {
                let (mine, _): (MyApprovals, String?) = try await session.get("/api/v1/contract-approvals/mine")
                fid = mine.items.first { $0.stepId == stepId }?.contract.familyId
            }
            guard let fid else { stepGone = true; error = nil; return }
            resolvedFamily = fid
            let (c, _): (ContractV2, String?) = try await session.get("/api/v1/contracts/\(fid)/v2")
            contract = c; error = nil
        } catch { self.error = Notice.from(error) }
    }

    /// Ret gerekçesi en az 10 karakter (sunucu da denetler). Hata olursa sayfa açık kalır ve mesaj orada görünür.
    @discardableResult
    private func decide(_ decision: String, reason: String?) async -> Notice? {
        guard let step = decisionStepId else { return nil }
        struct Body: Encodable, Sendable { let decision: String; let reason: String? }
        busy = true; defer { busy = false }
        do {
            let r: ApprovalDecisionResult = try await session.post("/api/v1/contract-approval-steps/\(step)/decision", body: Body(decision: decision, reason: reason))
            contract = r.contract
            notice = switch (decision, r.chainStatus) {
            case ("REJECTED", _): Notice(tone: .info, text: "Reddedildi. Gerekçeniz sözleşmeyi gönderen kişiye görev olarak iletildi.")
            case (_, "APPROVED"): Notice(tone: .info, text: "Onaylandı. Zincir tamamlandı; sözleşme yürürlükte.")
            case (_, "CANCELLED"): Notice(tone: .warn, text: "Onayınız kaydedildi, ancak sıradaki adım için uygun onaycı olmadığından zincir iptal edildi; gönderen yeniden gönderecek.")
            default: Notice(tone: .info, text: "Onayınız kaydedildi.\(r.nextStep.map { " Sıradaki: \($0.kindLabel)." } ?? "")")
            }
            rejecting = false
            return nil
        } catch {
            let n = Notice.from(error)
            if let e = error as? APIError, e.isConflict || e.outcomeUnknown { await load() }
            if decision == "APPROVED" { notice = n }
            return n
        }
    }
}

/// Reddet: gerekçe sayfası (≥10 karakter). Gönderim hatası sayfada gösterilir; sayfa kapanmaz.
struct RejectReasonSheet: View {
    let submit: (String) async -> Notice?
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var busy = false
    @State private var notice: Notice?
    private var trimmed: String { reason.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Ret gerekçesi", text: $reason, axis: .vertical).lineLimit(4...10)
                } header: { Text("Gerekçe") } footer: {
                    Text("En az 10 karakter. Gerekçe, sözleşmeyi onaya gönderen kişiye görev olarak iletilir; düzeltip yeniden gönderebilir.")
                }
                if let notice { NoticeView(notice: notice) }
            }
            .navigationTitle("Reddet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Gönderiliyor…" : "Reddet", role: .destructive) {
                        Task {
                            busy = true; defer { busy = false }
                            if let n = await submit(trimmed) { notice = n } else { dismiss() }
                        }
                    }
                    .disabled(busy || trimmed.count < 10)
                }
            }
        }
    }
}

/// Başlık kartı: ad, kod · tedarikçi, tutar, süre, proje, departman, durum (Figma iOS 4 ilk kart).
struct ContractHeaderCard: View {
    let c: ContractV2
    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(c.family.title).font(.title3.weight(.bold)).accessibilityAddTraits(.isHeader)
                Text([c.family.code, c.supplier?.legalName].compactMap { $0 }.joined(separator: " · ")).font(.subheadline).foregroundStyle(.secondary)
                StatusBadge(code: c.status.code, label: c.status.label)
            }
            .padding(.vertical, 2)
            LabeledContent("Tutar", value: amountText)
            LabeledContent("Süre", value: ContractFormat.period(c.fields))
            LabeledContent("Proje", value: projectText)
            LabeledContent("Departman", value: c.family.departmentName ?? "Departmansız")
            if let t = c.fields.contractTypeLabel { LabeledContent("Tür", value: t) }
            if let o = c.owner { LabeledContent("Sözleşme sorumlusu", value: o.displayName) }
        }
    }
    private var amountText: String {
        guard let a = c.fields.amount else { return c.fields.valueType == "UNPRICED" ? "Fiyatsız" : "Girilmedi" }
        return Fmt.money(a, c.fields.currency ?? "TRY") + (c.fields.limitBasis.flatMap { ContractLabels.limitBasis[$0] }.map { " (\($0))" } ?? "")
    }
    private var projectText: String {
        guard let p = c.project else { return "Seçilmedi" }
        if !p.visible { return "Erişiminiz dışında" }
        return [p.code, p.title].compactMap { $0 }.joined(separator: " · ")
    }
}

enum ContractFormat {
    static func period(_ f: ContractV2.Fields) -> String {
        if f.indefinite { return "\(f.startDate.map { Fmt.date($0) + " – " } ?? "")Süresiz\(f.noticePeriod.map { " (ihbar \($0))" } ?? "")" }
        if f.startDate == nil && f.endDate == nil { return "Girilmedi" }
        return "\(Fmt.date(f.startDate)) – \(Fmt.date(f.endDate))"
    }
}

/// Durum etiketi (sunucunun türettiği Türkçe etiket).
struct StatusBadge: View {
    /// Açık/koyu görünüme göre metin rengi (her ikisinde ≥4,5:1 kontrast için).
    static func adaptive(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        Color(UIColor { t in
            let c = t.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }
    let code: String?
    let label: String
    var body: some View {
        let tone = ContractLabels.tone(code)
        let color: Color = switch tone { case .error: .red; case .warn: .orange; case .info: .green; case nil: .secondary }
        // Açık zeminde turuncu/yeşil metin 4,5:1 sağlamaz; metin koyu tonla, zemin renkle verilir.
        let text: Color = switch tone {
        case .warn: StatusBadge.adaptive(light: (0.60, 0.29, 0.0), dark: (1.0, 0.72, 0.40))
        case .info: StatusBadge.adaptive(light: (0.0, 0.42, 0.16), dark: (0.45, 0.88, 0.55))
        case .error: StatusBadge.adaptive(light: (0.70, 0.07, 0.07), dark: (1.0, 0.55, 0.52))
        case nil: .secondary
        }
        Text(label).font(.caption.weight(.semibold)).foregroundStyle(text)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
            .accessibilityLabel("Durum: \(label)")
    }
}

/// Ön inceleme alanı: bu fazda yapay zekâ bağlı değil; puan, güven yüzdesi ya da bulgu gösterilmez (küresel kısıt).
struct AIReviewEmptyState: View {
    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Ön inceleme yok").font(.subheadline.weight(.semibold))
                Text("Yapay zekâ ön incelemesi bağlı değil (Faz 4). Koşulları belgeden kendiniz okuyun.").font(.footnote).foregroundStyle(.secondary)
            }
        } icon: { Image(systemName: "sparkles").foregroundStyle(.secondary) }
        .accessibilityElement(children: .combine)
    }
}

/// Onay zinciri: sıra, unvan, kişi, karar ve gerekçe; oturumdaki kişinin adımı "· siz" ile işaretlenir.
struct ApprovalChainView: View {
    let c: ContractV2
    let meId: String?
    var body: some View {
        if let chain = c.chain {
            if chain.status != "OPEN" {
                Text("Zincir: \(ContractLabels.chainStatus[chain.status] ?? chain.status)\(chain.closedAt.map { " · \(Fmt.date($0))" } ?? "")").font(.footnote.weight(.semibold))
                if let r = chain.cancelReason { Text("İptal nedeni: \(r)").font(.footnote).foregroundStyle(.orange) }
            }
            if let by = chain.submittedBy { Text("Gönderen: \(by.displayName)\(chain.submittedAt.map { " · \(Fmt.date($0))" } ?? "")").font(.footnote).foregroundStyle(.secondary) }
            if let note = chain.note, !note.isEmpty { Text("Not: \(note)").font(.footnote) }
            ForEach(chain.steps) { s in
                VStack(alignment: .leading, spacing: 3) {
                    AdaptiveStack {
                        Image(systemName: icon(s)).foregroundStyle(color(s)).accessibilityHidden(true)
                        Text("\(s.order). \(s.kindLabel)\(isMe(s) ? " · siz" : "")").font(.subheadline.weight(s.current ? .bold : .regular))
                    }
                    Text(person(s)).font(.footnote).foregroundStyle(.secondary)
                    if let d = s.decision {
                        Text("\(s.decidedBy?.displayName ?? "") \(ContractLabels.decision[d] ?? d)\(s.decidedAt.map { " · \(Fmt.date($0))" } ?? "")").font(.footnote)
                    } else if s.current, chain.status == "OPEN" {
                        Text("Karar bekleniyor").font(.footnote).foregroundStyle(.orange)
                    }
                    if let r = s.reason, !r.isEmpty { Text("Gerekçe: \(r)").font(.footnote).foregroundStyle(s.decision == "REJECTED" ? .red : .primary) }
                }
                .accessibilityElement(children: .combine)
            }
            if c.chainCount > 1 { Text("Bu sözleşme \(c.chainCount). kez onaya gönderildi; önceki zincirler webde geçmişte görünür.").font(.footnote).foregroundStyle(.secondary) }
        } else {
            Text(c.legacy ? "Onay kaydı yok (eski kayıt)." : "Henüz onaya gönderilmedi.").font(.footnote).foregroundStyle(.secondary)
        }
    }
    private func isMe(_ s: ContractV2.Step) -> Bool { meId != nil && (s.assignedUser?.id == meId || s.deputyUser?.id == meId) }
    private func person(_ s: ContractV2.Step) -> String {
        let name = s.assignedUser?.displayName ?? "Atanmadı"
        return s.viaDeputy ? "\(name) (vekil)" : name
    }
    private func icon(_ s: ContractV2.Step) -> String {
        switch s.decision { case "APPROVED": "checkmark.circle.fill"; case "REJECTED": "xmark.circle.fill"; default: s.current ? "clock" : "circle" }
    }
    private func color(_ s: ContractV2.Step) -> Color {
        switch s.decision { case "APPROVED": .green; case "REJECTED": .red; default: s.current ? .orange : .secondary }
    }
}

/// Sözleşme özeti (v2): Sözleşmeler satırından ve ret / yeniden gönder / hatırlatıcı görevlerinden açılır.
/// İmza incelemesi ilk eylemdir; listede satırdaki "İmza incelemesi" düğmesi de doğrudan açar (dokunuş artmaz).
struct ContractSummaryView: View {
    let familyId: String
    @Environment(SessionStore.self) private var session
    @State private var contract: ContractV2?
    @State private var error: Notice?

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Loadable(value: contract, error: error, retry: load) { c in
                Section {
                        if let doc = c.document {
                            NavigationLink { SignatureView(contractVersionId: doc.contractVersionId) } label: { Label("İmza incelemesi", systemImage: "signature") }
                            if let dv = doc.documentVersionId {
                                NavigationLink { DocumentPreview(documentVersionId: dv, expectedSha256: doc.sha256, title: c.family.title) } label: {
                                    Label("Belgeyi aç (sürüm \(doc.versionNo))", systemImage: "doc.text.magnifyingglass")
                                }
                            }
                        }
                        if c.can.decide {
                            NavigationLink { ContractApprovalView(familyId: c.family.id) } label: { Label("Onay kararı ver", systemImage: "checkmark.seal") }
                        }
                        if c.can.edit || c.can.submit {
                            NavigationLink { ContractFieldsView(familyId: c.family.id) } label: {
                                Label(c.status.code == "REJECTED" ? "Düzelt ve yeniden gönder" : "Alanları tamamla ve onaya gönder", systemImage: "square.and.pencil")
                            }
                        }
                }
                ContractHeaderCard(c: c)
                if !c.missing.isEmpty {
                    Section("Eksik alanlar") {
                        Text(c.missing.map(\.label).joined(separator: ", ")).font(.subheadline).foregroundStyle(.red)
                        Text(c.legacy ? "Eski kayıt: zorunlu alanlar doldurulunca onaya gönderilebilir." : "Zorunlu alanlar tamamlanmadan onaya gönderilemez.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Onay zinciri") { ApprovalChainView(c: c, meId: session.me?.user.id) }
                Section { Text("Koşullar, yükümlülükler, ticari kayıtlar ve hatırlatıcılar web uygulamasındaki sözleşme ayrıntısında.").font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(contract?.family.code ?? "Sözleşme")
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do { let (c, _): (ContractV2, String?) = try await session.get("/api/v1/contracts/\(familyId)/v2"); contract = c; error = nil }
        catch { self.error = Notice.from(error) }
    }
}
