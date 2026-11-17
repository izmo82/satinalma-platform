import SwiftUI

/// "Alanları doğrula" (Figma iOS 3, v2 Faz 3 R2/R9/R10, Faz 4 R4–R6/R11): taranan sözleşme belgesinden taslak açılır ve zorunlu alanlar
/// insan tarafından girilir. v2 Faz 4: taslak açılınca (yeni taramada proje seçilince) sunucu yapay zekâ okumasını (AI06) ister; ekran okuma
/// durumunu ve alan önerilerini (değer, kaynak sayfa, güven) gösterir. Tutar, para birimi, tarihler ve VKN forma önceden yazılmaz ("Öneriyi kullan"
/// açık insan eylemidir); kararlar alan kaydıyla (`aiDecisions`) yazılır. Okuma yoksa ya da çalışmadıysa sebebi yazılır ve elle form aynen çalışır.
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
    /// Aday tedarikçi sayfası: elle (boş) ya da VKN önerisiyle (unvan + VKN dolu, öneri kimliğiyle) açılır.
    @State private var candidateSheet: CandidateSeed?

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
    /// Para birimi: kayıtlı koşulun para birimi (ör. webde USD girilmiş sözleşme); koşul yoksa TRY. Yalnız kullanıcı değiştirirse
    /// ya da henüz koşul yoksa gönderilir (final inceleme I2: TRY varsayılanı başka para birimini ezmez).
    @State private var currency = "TRY"
    @State private var limitBasis = "NET"
    @State private var autoRenewal = false
    @State private var renewalMonths = 12
    @State private var noticeAmount: Int?
    @State private var noticeUnit = "MONTH"
    @State private var compared = false
    @State private var supplierHint: String?
    @State private var memberHint: String?
    @Environment(\.dynamicTypeSize) private var typeSize
    // v2 Faz 4: okuma önerileri.
    @State private var extractions: ContractExtractions?
    @State private var extractionError: Notice?
    @State private var readTimedOut = false
    @State private var readBusy = false
    @State private var pollToken = UUID()
    @State private var draftBusy = false
    /// "Öneriyi kullan" denen ve "Yoksay" denen öneriler (kayıtla karar olur); önceden doldurulan (kritik olmayan) öneri: alan → öneri kimliği.
    @State private var used: Set<String> = []
    @State private var rejected: Set<String> = []
    @State private var prefilled: [String: String] = [:]
    @State private var appliedRun: String?
    /// Bilinen kart VKN'leri (tedarikçi kimliği → VKN): kayıtlı kart ve bu ekranda açılan aday kart. VKN önerisinin onayı her zaman
    /// o anda seçili kartın VKN'sinden hesaplanır (kart değişirse "kullanıldı" düşer).
    @State private var knownVkn: [String: String] = [:]
    /// "Öneriyi kullan" öncesi form değerleri (öneri kimliği → anlık görüntü): "Geri al" alanı eski değerine döndürür.
    @State private var undo: [String: FormSnap] = [:]
    @State private var previewPage: Int?
    /// Devam düğmesinin yanında gösterilen sonuç (ör. karar bekleyen kritik öneri); üstteki bildirim kaydırılınca görünmez.
    @State private var continueNotice: Notice?

    init(documentVersionId: String, draftId: UUID?, familyId: String?) {
        self.documentVersionId = documentVersionId; self.draftId = draftId; _familyId = State(initialValue: familyId)
    }
    init(familyId: String) { _familyId = State(initialValue: familyId) }

    private var amount: String? { ContractInput.decimal(amountText) }
    /// Seçenekler: TRY, USD, EUR ve (başka ise) kayıtlı para birimi.
    private var currencyOptions: [String] {
        let base = ["TRY", "USD", "EUR"]
        return base.contains(currency) ? base : [currency] + base
    }
    private var needsNotice: Bool { indefinite || autoRenewal }
    private var canContinue: Bool {
        !projectId.isEmpty && compared && !busy && !draftBusy && session.isOnline && (amountText.isEmpty || amount != nil)
    }
    /// Önerinin ait olduğu belge sürümü taslağın güncel belge sürümüyse ve okuma tamamlandıysa öneriler kullanılır.
    private var aiOk: Bool {
        guard let e = extractions, e.run?.status == "SUCCEEDED" else { return false }
        let current = loaded?.document?.documentVersionId ?? documentVersionId
        return current == nil || current == e.documentVersionId
    }
    private var aiFields: [ContractExtractions.Field] { aiOk ? extractions?.fields ?? [] : [] }
    private func ai(_ field: String) -> ContractExtractions.Field? { aiFields.first { $0.field == field } }
    private var canEditAi: Bool { loaded?.can.edit ?? true }
    private var previewDocument: String? { loaded?.document?.documentVersionId ?? documentVersionId }

    var body: some View {
        Form {
            OfflineBanner().listRowInsets(EdgeInsets())
            readStatusSection
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
                aiRow("supplierVkn")
                Button { candidateSheet = CandidateSeed() } label: { Label("Kayıtlı değil: aday tedarikçi ekle", systemImage: "plus.circle") }
                Picker("Sözleşme türü", selection: $contractType) {
                    Text("Seçilmedi").tag("")
                    ForEach(ContractLabels.types, id: \.0) { Text($0.1).tag($0.0) }
                }
                aiRow("contractType")
                Picker("Sözleşme sorumlusu", selection: $ownerUserId) {
                    Text("Seçilmedi").tag("")
                    ForEach(members) { Text($0.displayName).tag($0.id) }
                }
                .pickerStyle(.navigationLink)
                if let memberHint { Text(memberHint).font(.footnote).foregroundStyle(.orange) }
            }
            Section("Tarihler") {
                OptionalDateRow(title: "İmza tarihi", date: $signedOn)
                aiRow("signedOn")
                OptionalDateRow(title: "Başlangıç", date: $startDate)
                aiRow("startDate")
                Toggle("Süresiz sözleşme", isOn: $indefinite)
                aiRow("indefinite")
                if !indefinite { OptionalDateRow(title: "Bitiş", date: $endDate); aiRow("endDate") }
                Toggle("Otomatik yenileme", isOn: $autoRenewal)
                aiRow("autoRenewal")
                if autoRenewal { Stepper("Yenileme süresi: \(renewalMonths) ay", value: $renewalMonths, in: 1...120) }
                if needsNotice {
                    AdaptiveStack {
                        TextField("İhbar süresi", value: $noticeAmount, format: .number).keyboardType(.numberPad)
                        Picker("Birim", selection: $noticeUnit) { Text("gün").tag("DAY"); Text("ay").tag("MONTH") }.adaptivePicker(typeSize)
                    }
                    Text("Süresiz ya da otomatik yenilenen sözleşmede ihbar süresi zorunludur.").font(.footnote).foregroundStyle(.secondary)
                    aiRow("noticePeriodDays")
                }
            }
            Section {
                TextField("Tutar", text: $amountText, prompt: Text("ör. 2.400.000,00")).keyboardType(.decimalPad)
                if !amountText.isEmpty {
                    if let amount { Text(Fmt.money(amount, currency)).font(.footnote).foregroundStyle(.secondary) }
                    else { Text("Tutar okunamadı; en fazla iki ondalık hane girin.").font(.footnote).foregroundStyle(.red) }
                }
                aiRow("amount")
                Picker("Para birimi", selection: $currency) {
                    ForEach(currencyOptions, id: \.self) { Text($0).tag($0) }
                }.adaptivePicker(typeSize)
                aiRow("currency")
                Picker("KDV", selection: $limitBasis) { Text("KDV hariç").tag("NET"); Text("KDV dahil").tag("GROSS") }.adaptivePicker(typeSize)
                aiRow("limitBasis")
            } header: { Text("Tutar (\(currency))") }
            infoOnlySection
            Section {
                if let continueNotice { NoticeView(notice: continueNotice) }
                Toggle("Tutar, tarih ve VKN'yi belgeyle karşılaştırdım.", isOn: $compared)
                Button { Task { await saveAndContinue() } } label: {
                    Text(busy ? "Kaydediliyor…" : "Devam: İncele ve gönder").frame(maxWidth: .infinity).font(.body.weight(.semibold))
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(!canContinue)
                .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
            } footer: {
                Text(familyId == nil ? "Proje seçildiğinde (ya da Devam ettiğinizde) sözleşme taslağı açılır; gönderilmeden bırakırsanız webde Sözleşmeler'de tamamlanabilir." : "Taslak kayıtlı; değişiklikler ve yapay zekâ önerisi kararlarınız kaydedilir. Onaydaki bir sözleşmede değişiklik onayı baştan başlatır.")
            }
        }
        .navigationTitle("Alanları doğrula")
        .navigationDestination(isPresented: $showReview) { if let familyId { ContractSubmitView(familyId: familyId) } }
        .navigationDestination(item: $previewPage) { p in
            if let dv = previewDocument { DocumentPreview(documentVersionId: dv, expectedSha256: loaded?.document?.sha256, title: loaded?.family.title ?? "Sözleşme", page: p) }
        }
        .sheet(item: $candidateSheet) { seed in
            CandidateSupplierSheet(initialLegalName: seed.legalName, initialVkn: seed.vkn, existing: seed.existing) { s, vkn in
                let seedSnap = snap()
                knownVkn[s.id] = vkn.filter(\.isNumber)
                if !suppliers.contains(where: { $0.id == s.id }) { suppliers.insert(SupplierOption(id: s.id, legalName: s.legalName, status: s.status, label: nil), at: 0) }
                supplierId = s.id
                // VKN önerisiyle açıldıysa: kart eşleşmesi VKN'yle kesin kayıt aramasıdır (yapay zekâ eşleştirmez); öneri "kullanıldı" sayılır.
                if let eid = seed.extractionId {
                    used.insert(eid); rejected.remove(eid)
                    undo[eid] = undo[eid] ?? seedSnap
                }
                notice = Notice(tone: .info, text: s.existing ? "Bu VKN ile kayıtlı firma seçildi: \(s.legalName)." : "Aday tedarikçi kartı açıldı: \(s.legalName). Satınalma kartı sonradan tamamlar.")
            }
        }
        .task { if projects == nil { await loadOptions() } }
        .onChange(of: supplierId) { _, _ in
            if let x = ai("supplierVkn"), used.contains(x.id), !vknMatches(x) { used.remove(x.id); undo[x.id] = nil }
        }
        // Okuma durumu: iş kuyruktayken 3 sn aralıkla sorulur, en çok 2 dk (R11). Taslak yoksa okuma da yoktur.
        .task(id: "\(familyId ?? "")|\(pollToken)") { await pollExtractions() }
    }

    /// Kullanıcı projeyi seçti: departman projenin departmanına geçer (kullanıcı yine değiştirebilir).
    private func userSelectedProject(_ id: String) {
        guard id != projectId else { return }
        projectId = id
        if let p = projects?.first(where: { $0.id == id }), let d = p.departmentId, departments.contains(where: { $0.id == d }) { departmentId = d }
        // v2 Faz 4 (R11): yeni taramada taslak proje seçilince açılır; sunucu okumayı ister ve öneriler bu ekranda görünür.
        // Açılamazsa (ör. çevrimdışı) eski yol sürer: taslak "Devam"da açılır.
        if familyId == nil, !id.isEmpty, session.isOnline { Task { await openDraft() } }
    }

    /// Yeni taramadan taslak açar (Devam'da da aynısı çağrılır; iki kez açılmaz).
    @discardableResult
    private func openDraft() async -> Bool {
        if familyId != nil { return true }
        guard let documentVersionId, !projectId.isEmpty, !draftBusy else { return false }
        draftBusy = true; defer { draftBusy = false }
        do {
            struct Draft: Encodable, Sendable { let documentVersionId: String; let projectId: String; let departmentId: String? }
            let r: ContractDraftCreated = try await session.post("/api/v1/contract-drafts", body: Draft(documentVersionId: documentVersionId, projectId: projectId, departmentId: departmentId.ifEmptyNil))
            if let draftId { drafts.setContractFamily(draftId, familyId: r.familyId) }
            if let d = r.duplicateOf { notice = Notice(tone: .warn, text: "Aynı belge daha önce \(d.code) (\(d.title)) olarak eklenmiş; yine de yeni taslak açıldı. Gereksizse webden kaldırın.") }
            let (c, _): (ContractV2, String?) = try await session.get("/api/v1/contracts/\(r.familyId)/v2")
            loaded = c
            if let sp = c.supplier, let v = sp.vkn { knownVkn[sp.id] = v }
            familyId = r.familyId
            return true
        } catch {
            notice = Notice.from(error)
            return false
        }
    }

    private func loadOptions() async {
        do {
            // Seçenekler paralel yüklenir; tedarikçi/kişi listesi alınamazsa alan boş kalır ve ipucu gösterilir.
            async let projectsReq: (ProjectOptions, String?) = session.get("/api/v1/projects")
            async let suppliersReq: (SupplierOptions, String?) = session.get("/api/v1/supplier-options")
            async let membersReq: ([MemberOption], String?) = session.get("/api/v1/members?active=true")
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
        if let s = c.supplier, let v = s.vkn { knownVkn[s.id] = v }
        let f = c.fields
        projectId = f.projectId ?? ""
        departmentId = c.family.departmentId ?? ""
        supplierId = f.supplierId ?? ""
        if !supplierId.isEmpty, !suppliers.contains(where: { $0.id == supplierId }), let s = c.supplier {
            suppliers.insert(SupplierOption(id: s.id, legalName: s.legalName, status: s.status, label: nil), at: 0)
        }
        contractType = f.contractType ?? ""
        ownerUserId = f.ownerUserId ?? ""
        // Yeni taramada taslak proje seçilince açıldığından sorumlu henüz kaydedilmemiş olabilir: kendi taslağınızda yeni taramadaki
        // varsayılan (siz) korunur; kayıt yine "Devam" ile olur.
        if ownerUserId.isEmpty, let me = session.me?.user.id, c.family.createdBy?.id == me, members.contains(where: { $0.id == me }) { ownerUserId = me }
        if let o = c.owner, !members.contains(where: { $0.id == o.id }) { members.insert(MemberOption(id: o.id, displayName: o.displayName), at: 0) }
        signedOn = ContractInput.date(f.signedOn); startDate = ContractInput.date(f.startDate); endDate = ContractInput.date(f.endDate)
        indefinite = f.indefinite
        amountText = f.amount.map(ContractInput.display) ?? ""
        currency = f.currency ?? "TRY"
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
            // Yalnız koşul yoksa ya da kullanıcı para birimini değiştirdiyse gönderilir; kayıtlı para birimi asla TRY ile ezilmez.
            if f?.currency == nil || currency != f?.currency { b["currency"] = .str(currency) }
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
            // Persona K1: ihbar boşsa birim de null gider (ikisi birlikte boş = ihbar şartı yok); 0 ya da eski birim kalmaz.
            put("noticeUnit", noticeAmount != nil ? .str(noticeUnit) : .null, .opt(f?.noticeUnit))
        }
        return b
    }

    private func saveAndContinue() async {
        busy = true; defer { busy = false }
        notice = nil; continueNotice = nil
        do {
            if familyId == nil {
                busy = false
                guard await openDraft() else { continueNotice = notice; return }
                busy = true
            }
            guard let familyId else { return }
            let b = body(for: loaded)
            let dec = aiDecisions()
            let pending = pendingCritical(excluding: dec)
            if !b.isEmpty || !dec.isEmpty {
                var full = b
                if !dec.isEmpty { full["aiDecisions"] = .array(dec.map { .object(["extractionId": .str($0.0), "decision": .str($0.1)]) }) }
                let c: ContractV2 = try await session.post("/api/v1/contracts/\(familyId)/fields", body: full, method: "PUT")
                loaded = c
                if let sp = c.supplier, let v = sp.vkn { knownVkn[sp.id] = v }
                if !dec.isEmpty { used = []; rejected = []; prefilled = [:]; undo = [:]; await loadExtractions(familyId) }
            }
            // R6: güncel okumada karar bekleyen kritik öneri varsa sunucu gönderimi reddeder; aynı kural burada önceden söylenir.
            if !pending.isEmpty {
                continueNotice = Notice(tone: .warn, text: "Kaydedildi. Göndermeden önce kritik önerilere karar verin (\"Öneriyi kullan\" ya da \"Yoksay\"): \(pending.map(\.label).joined(separator: ", ")).")
                return
            }
            showReview = true
        } catch {
            continueNotice = Notice.from(error)
            // M1: karar/değer uyuşmazlığında kayıt bütünüyle geri alınır; hiçbir alanın kaydedilmediği açıkça söylenir.
            if let e = error as? APIError, e.code == "decision_mismatch" { continueNotice = Notice(tone: .warn, text: "Kaydedilmedi: \(e.message)") }
            // Öneri artık güncel okumaya ait değilse (yeni sürüm/yeniden okuma) ya da değer öneriyle uyuşmuyorsa öneriler yenilenir.
            if let e = error as? APIError, ["extraction_unknown", "decision_mismatch", "extraction_duplicate", "extraction_not_saved"].contains(e.code), let familyId {
                // Kararlar yeniden hesaplanır: eski "kullanıldı" işaretleri düşer (değerler formda kalır, kullanıcı yeniden karar verir).
                used = []; undo = [:]
                await loadExtractions(familyId)
            }
        }
    }

    // MARK: Yapay zekâ okuması (v2 Faz 4)

    private func loadExtractions(_ fid: String) async {
        do {
            let (e, _): (ContractExtractions, String?) = try await session.get("/api/v1/contracts/\(fid)/extractions")
            extractions = e; extractionError = nil
            applyPrefill()
        } catch {
            // Görev iptali (ekrandan çıkış/yenileme) hata değildir.
            if Task.isCancelled || error is CancellationError { return }
            extractionError = Notice.from(error)
        }
    }

    private func pollExtractions() async {
        guard let fid = familyId else { return }
        readTimedOut = false
        let start = Date()
        while !Task.isCancelled {
            await loadExtractions(fid)
            guard extractions?.run?.active == true, extractionError == nil else { return }
            if Date().timeIntervalSince(start) > 120 { readTimedOut = true; return }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    private func reRead() async {
        guard let fid = familyId else { return }
        readBusy = true; defer { readBusy = false }
        do {
            let r: AiRequestResult = try await session.post("/api/v1/contracts/\(fid)/extractions")
            if r.status != "QUEUED" && r.status != "RUNNING" && r.status != "SUCCEEDED", let reason = r.reason { notice = Notice(tone: .warn, text: reason) }
            pollToken = UUID()
        } catch { notice = Notice.from(error) }
    }

    /// R5: yalnız kritik olmayan ve sunucunun `prefill` dediği (HIGH/MEDIUM, metin/sayı) öneri, alan boşsa "Yapay zekâ" etiketiyle yazılır;
    /// kayıt yine kullanıcının "Devam"ıyla olur. Bu ekranda bu yalnız ihbar süresidir (görünürken). Kritik alan asla önceden yazılmaz.
    private func applyPrefill() {
        guard aiOk, let run = extractions?.run, appliedRun != run.id else { return }
        appliedRun = run.id
        used = []; rejected = []; prefilled = [:]; undo = [:]
        for x in aiFields where x.prefill && !x.critical && x.decision == "PENDING" {
            guard let v = x.value, x.field == "noticePeriodDays", needsNotice, noticeAmount == nil, loaded?.fields.noticeAmount == nil, let n = Int(v) else { continue }
            // Persona K1: ihbar bitişe göre işler; bitiş (kritik, önceden yazılmaz) boşken ve süresiz değilken yalnız öneri olarak kalır.
            if noticeNeedsEnd { continue }
            noticeAmount = n; noticeUnit = "DAY"
            prefilled[x.field] = x.id
        }
    }

    /// Persona K1: süresiz değil ve bitiş boş → ihbar süresi kaydedilemez (sunucu 422 invalid_terms); önce bitiş ya da "Süresiz".
    private var noticeNeedsEnd: Bool { !indefinite && endDate == nil }

    /// Formdaki değer öneri biçiminde (normalize). Eşleşme alanı yoksa nil.
    private func formValue(_ field: String) -> String? {
        switch field {
        case "contractType": contractType.ifEmptyNil
        case "signedOn": signedOn.map(ContractInput.iso)
        case "startDate": startDate.map(ContractInput.iso)
        case "endDate": indefinite ? nil : endDate.map(ContractInput.iso)
        case "indefinite": String(indefinite)
        case "autoRenewal": String(autoRenewal)
        case "limitBasis": limitBasis
        case "noticePeriodDays": noticeUnit == "DAY" ? noticeAmount.map(String.init) : nil
        case "amount": amount
        case "currency": currency
        default: nil
        }
    }
    /// Kayıtlı (ekran açılırken yüklenen) değer, formun varsayılanlarıyla aynı biçimde.
    private func baseValue(_ field: String) -> String? {
        let f = loaded?.fields
        switch field {
        case "contractType": return f?.contractType
        case "signedOn": return f?.signedOn.map { String($0.prefix(10)) }
        case "startDate": return f?.startDate.map { String($0.prefix(10)) }
        case "endDate": return (f?.indefinite ?? false) ? nil : f?.endDate.map { String($0.prefix(10)) }
        case "indefinite": return String(f?.indefinite ?? false)
        case "autoRenewal": return String(f?.autoRenewal ?? false)
        case "limitBasis": return f?.limitBasis ?? "NET"
        case "noticePeriodDays": return (f?.noticeUnit ?? "MONTH") == "DAY" ? f?.noticeAmount.map(String.init) : nil
        case "amount": return f?.amount
        case "currency": return f?.currency ?? "TRY"
        default: return nil
        }
    }
    private static let mapped: Set<String> = ["contractType", "signedOn", "startDate", "endDate", "indefinite", "autoRenewal", "limitBasis", "noticePeriodDays", "amount", "currency"]
    /// Formdaki değer öneriyle aynı mı (sunucu kayıttan sonra yeniden karşılaştırır).
    private func same(_ field: String, _ value: String) -> Bool {
        switch field {
        case "amount": guard let a = amount, let x = Decimal(string: a), let y = Decimal(string: value) else { return false }; return x == y
        case "currency": return currency.uppercased() == value
        default: return formValue(field) == value
        }
    }
    /// Alan bu kayıtta gerçekten kaydedilir mi (koşul alanları tutar girilmeden kaydedilmez; bkz. `body(for:)`).
    private func willSave(_ field: String) -> Bool {
        switch field {
        case "amount", "currency", "limitBasis", "startDate", "autoRenewal": amount != nil
        case "endDate": amount != nil && !indefinite
        case "noticePeriodDays": needsNotice && (indefinite || amount != nil)
        default: true
        }
    }
    /// M1: `willSave` yanlışken kullanıcıya gösterilen neden (alan bu kayıtta yazılmaz).
    private func notSavedReason(_ field: String) -> String {
        if field == "endDate" && indefinite { return "süresiz sözleşmede bitiş tarihi kaydedilmez" }
        if field == "noticePeriodDays" && !needsNotice { return "ihbar süresi yalnız süresiz ya da otomatik yenilenen sözleşmede kaydedilir" }
        return "tutar girilmeden bu alan kaydedilmez"
    }
    private func apply(_ x: ContractExtractions.Field) {
        guard let v = x.value else { return }
        rejected.remove(x.id)
        let before = snap()
        if x.field == "supplierVkn" {
            // Kayıtlı ve seçili kartın VKN'si aynıysa onaylanır; değilse aday kart formu VKN ile açılır (aynı VKN'li kart varsa sunucu onu seçer).
            if knownVkn[supplierId] == v { undo[x.id] = snap(); used.insert(x.id); return }
            candidateSheet = CandidateSeed(legalName: x.existingSupplier?.legalName ?? ai("supplierName")?.value ?? "", vkn: v, extractionId: x.id, existing: x.existingSupplier)
            return
        }
        switch x.field {
        case "contractType": if ContractLabels.types.contains(where: { $0.0 == v }) { contractType = v } else { return }
        case "signedOn": signedOn = ContractInput.date(v)
        case "startDate": startDate = ContractInput.date(v)
        case "endDate": endDate = ContractInput.date(v)
        case "indefinite": indefinite = v == "true"
        case "autoRenewal": autoRenewal = v == "true"
        case "limitBasis": if ContractLabels.limitBasis[v] != nil { limitBasis = v } else { return }
        case "noticePeriodDays": if let n = Int(v) { noticeAmount = n; noticeUnit = "DAY" } else { return }
        case "amount": amountText = ContractInput.display(v)
        case "currency": currency = v
        default: return
        }
        undo[x.id] = before
        used.insert(x.id)
    }
    /// VKN önerisi şu an seçili kartın VKN'sine eşit mi (kesin eşitlik; yapay zekâ eşleştirmez).
    private func vknMatches(_ x: ContractExtractions.Field) -> Bool { x.value != nil && knownVkn[supplierId] == x.value }
    private func snap() -> FormSnap {
        FormSnap(supplierId: supplierId, contractType: contractType, signedOn: signedOn, startDate: startDate, endDate: endDate, indefinite: indefinite,
                 autoRenewal: autoRenewal, limitBasis: limitBasis, noticeAmount: noticeAmount, noticeUnit: noticeUnit, amountText: amountText, currency: currency)
    }
    /// "Geri al": yalnız o önerinin alanı "Öneriyi kullan" öncesi değere döner.
    private func revert(_ x: ContractExtractions.Field) {
        used.remove(x.id)
        guard let b = undo.removeValue(forKey: x.id) else { return }
        switch x.field {
        case "supplierVkn": supplierId = b.supplierId
        case "contractType": contractType = b.contractType
        case "signedOn": signedOn = b.signedOn
        case "startDate": startDate = b.startDate
        case "endDate": endDate = b.endDate
        case "indefinite": indefinite = b.indefinite
        case "autoRenewal": autoRenewal = b.autoRenewal
        case "limitBasis": limitBasis = b.limitBasis
        case "noticePeriodDays": noticeAmount = b.noticeAmount; noticeUnit = b.noticeUnit
        case "amount": amountText = b.amountText
        case "currency": currency = b.currency
        default: break
        }
    }
    private func prefillUnchanged(_ x: ContractExtractions.Field) -> Bool {
        prefilled[x.field] == x.id && x.value.map { same(x.field, $0) } == true
    }
    /// Bu kayıtla yazılacak kararlar: "Öneriyi kullan" → Onaylandı (değer aynı kaldıysa, değilse Düzeltildi); elle değiştirilen ya da önceden
    /// doldurulmuş alan → Düzeltildi (sunucu değer öneriye eşitse Onaylandı saklar); "Yoksay" → Yoksayıldı. Dokunulmayan öneri beklemede kalır.
    private func aiDecisions() -> [(String, String)] {
        guard canEditAi else { return [] }
        var out: [(String, String)] = []
        for x in aiFields where x.decision == "PENDING" {
            guard let v = x.value else { continue }
            if rejected.contains(x.id) { out.append((x.id, "REJECTED")); continue }
            if x.field == "supplierVkn" {
                if used.contains(x.id) { out.append((x.id, vknMatches(x) ? "CONFIRMED" : "CORRECTED")) }
                else if !supplierId.isEmpty, supplierId != (loaded?.fields.supplierId ?? "") { out.append((x.id, "CORRECTED")) }
                continue
            }
            guard Self.mapped.contains(x.field) else { continue }
            // Final inceleme M1: kullanılan öneri bu kayıtta yazılmayacaksa (ör. tutarsız koşul alanı, süresizde bitiş) "Onaylandı" değil
            // "Düzeltildi" gider; öneri sessizce beklemede kalmaz (sunucu kayıtlı değer öneriye eşitse "Onaylandı" saklar).
            if used.contains(x.id) { out.append((x.id, willSave(x.field) && same(x.field, v) ? "CONFIRMED" : "CORRECTED")); continue }
            guard willSave(x.field) else { continue }
            if prefillUnchanged(x) || formValue(x.field) != baseValue(x.field) { out.append((x.id, "CORRECTED")) }
        }
        return out
    }
    private func pendingCritical(excluding dec: [(String, String)]) -> [ContractExtractions.Field] {
        aiFields.filter { x in x.critical && x.value != nil && x.decision == "PENDING" && !dec.contains { $0.0 == x.id } }
    }

    /// Okuma durumu (Oku adımının mobil karşılığı): dürüst tek satır, test sağlayıcısı etiketi, "Yeniden oku".
    @ViewBuilder private var readStatusSection: some View {
        Section {
            if familyId == nil {
                Label(draftBusy ? "Taslak açılıyor…" : "Proje seçilince taslak açılır; yapay zekâ okuması etkinse öneriler burada görünür. Alanları belgeden siz de girebilirsiniz.",
                      systemImage: "sparkles").font(.footnote).foregroundStyle(.secondary)
            } else if let e = extractions {
                if let run = e.run, run.isTestProvider { TestProviderTag(label: run.providerLabel) }
                Label { Text(readLine(e)).font(.footnote) } icon: { Image(systemName: "sparkles").foregroundStyle(.secondary) }
                if e.run?.active == true && !readTimedOut { ProgressView().accessibilityLabel("Okunuyor") }
                if readTimedOut { Text("Okuma sürüyor, alanları elle girebilirsiniz.").font(.footnote).foregroundStyle(.secondary) }
                if aiOk {
                    let n = aiFields.filter { $0.critical && $0.value != nil && $0.decision == "PENDING" }.count
                    if n > 0 { Text("\(n) kritik öneri kararınızı bekliyor.").font(.footnote.weight(.semibold)) }
                }
                if e.can.request, e.run?.active != true, e.run == nil || e.run?.status == "FAILED" || e.run?.waiting == true {
                    Button { Task { await reRead() } } label: { Label("Yeniden oku", systemImage: "arrow.clockwise") }
                        .disabled(readBusy || !session.isOnline)
                }
            } else if let extractionError {
                Label("Yapay zekâ okumasının durumu alınamadı (\(extractionError.text)); alanları belgeden siz girin.", systemImage: "sparkles").font(.footnote).foregroundStyle(.secondary)
            } else {
                ProgressView("Okuma durumu alınıyor").font(.footnote)
            }
        } header: { Text("Yapay zekâ okuması") }
    }

    private func readLine(_ e: ContractExtractions) -> String {
        guard let run = e.run else { return "Yapay zekâ okuması yapılmadı; alanları belgeden siz girin." }
        switch run.status {
        case "SUCCEEDED":
            if !aiOk { return "Okuma önceki belge sürümüne ait; alanları belgeden siz girin." }
            return "Belgeden okunan öneriler. Tutar, para birimi, tarihler ve VKN forma yazılmaz; \"Öneriyi kullan\" ile siz alırsınız. Hiçbir değer siz kaydetmeden sözleşmeye yazılmaz."
        case "QUEUED", "RUNNING": return "Yapay zekâ okuması sürüyor; alanları beklemeden belgeden girebilirsiniz."
        case "FAILED": return "Yapay zekâ okuması tamamlanamadı: \(AiText.reason(run)) Alanları belgeden siz girin."
        default: return "Yapay zekâ okuması çalışmadı: \(AiText.reason(run)) Alanları belgeden siz girin."
        }
    }

    /// Okunamayan alan "Sorulan alan" olarak gösterilir: boşsa; bool/enum alanlarda (varsayılan değeri hep dolu) kullanıcı dokunmadıysa.
    private func isEmptyInForm(_ field: String) -> Bool {
        switch field {
        case "supplierVkn": return supplierId.isEmpty
        case "indefinite", "autoRenewal", "limitBasis": return formValue(field) == baseValue(field)
        default: return formValue(field) == nil || (field == "amount" && amountText.isEmpty)
        }
    }

    /// Alanın altındaki öneri satırı: öneri + kaynak sayfa + güven, "Öneriyi kullan" / "Yoksay", ya da karar / "Sorulan alan".
    @ViewBuilder private func aiRow(_ field: String) -> some View {
        if let x = ai(field) {
            let src = x.page
            if x.value == nil || x.confidence == "MISSING" {
                if isEmptyInForm(field) {
                    AdaptiveStack {
                        AskedTag()
                        Text("\(x.label): belgede okunamadı; belgeden siz girin.").font(.footnote).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } else if x.decision != "PENDING" {
                Text("\(decidedText(x.decision))\(x.decidedBy.map { " · \($0.displayName)" } ?? "")\(src.map { " · s. \($0)" } ?? "")").font(.footnote).foregroundStyle(.secondary)
            } else if rejected.contains(x.id) {
                AdaptiveStack {
                    Text("Öneri (\(shown(x))) kaydedince yoksayılır.").font(.footnote).foregroundStyle(.secondary)
                    Button("Geri al") { rejected.remove(x.id) }.buttonStyle(.borderless).font(.footnote).tapTarget()
                        .accessibilityLabel("\(x.label): yoksaymayı geri al")
                }
            } else if prefillUnchanged(x) {
                AdaptiveStack {
                    AiTag()
                    Text("\(src.map { "s. \($0) · " } ?? "")güven \(AiText.confidence[x.confidence] ?? "") · belgeyle karşılaştırın").font(.footnote).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            } else if used.contains(x.id) && (x.field == "supplierVkn" ? vknMatches(x) : same(x.field, x.value!)) {
                AdaptiveStack {
                    Text("\(willSave(x.field) ? "Öneri kullanıldı; kaydedince onaylanır" : "Öneri kullanıldı ama \(notSavedReason(x.field)); kaydedince karar \"Öneriden farklı\" olur").\(src.map { " · \($0). sayfa" } ?? "")")
                        .font(.footnote).foregroundStyle(.secondary)
                    if canEditAi {
                        Button("Geri al") { revert(x) }.buttonStyle(.borderless).font(.footnote).tapTarget()
                            .accessibilityLabel("\(x.label): öneriyi kullanmayı geri al")
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    if x.confidence == "LOW" { AskedTag() }
                    Text("Öneri: \(shown(x))\(src.map { " (s. \($0))" } ?? "") · güven \(AiText.confidence[x.confidence] ?? "")")
                        .font(.footnote.weight(.semibold))
                    if let ev = x.evidence, !ev.isEmpty { Text("“\(ev)”").font(.footnote).foregroundStyle(.secondary).lineLimit(3) }
                    ForEach(AiText.flags(x.flags), id: \.self) { Text($0).font(.footnote).foregroundStyle(.orange) }
                    if x.field == "supplierVkn" {
                        // Persona K6: aynı VKN ile kayıtlı kart varsa açıkça söylenir; düğme o kartı seçer.
                        if let e = x.existingSupplier { Text("Bu VKN ile kayıtlı kart var: \(e.legalName). Yeni kart açılmaz; bu kart seçilir.").font(.footnote).foregroundStyle(.secondary) }
                        else { Text("Kayıtlı kart VKN ile kesin aranır; yoksa aday kart açılır.").font(.footnote).foregroundStyle(.secondary) }
                    }
                    if x.field == "noticePeriodDays" && noticeNeedsEnd {
                        Text("İhbar süresi için önce bitiş tarihini girin ya da sözleşmeyi süresiz işaretleyin.").font(.footnote).foregroundStyle(.secondary)
                    }
                    if canEditAi {
                        AdaptiveStack(spacing: 12) {
                            Button("Öneriyi kullan") { apply(x) }.buttonStyle(.bordered).tapTarget()
                                .accessibilityLabel("Öneriyi kullan: \(x.label)")
                            Button("Yoksay") { rejected.insert(x.id); used.remove(x.id) }.buttonStyle(.borderless).font(.footnote).tapTarget()
                                .accessibilityLabel("Öneriyi yoksay: \(x.label)")
                            if let p = src, previewDocument != nil {
                                // Ek almayan biçim (web ile aynı): görünen "N. sayfa", etiket görünen metni içerir.
                                Button("\(p). sayfa") { previewPage = p }.buttonStyle(.borderless).font(.footnote).tapTarget()
                                    .accessibilityLabel("\(x.label): Belgeyi \(p). sayfada aç, \(p). sayfa")
                            }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func shown(_ x: ContractExtractions.Field) -> String { AiText.value(x.field, x.value, currency: ai("currency")?.value ?? currency) }
    private func decidedText(_ d: String) -> String {
        switch d { case "CONFIRMED": "Öneri onaylandı"; case "CORRECTED": "Öneriden farklı değer kaydedildi"; case "REJECTED": "Öneri yoksayıldı"; default: "Karar bekleniyor" }
    }

    /// Bu ekranda karşılığı olmayan okunan bilgiler: yalnız bilgi, kaydedilmez (web formunda girilir).
    @ViewBuilder private var infoOnlySection: some View {
        let info = aiFields.filter { !Self.mapped.contains($0.field) && $0.field != "supplierVkn" && $0.value != nil }
        if !info.isEmpty {
            Section {
                ForEach(info) { x in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(x.label).font(.footnote).foregroundStyle(.secondary)
                        Text("\(shown(x))\(x.page.map { " (s. \($0))" } ?? "")").font(.subheadline)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: { Text("Belgeden okunan diğer bilgiler") } footer: {
                Text("Yalnız bilgi; bu ekranda kaydedilmez. Sözleşme no, ödeme vadesi, KVKK maddesi, yetkili mahkeme ve fiyat farkı web uygulamasındaki sihirbazda girilir.")
            }
        }
    }
}

/// "Öneriyi kullan" öncesi form değerleri ("Geri al" için).
struct FormSnap {
    var supplierId: String; var contractType: String; var signedOn: Date?; var startDate: Date?; var endDate: Date?; var indefinite: Bool
    var autoRenewal: Bool; var limitBasis: String; var noticeAmount: Int?; var noticeUnit: String; var amountText: String; var currency: String
}

extension View {
    /// En az 44×44 pt dokunma hedefi (HIG); görünüm küçük kalsa da dokunma alanı büyür.
    func tapTarget() -> some View { frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }
}

struct CandidateSeed: Identifiable {
    let id = UUID()
    var legalName = ""
    var vkn = ""
    var extractionId: String?
    /// Persona K6: önerilen VKN ile kayıtlı kart (varsa); sayfa düğmesi "Mevcut kartı seç" olur.
    var existing: ContractExtractions.ExistingSupplier? = nil
}

/// "Sorulan alan": öneri düşük güvenli ya da okunamadı; değeri belgeden siz girersiniz.
struct AskedTag: View {
    var body: some View {
        Label("Sorulan alan", systemImage: "questionmark.circle").font(.caption.weight(.semibold))
            .foregroundStyle(StatusBadge.adaptive(light: (0.60, 0.29, 0.0), dark: (1.0, 0.72, 0.40)))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
    }
}

/// "Yapay zekâ": alan yapay zekâ önerisiyle dolduruldu (kritik olmayan alan); kayıt kullanıcının eylemiyle olur.
struct AiTag: View {
    var body: some View {
        Label("Yapay zekâ", systemImage: "sparkles").font(.caption.weight(.semibold)).foregroundStyle(.purple)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.purple.opacity(0.10), in: RoundedRectangle(cornerRadius: 5))
            .accessibilityLabel("Yapay zekâ önerisiyle dolduruldu")
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
    @State private var reviewRefresh = UUID()
    @State private var note = ""
    @State private var busy = false

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            if let notice { NoticeView(notice: notice) }
            Loadable(value: contract, error: error, retry: load) { c in
                ContractHeaderCard(c: c)
                if let s = c.supplier { Section("Tedarikçi") { LabeledContent(s.legalName, value: s.status == "CANDIDATE" ? "Aday — doğrulanmadı" : (Labels.supplierStatus[s.status] ?? "Durum bilinmiyor")) } }
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
                ReviewSubmitCard(familyId: familyId, refreshID: reviewRefresh)
            }
        }
        .navigationTitle("İncele ve gönder")
        // Önizleme vekil seçimine bağlı: seçim değişince eski önizleme silinir, yenisi yüklenir (yapısal görev, iptal edilebilir).
        .task(id: useDeputy) { if contract?.can.submit == true { await loadPreview() } }
        .refreshable { reviewRefresh = UUID(); await load() }
        .task { await load() }
        // v2 Faz 4 (R11): ön inceleme bu adıma girişte istenir (kart görünür olmasa da); kart sonucu kendisi sorar.
        .task { await ReviewSubmitCard.requestIfNeeded(session, familyId: familyId) }
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
    /// v2 Faz 4: VKN önerisiyle açılınca unvan ve VKN dolu gelir (kullanıcı görür, değiştirebilir, "Ekle" ile açar).
    init(initialLegalName: String = "", initialVkn: String = "", existing: ContractExtractions.ExistingSupplier? = nil, done: @escaping (CandidateSupplier, String) -> Void) {
        _legalName = State(initialValue: initialLegalName); _vkn = State(initialValue: initialVkn); self.done = done
        self.existing = existing; self.existingVkn = initialVkn
    }
    let done: (CandidateSupplier, String) -> Void
    /// Persona K6: önerilen VKN ile kayıtlı kart; VKN değiştirilmediyse düğme "Mevcut kartı seç" der (sunucu o kartı seçer).
    private let existing: ContractExtractions.ExistingSupplier?
    private let existingVkn: String
    private var selectsExisting: Bool { existing != nil && vkn.filter(\.isNumber) == existingVkn.filter(\.isNumber) }
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var legalName: String
    @State private var vkn: String
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
                } footer: {
                    if selectsExisting, let e = existing { Text("Bu VKN ile kayıtlı kart var: \(e.legalName). Yeni kart açılmaz; bu kart seçilir.") }
                    else { Text("VKN belgeden okunup elle girilir ve denetim basamağı doğrulanır. Kart \"Aday\" durumunda açılır; Satınalma sonradan tamamlar.") }
                }
                if let notice { NoticeView(notice: notice) }
            }
            .navigationTitle(selectsExisting ? "Kayıtlı tedarikçi" : "Aday tedarikçi")
            .navigationBarTitleDisplayMode(.inline)

            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? (selectsExisting ? "Seçiliyor…" : "Ekleniyor…") : (selectsExisting ? "Mevcut kartı seç" : "Ekle")) { Task { await add() } }
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
            done(r, vkn); dismiss()
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
    /// v2 Faz 4: `aiDecisions: [{ extractionId, decision }]`.
    case array([JSONValue]), object([String: JSONValue])
    static func opt(_ s: String?) -> JSONValue { s.map(JSONValue.str) ?? .null }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .str(let s): try c.encode(s); case .int(let i): try c.encode(i); case .bool(let b): try c.encode(b); case .null: try c.encodeNil()
        case .array(let a): try c.encode(a); case .object(let o): try c.encode(o)
        }
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
