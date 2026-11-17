import SwiftUI

/// "Alanları doğrula" (Figma iOS 3, v2 Faz 3 R2/R9/R10): taranan sözleşme belgesinden taslak açılır ve zorunlu alanlar
/// insan tarafından girilir. Yapay zekâ okuması bu fazda yok; alanlar boş gelir ve ekran bunu açıkça söyler.
/// Proje zorunludur (taslak projeyle açılır); departman projenin departmanıdır, değiştirilebilir. Tutar decimal metin olarak
/// gönderilir. Devam → "İncele ve gönder" özeti → onaya gönderim. Gönderilmeyen taslak webde Sözleşmeler'de açılır.
struct ContractFieldsView: View {
    /// Yeni tarama: yüklenen belge sürümü ve yerel taslak kimliği. Mevcut sözleşme: aile kimliği.
    var documentVersionId: String?
    var draftId: UUID?
    @State var familyId: String?

    @Environment(SessionStore.self) private var session
    @Environment(DraftStore.self) private var drafts
    @State private var loaded: ContractV2?
    @State private var projects: [ProjectOption]?
    @State private var departments: [Me.Department] = []
    @State private var suppliers: [SupplierOption] = []
    @State private var members: [MemberOption] = []
    @State private var loadError: Notice?
    @State private var notice: Notice?
    @State private var busy = false
    @State private var showReview = false
    @State private var addingSupplier = false

    @State private var projectId = ""
    @State private var departmentId = ""
    @State private var supplierId = ""
    @State private var contractType = ""
    @State private var ownerUserId = ""
    @State private var signedOn: Date?
    @State private var startDate: Date?
    @State private var endDate: Date?
    @State private var indefinite = false
    @State private var amountText = ""
    @State private var limitBasis = "NET"
    @State private var autoRenewal = false
    @State private var renewalMonths = 12
    @State private var noticeAmount: Int?
    @State private var noticeUnit = "MONTH"
    @State private var compared = false
    @State private var supplierHint: String?
    @State private var memberHint: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    init(documentVersionId: String, draftId: UUID?, familyId: String?) {
        self.documentVersionId = documentVersionId; self.draftId = draftId; _familyId = State(initialValue: familyId)
    }
    init(familyId: String) { _familyId = State(initialValue: familyId) }

    private var amount: String? { ContractInput.decimal(amountText) }
    private var needsNotice: Bool { indefinite || autoRenewal }
    private var canContinue: Bool {
        !projectId.isEmpty && compared && !busy && session.isOnline && (amountText.isEmpty || amount != nil)
    }

    var body: some View {
        Form {
            OfflineBanner().listRowInsets(EdgeInsets())
            Section {
                Label(ContractLabels.aiNotConnected, systemImage: "sparkles").font(.footnote).foregroundStyle(.secondary)
            }
            if let notice { NoticeView(notice: notice) }
            if let loadError {
                Section {
                    NoticeView(notice: loadError)
                    Button("Yeniden dene") { Task { await loadOptions() } }
                }
            }
            Section {
                // Proje → departman varsayılanı yalnız kullanıcı projeyi değiştirdiğinde uygulanır; kayıtlı departman
                // (ön doldurma) asla geri çevrilmez ve PUT edilmez.
                Picker(selection: Binding(get: { projectId }, set: { userSelectedProject($0) })) {
                    Text("Seçilmedi").tag("")
                    ForEach(projects ?? []) { Text("\($0.code) · \($0.title)").tag($0.id) }
                } label: {
                    VStack(alignment: .leading) {
                        Text("İlgili proje")
                        if projectId.isEmpty { Text("Seçilmedi. Zorunlu alan.").font(.footnote).foregroundStyle(.red) }
                    }
                }
                .pickerStyle(.navigationLink)
                Picker("İlgili departman", selection: $departmentId) {
                    Text("Projenin departmanı").tag("")
                    ForEach(departments) { Text($0.name).tag($0.id) }
                }
                .pickerStyle(.navigationLink)
            } header: { Text("Proje") } footer: { Text("Sözleşme projeye bağlanır; departman varsayılan olarak projenin departmanıdır.") }
            Section("Tedarikçi ve tür") {
                Picker("Tedarikçi", selection: $supplierId) {
                    Text("Seçilmedi").tag("")
                    ForEach(suppliers) { Text($0.displayName).tag($0.id) }
                }
                .pickerStyle(.navigationLink)
                if let supplierHint { Text(supplierHint).font(.footnote).foregroundStyle(.orange) }
                Button { addingSupplier = true } label: { Label("Kayıtlı değil: aday tedarikçi ekle", systemImage: "plus.circle") }
                Picker("Sözleşme türü", selection: $contractType) {
                    Text("Seçilmedi").tag("")
                    ForEach(ContractLabels.types, id: \.0) { Text($0.1).tag($0.0) }
                }
                Picker("Sözleşme sorumlusu", selection: $ownerUserId) {
                    Text("Seçilmedi").tag("")
                    ForEach(members) { Text($0.displayName).tag($0.id) }
                }
                .pickerStyle(.navigationLink)
                if let memberHint { Text(memberHint).font(.footnote).foregroundStyle(.orange) }
            }
            Section("Tarihler") {
                OptionalDateRow(title: "İmza tarihi", date: $signedOn)
                OptionalDateRow(title: "Başlangıç", date: $startDate)
                Toggle("Süresiz sözleşme", isOn: $indefinite)
                if !indefinite { OptionalDateRow(title: "Bitiş", date: $endDate) }
                Toggle("Otomatik yenileme", isOn: $autoRenewal)
                if autoRenewal { Stepper("Yenileme süresi: \(renewalMonths) ay", value: $renewalMonths, in: 1...120) }
                if needsNotice {
                    AdaptiveStack {
                        TextField("İhbar süresi", value: $noticeAmount, format: .number).keyboardType(.numberPad)
                        Picker("Birim", selection: $noticeUnit) { Text("gün").tag("DAY"); Text("ay").tag("MONTH") }.adaptivePicker(typeSize)
                    }
                    Text("Süresiz ya da otomatik yenilenen sözleşmede ihbar süresi zorunludur.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                TextField("Tutar", text: $amountText, prompt: Text("ör. 2.400.000,00")).keyboardType(.decimalPad)
                if !amountText.isEmpty {
                    if let amount { Text(Fmt.money(amount, "TRY")).font(.footnote).foregroundStyle(.secondary) }
                    else { Text("Tutar okunamadı; en fazla iki ondalık hane girin.").font(.footnote).foregroundStyle(.red) }
                }
                Picker("KDV", selection: $limitBasis) { Text("KDV hariç").tag("NET"); Text("KDV dahil").tag("GROSS") }.adaptivePicker(typeSize)
            } header: { Text("Tutar (TRY)") }
            Section {
                Toggle("Tutar, tarih ve VKN'yi belgeyle karşılaştırdım.", isOn: $compared)
                Button { Task { await saveAndContinue() } } label: {
                    Text(busy ? "Kaydediliyor…" : "Devam: İncele ve gönder").frame(maxWidth: .infinity).font(.body.weight(.semibold))
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(!canContinue)
                .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
            } footer: {
                Text(familyId == nil ? "Devam ettiğinizde sözleşme taslağı açılır; gönderilmeden bırakırsanız webde Sözleşmeler'de tamamlanabilir." : "Taslak kayıtlı; değişiklikler kaydedilir. Onaydaki bir sözleşmede değişiklik onayı baştan başlatır.")
            }
        }
        .navigationTitle("Alanları doğrula")
        .navigationDestination(isPresented: $showReview) { if let familyId { ContractSubmitView(familyId: familyId) } }
        .sheet(isPresented: $addingSupplier) {
            CandidateSupplierSheet { s in
                if !suppliers.contains(where: { $0.id == s.id }) { suppliers.insert(SupplierOption(id: s.id, legalName: s.legalName, status: s.status, label: nil), at: 0) }
                supplierId = s.id
                notice = Notice(tone: .info, text: s.existing ? "Bu VKN ile kayıtlı firma seçildi: \(s.legalName)." : "Aday tedarikçi kartı açıldı: \(s.legalName). Satınalma kartı sonradan tamamlar.")
            }
        }
        .task { if projects == nil { await loadOptions() } }
    }

    /// Kullanıcı projeyi seçti: departman projenin departmanına geçer (kullanıcı yine değiştirebilir).
    private func userSelectedProject(_ id: String) {
        guard id != projectId else { return }
        projectId = id
        if let p = projects?.first(where: { $0.id == id }), let d = p.departmentId, departments.contains(where: { $0.id == d }) { departmentId = d }
    }

    private func loadOptions() async {
        do {
            // Seçenekler paralel yüklenir; tedarikçi/kişi listesi alınamazsa alan boş kalır ve ipucu gösterilir.
            async let projectsReq: (ProjectOptions, String?) = session.get("/api/v1/projects")
            async let suppliersReq: (SupplierOptions, String?) = session.get("/api/v1/supplier-options")
            async let membersReq: ([MemberOption], String?) = session.get("/api/v1/members")
            let allDepartments = session.me?.allDepartments == true
            async let departmentsReq: (DepartmentOptions, String?)? = allDepartments ? session.get("/api/v1/departments") : nil
            projects = try await projectsReq.0.items
            departments = allDepartments ? (try await departmentsReq?.0.items ?? []) : (session.me?.departments ?? [])
            do { suppliers = try await suppliersReq.0.items; supplierHint = nil }
            catch { supplierHint = "Tedarikçi listesi alınamadı (\(Notice.from(error).text)). Aday tedarikçi ekleyebilir ya da taslağı webde tamamlayabilirsiniz." }
            do { members = try await membersReq.0; memberHint = nil }
            catch { memberHint = "Kişi listesi alınamadı (\(Notice.from(error).text)); sözleşme sorumlusunu webde seçin." }
            if let familyId {
                let (c, _): (ContractV2, String?) = try await session.get("/api/v1/contracts/\(familyId)/v2")
                prefill(c)
            } else if ownerUserId.isEmpty, let me = session.me?.user.id, members.contains(where: { $0.id == me }) {
                ownerUserId = me
            }
            loadError = nil
        } catch { loadError = Notice.from(error) }
    }

    private func prefill(_ c: ContractV2) {
        loaded = c
        let f = c.fields
        projectId = f.projectId ?? ""
        departmentId = c.family.departmentId ?? ""
        supplierId = f.supplierId ?? ""
        if !supplierId.isEmpty, !suppliers.contains(where: { $0.id == supplierId }), let s = c.supplier {
            suppliers.insert(SupplierOption(id: s.id, legalName: s.legalName, status: s.status, label: nil), at: 0)
        }
        contractType = f.contractType ?? ""
        ownerUserId = f.ownerUserId ?? ""
        if let o = c.owner, !members.contains(where: { $0.id == o.id }) { members.insert(MemberOption(id: o.id, displayName: o.displayName), at: 0) }
        signedOn = ContractInput.date(f.signedOn); startDate = ContractInput.date(f.startDate); endDate = ContractInput.date(f.endDate)
        indefinite = f.indefinite
        amountText = f.amount.map(ContractInput.display) ?? ""
        limitBasis = f.limitBasis ?? "NET"
        autoRenewal = f.autoRenewal ?? false
        renewalMonths = f.renewalMonths ?? 12
        noticeAmount = f.noticeAmount
        noticeUnit = f.noticeUnit ?? "MONTH"
    }

    /// Alanlar → PUT gövdesi. Mevcut sözleşmede yalnız değişen anahtarlar gönderilir (değişmeyen alan onayı iptal etmez).
    private func body(for c: ContractV2?) -> [String: JSONValue] {
        let f = c?.fields
        var b: [String: JSONValue] = [:]
        func put(_ key: String, _ value: JSONValue, _ old: JSONValue) { if c == nil || value != old { b[key] = value } }
        put("projectId", .str(projectId), .opt(f?.projectId))
        if !departmentId.isEmpty { put("departmentId", .str(departmentId), .opt(c?.family.departmentId)) }
        put("supplierId", .opt(supplierId.ifEmptyNil), .opt(f?.supplierId))
        put("contractType", .opt(contractType.ifEmptyNil), .opt(f?.contractType))
        put("ownerUserId", .opt(ownerUserId.ifEmptyNil), .opt(f?.ownerUserId))
        put("signedOn", .opt(signedOn.map(ContractInput.iso)), .opt(f?.signedOn))
        put("indefinite", .bool(indefinite), .bool(f?.indefinite ?? false))
        // Koşul anahtarları: tutar girilmeden ilk koşul revizyonu açılamaz; tutarsız taslakta yalnız aile alanları kaydedilir.
        if let amount {
            put("currency", .str("TRY"), .opt(f?.currency))
            put("amount", .str(amount), .opt(f?.amount))
            put("limitBasis", .str(limitBasis), .opt(f?.limitBasis))
            put("startDate", .opt(startDate.map(ContractInput.iso)), .opt(f?.startDate))
            if !indefinite { put("endDate", .opt(endDate.map(ContractInput.iso)), .opt(f?.endDate)) }
            put("autoRenewal", .bool(autoRenewal), f?.autoRenewal.map(JSONValue.bool) ?? .null)
            if autoRenewal { put("renewalMonths", .int(renewalMonths), f?.renewalMonths.map(JSONValue.int) ?? .null) }
        }
        // Süresizde ihbar aileye yazılır; süreli sözleşmede koşul revizyonuna (tutar gerekir).
        if needsNotice && (indefinite || amount != nil) {
            put("noticeAmount", noticeAmount.map(JSONValue.int) ?? .null, f?.noticeAmount.map(JSONValue.int) ?? .null)
            if noticeAmount != nil { put("noticeUnit", .str(noticeUnit), .opt(f?.noticeUnit)) }
        }
        return b
    }

    private func saveAndContinue() async {
        busy = true; defer { busy = false }
        notice = nil
        do {
            if familyId == nil {
                guard let documentVersionId else { return }
                struct Draft: Encodable, Sendable { let documentVersionId: String; let projectId: String; let departmentId: String? }
                let r: ContractDraftCreated = try await session.post("/api/v1/contract-drafts", body: Draft(documentVersionId: documentVersionId, projectId: projectId, departmentId: departmentId.ifEmptyNil))
                familyId = r.familyId
                if let draftId { drafts.setContractFamily(draftId, familyId: r.familyId) }
                if let d = r.duplicateOf { notice = Notice(tone: .warn, text: "Aynı belge daha önce \(d.code) (\(d.title)) olarak eklenmiş; yine de yeni taslak açıldı. Gereksizse webden kaldırın.") }
                let (c, _): (ContractV2, String?) = try await session.get("/api/v1/contracts/\(r.familyId)/v2")
                loaded = c
            }
            guard let familyId else { return }
            let b = body(for: loaded)
            if !b.isEmpty {
                let c: ContractV2 = try await session.post("/api/v1/contracts/\(familyId)/fields", body: b, method: "PUT")
                loaded = c
            }
            showReview = true
        } catch { notice = Notice.from(error) }
    }
}

/// İnceleme ve gönderim: alan özeti, eksikler, onay zinciri önizlemesi ve "Onaya gönder".
struct ContractSubmitView: View {
    let familyId: String
    @Environment(SessionStore.self) private var session
    @State private var contract: ContractV2?
    @State private var preview: ApprovalPreview?
    @State private var error: Notice?
    @State private var notice: Notice?
    @State private var useDeputy = false
    @State private var note = ""
    @State private var busy = false

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            if let notice { NoticeView(notice: notice) }
            Loadable(value: contract, error: error, retry: load) { c in
                ContractHeaderCard(c: c)
                if let s = c.supplier { Section("Tedarikçi") { LabeledContent(s.legalName, value: Labels.supplierStatus[s.status] ?? "Durum bilinmiyor") } }
                if !c.missing.isEmpty {
                    Section("Eksik alanlar") {
                        Text(c.missing.map(\.label).joined(separator: ", ")).foregroundStyle(.red)
                        Text("Eksikler tamamlanmadan onaya gönderilemez. Geri dönüp doldurun ya da taslağı webde tamamlayın.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if c.chain?.status == "OPEN" || c.status.code == "APPROVED" {
                    Section("Onay zinciri") { ApprovalChainView(c: c, meId: session.me?.user.id) }
                } else if !c.can.submit {
                    Section("Onay zinciri") {
                        if c.chain != nil { ApprovalChainView(c: c, meId: session.me?.user.id) }
                        Text(c.chain?.status == "REJECTED" || c.status.code == "REJECTED"
                             ? "Bu sözleşme reddedildi. Yalnız ekleyen ya da Satınalma düzeltip yeniden gönderebilir."
                             : "Bu sözleşmeyi onaya gönderme yetkiniz yok; yalnız ekleyen ya da Satınalma gönderebilir.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        Toggle("Departman sorumlusu yerine vekiline gönder", isOn: $useDeputy)
                        if let p = preview {
                            if p.ok { ForEach(p.steps ?? []) { s in LabeledContent("\(s.order). \(s.kindLabel)", value: s.displayName + (s.viaDeputy ? " (vekil)" : "")) } }
                            else { Text(p.message ?? "Onay zinciri kurulamıyor.").foregroundStyle(.red) }
                        } else { ProgressView() }
                        TextField("Not (isteğe bağlı)", text: $note, axis: .vertical)
                    } header: { Text("Onay zinciri") } footer: {
                        Text("Önizleme, gönderen siz olursanız oluşacak zinciri gösterir. Ek onaycı web uygulamasında eklenir.")
                    }
                    Section {
                        Button { Task { await submit() } } label: { Text(busy ? "Gönderiliyor…" : "Onaya gönder").frame(maxWidth: .infinity).font(.body.weight(.semibold)) }
                            .buttonStyle(.borderedProminent).controlSize(.large)
                            .disabled(busy || !c.missing.isEmpty || preview?.ok != true || !session.isOnline)
                            .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                    } footer: {
                        Text("Taslak \(c.family.code) kayıtlı. Şimdi göndermezseniz webde Sözleşmeler'de açıp tamamlayabilirsiniz.")
                    }
                }
                Section("Ön inceleme") { AIReviewEmptyState() }
            }
        }
        .navigationTitle("İncele ve gönder")
        // Önizleme vekil seçimine bağlı: seçim değişince eski önizleme silinir, yenisi yüklenir (yapısal görev, iptal edilebilir).
        .task(id: useDeputy) { if contract?.can.submit == true { await loadPreview() } }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            let (c, _): (ContractV2, String?) = try await session.get("/api/v1/contracts/\(familyId)/v2")
            contract = c; error = nil
            if c.can.submit { await loadPreview() }
        } catch { self.error = Notice.from(error) }
    }

    private func loadPreview() async {
        preview = nil
        do {
            let (p, _): (ApprovalPreview, String?) = try await session.get("/api/v1/contracts/\(familyId)/approval-preview\(useDeputy ? "?useDeputyForHead=true" : "")")
            preview = p
        } catch { preview = ApprovalPreview(ok: false, steps: nil, message: Notice.from(error).text) }
    }

    private func submit() async {
        struct Body: Encodable, Sendable { let useDeputyForHead: Bool; let note: String? }
        busy = true; defer { busy = false }
        do {
            let r: ContractSubmitResult = try await session.post("/api/v1/contracts/\(familyId)/submit", body: Body(useDeputyForHead: useDeputy, note: note.trimmingCharacters(in: .whitespacesAndNewlines).ifEmptyNil))
            contract = r.contract
            notice = Notice(tone: .info, text: "Onaya gönderildi: \(r.contract.status.label). İlk onaycıya İşlerim görevi açıldı.")
        } catch {
            notice = Notice.from(error)
            if let e = error as? APIError, e.isConflict || e.outcomeUnknown { await load() }
        }
    }
}

/// Aday tedarikçi (R9): unvan + VKN (+ e-posta). Aynı VKN varsa sunucu mevcut kartı döner.
struct CandidateSupplierSheet: View {
    let done: (CandidateSupplier) -> Void
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var legalName = ""
    @State private var vkn = ""
    @State private var email = ""
    @State private var busy = false
    @State private var notice: Notice?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Unvan", text: $legalName)
                    TextField("VKN (10 hane) / TCKN (11 hane)", text: $vkn).keyboardType(.numberPad)
                    TextField("İletişim e-postası (isteğe bağlı)", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                } footer: { Text("VKN belgeden okunup elle girilir ve denetim basamağı doğrulanır. Kart \"Aday\" durumunda açılır; Satınalma sonradan tamamlar.") }
                if let notice { NoticeView(notice: notice) }
            }
            .navigationTitle("Aday tedarikçi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Ekleniyor…" : "Ekle") { Task { await add() } }
                        .disabled(busy || legalName.trimmingCharacters(in: .whitespaces).isEmpty || vkn.count < 10)
                }
            }
        }
    }
    private func add() async {
        struct Body: Encodable, Sendable { let legalName: String; let vkn: String; let contactEmail: String? }
        busy = true; defer { busy = false }
        do {
            let r: CandidateSupplier = try await session.post("/api/v1/suppliers/candidates", body: Body(legalName: legalName.trimmingCharacters(in: .whitespaces), vkn: vkn.trimmingCharacters(in: .whitespaces), contactEmail: email.trimmingCharacters(in: .whitespaces).ifEmptyNil))
            done(r); dismiss()
        } catch { notice = Notice.from(error) }
    }
}

/// İsteğe bağlı tarih: boşken "Tarih seç", seçilince tarih seçici ve "Temizle".
struct OptionalDateRow: View {
    let title: String
    @Binding var date: Date?
    var body: some View {
        if let d = date {
            AdaptiveStack {
                DatePicker(title, selection: Binding(get: { d }, set: { date = $0 }), displayedComponents: .date)
                    .environment(\.locale, Locale(identifier: "tr_TR"))
                Button("Temizle") { date = nil }.buttonStyle(.borderless).accessibilityLabel("\(title) temizle")
            }
        } else {
            AdaptiveStack {
                Text(title)
                HSpacer()
                Button("Tarih seç") { date = Calendar.current.startOfDay(for: Date()) }.buttonStyle(.borderless).accessibilityLabel("\(title): tarih seç")
            }
        }
    }
}

/// JSON değeri (kısmi PUT gövdesi için: gönderilen anahtar değişir, null alanı boşaltır).
enum JSONValue: Encodable, Sendable, Equatable {
    case str(String), int(Int), bool(Bool), null
    static func opt(_ s: String?) -> JSONValue { s.map(JSONValue.str) ?? .null }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .str(let s): try c.encode(s); case .int(let i): try c.encode(i); case .bool(let b): try c.encode(b); case .null: try c.encodeNil() }
    }
}

enum ContractInput {
    /// "2.400.000,00" ya da "2400000.00" → "2400000.00"; okunamazsa nil. Hesap yapılmaz (Double yok).
    static func decimal(_ raw: String) -> String? {
        var s = raw.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "TL", with: "").replacingOccurrences(of: "₺", with: "")
        if s.contains(",") { s = s.replacingOccurrences(of: ".", with: "").replacingOccurrences(of: ",", with: ".") }
        else if s.filter({ $0 == "." }).count > 1 { s = s.replacingOccurrences(of: ".", with: "") }
        guard s.range(of: #"^\d{1,15}(\.\d{1,2})?$"#, options: .regularExpression) != nil else { return nil }
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        let intPart = String(parts[0].drop(while: { $0 == "0" })).ifEmpty("0")
        let frac = parts.count > 1 ? String(parts[1]).padding(toLength: 2, withPad: "0", startingAt: 0) : "00"
        return "\(intPart).\(frac)"
    }
    /// Sunucu decimal metni → düzenleme alanında Türkçe yazım ("2400000.00" → "2400000,00").
    static func display(_ s: String) -> String { s.replacingOccurrences(of: ".", with: ",") }
    private static func fmt() -> DateFormatter {
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = .current; f.dateFormat = "yyyy-MM-dd"; return f
    }
    static func iso(_ d: Date) -> String { fmt().string(from: d) }
    static func date(_ s: String?) -> Date? { s.flatMap { fmt().date(from: String($0.prefix(10))) } }
}

extension String {
    var ifEmptyNil: String? { isEmpty ? nil : self }
}

private extension View {
    /// Erişilebilirlik metin boyutlarında bölümlü seçici sığmaz; menüye döner (T41, AX5).
    @ViewBuilder func adaptivePicker(_ size: DynamicTypeSize) -> some View {
        if size.isAccessibilitySize { pickerStyle(.menu) } else { pickerStyle(.segmented) }
    }
}
