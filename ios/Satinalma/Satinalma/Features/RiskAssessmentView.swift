import SwiftUI

/// Yıllık risk değerlendirmesi: salt okunur özet (v2 Faz 6, R15). Form web'de doldurulur; burada kritiklik, skor, seviye,
/// 5×5 matriste hücre, geçen yılla fark, aksiyonlar ve çeyreklik "Değişiklik yok" (tek dokunuş, onay iletişim kutusuyla).
struct RiskAssessmentView: View {
    let assessmentId: String
    let titleHint: String
    /// Görevden açıldıysa görev başlığındaki dönem ("Çeyreklik risk gözden geçirmesi 2026-2: …"); varsayılan seçimde öncelik alır.
    let preferredPeriod: String?
    @Environment(SessionStore.self) private var session
    @State private var chosenPeriod: String?
    @State private var detail: RiskDetail?
    @State private var error: Notice?
    @State private var confirming = false
    @State private var sending = false
    @State private var actionNotice: Notice?

    init(assessmentId: String, title: String = "Risk değerlendirmesi", taskKind: String? = nil) {
        self.assessmentId = assessmentId; titleHint = title
        preferredPeriod = taskKind == "risk_quarterly_review" ? RiskFmt.period(inTitle: title) : nil
    }

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            Loadable(value: detail, error: error, retry: load) { d in
                general(d)
                result(d)
                differences(d)
                actions(d)
                review(d)
                webSection(d)
            }
        }
        .navigationTitle(detail?.assessment.supplier?.name ?? titleHint)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    // MARK: Bölümler

    @ViewBuilder private func general(_ d: RiskDetail) -> some View {
        let a = d.assessment
        Section("Genel") {
            Text(a.supplier?.name ?? "Tedarikçi").font(.headline)
            row("Yıl", a.year.map(String.init) ?? "—")
            row("Departman", a.department?.name ?? "Atanmadı")
            row("Durum", RiskLabels.status[a.status ?? ""] ?? "Bilinmeyen durum")
            row("Son tarih", a.dueOn.map { Fmt.date($0) } ?? "—")
            if a.overdue == true { Label("Son tarih geçti.", systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(.orange) }
        }
    }

    @ViewBuilder private func result(_ d: RiskDetail) -> some View {
        let c = d.computed
        Section("Sonuç") {
            row("Kritiklik", RiskFmt.criticality(c?.criticality))
            row("Risk skoru", c?.score?.value.map { Fmt.amount($0) } ?? "Henüz yok")
            if let src = c?.score?.sourceLabel ?? c?.score?.source.flatMap({ RiskLabels.scoreSource[$0] }) { row("Skor kaynağı", src) }
            row("Seviye", c?.level?.label ?? (c?.level?.level).map { "Seviye \($0)" } ?? "Henüz yok")
            if let band = c?.level?.band, let col = c?.criticality?.column, (1...5).contains(band), (1...5).contains(col) {
                RiskMatrixView(band: band, column: col)
            }
            if let blockers = c?.blockers, !blockers.isEmpty, d.assessment.status == "OPEN" {
                ForEach(Array(blockers.enumerated()), id: \.offset) { _, b in
                    Label(b.message ?? "Eksik bilgi var.", systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.orange)
                }
            }
        }
    }

    @ViewBuilder private func differences(_ d: RiskDetail) -> some View {
        if let prior = d.prior {
            Section("Geçen yılla fark") {
                let list = d.changed ?? []
                if let pr = prior.revision {
                    Text("Geçen yıl (\(prior.year.map(String.init) ?? "—")): kritiklik \(pr.criticalityDisplay ?? "—"), skor \(pr.riskScore.map { Fmt.amount($0) } ?? "—"), \(pr.levelLabel ?? "seviye yok")")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if list.isEmpty { Text("Geçen yıla göre değişiklik yok.").foregroundStyle(.secondary) }
                ForEach(list, id: \.self) { f in Label("Değişti: \(RiskLabels.field(f))", systemImage: "arrow.triangle.2.circlepath").font(.subheadline) }
            }
        }
    }

    @ViewBuilder private func actions(_ d: RiskDetail) -> some View {
        let xs = d.actions ?? []
        Section("Aksiyonlar ve kontroller") {
            if xs.isEmpty { Text("Aksiyon yok.").foregroundStyle(.secondary) }
            ForEach(xs) { x in
                VStack(alignment: .leading, spacing: 2) {
                    Text(x.title ?? "Aksiyon").font(.body.weight(.semibold))
                    Text([RiskLabels.actionKind[x.kind ?? ""], x.controlMethodLabel].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                    Text("Sahip: \(x.owner?.displayName ?? x.ownerText ?? "Atanmadı")").font(.subheadline)
                    if Self.isOverdue(x) {
                        Label("Tarih: \(x.dueOn.map { Fmt.date($0) } ?? "—") · gecikti", systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(.red)
                    } else {
                        Text("Tarih: \(x.dueOn.map { Fmt.date($0) } ?? "—")").font(.subheadline)
                    }
                    Text("Durum: \(RiskLabels.actionStatus[x.status ?? ""] ?? "Bilinmeyen durum")").font(.subheadline).foregroundStyle(.secondary)
                }.accessibilityElement(children: .combine)
            }
        }
    }

    /// Açık ve son tarihi bugünden (İstanbul) önce olan aksiyon gecikmiş sayılır.
    private static func isOverdue(_ x: RiskDetail.Action) -> Bool {
        guard x.status == "OPEN", let due = x.dueOn?.prefix(10) else { return false }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Europe/Istanbul"); f.dateFormat = "yyyy-MM-dd"
        return String(due) < f.string(from: Date())
    }

    /// Çeyreklik gözden geçirme: yalnız tamamlanmış kayıtta; kaydı olmayan dönemler (yılın çeyrekleri, cari çeyreğe kadar) seçilebilir,
    /// varsayılan en eski eksik dönem (ya da görevin dönemi). Eksik dönem yoksa düğme görünmez. "Güncelle" web'de.
    @ViewBuilder private func review(_ d: RiskDetail) -> some View {
        if d.assessment.status == "COMPLETED", d.can?.review != false {
            let missing = RiskFmt.missingPeriods(year: d.assessment.year, reviews: d.reviews ?? [], floor: d.assessment.firstReviewablePeriod)
            let period = (chosenPeriod.flatMap { missing.contains($0) ? $0 : nil }) ?? preferredPeriod.flatMap { missing.contains($0) ? $0 : nil } ?? missing.first
            Section {
                if let period {
                    if missing.count > 1 {
                        Picker("Dönem", selection: Binding(get: { period }, set: { chosenPeriod = $0 })) { ForEach(missing, id: \.self) { Text($0).tag($0) } }
                    }
                    Button { confirming = true } label: { Label(sending ? "Gönderiliyor…" : "Değişiklik yok (\(period))", systemImage: "checkmark.circle") }
                        .disabled(sending || !session.isOnline)
                        .confirmationDialog("\(period) dönemi için \"Değişiklik yok\" onaylansın mı?", isPresented: $confirming, titleVisibility: .visible) {
                            Button("Değişiklik yok (\(period))") { Task { await submitNoChange(period: period) } }
                            Button("Vazgeç", role: .cancel) {}
                        } message: { Text("Değerlendirme aynen geçerli kalır; çeyreklik gözden geçirme görevi kapanır.") }
                } else if RiskFmt.missingPeriods(year: d.assessment.year, reviews: [], floor: d.assessment.firstReviewablePeriod).isEmpty {
                    // v2 son doğrulama (Ruling 19): ilk revizyondan önceki dönemler gözden geçirilmez; boş bölüm yerine açık metin (web ile aynı).
                    Label("Bu değerlendirme için gözden geçirilecek çeyrek yok (ilk revizyondan önceki dönemler gözden geçirilmez).", systemImage: "calendar.badge.clock").font(.subheadline)
                } else if let last = (d.reviews ?? []).compactMap(\.period).max() {
                    Label("Son gözden geçirme: \(last). Bekleyen dönem yok.", systemImage: "checkmark.seal").font(.subheadline)
                }
                if let actionNotice { NoticeView(notice: actionNotice) }
            } header: { Text("Çeyreklik gözden geçirme") } footer: {
                Text("Değerlendirmede değişiklik varsa güncelleme web'de başlatılır.")
            }
        }
    }

    @ViewBuilder private func webSection(_ d: RiskDetail) -> some View {
        Section {
            if let url = RiskFmt.webURL(session: session, assessmentId: d.assessment.id) {
                Link(destination: url) { Label("Web'de doldurun", systemImage: "safari") }
            }
            Label("Değerlendirme formu web'de doldurulur.", systemImage: "desktopcomputer").font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.caption).foregroundStyle(.secondary)
            Text(v).font(.body)
        }.accessibilityElement(children: .combine)
    }

    // MARK: Ağ

    private func load() async {
        do { let (d, _): (RiskDetail, String?) = try await session.get("/api/v1/risk/assessments/\(assessmentId)"); detail = d; error = nil }
        catch { self.error = Notice.from(error) }
    }

    private struct ReviewBody: Encodable, Sendable { let period: String; let outcome: String }

    /// Sunucu iletisi olduğu gibi gösterilir (ör. geçmiş tarihli aksiyon NO_CHANGE'i engelleyebilir); 409'da kayıt yenilenir.
    private func submitNoChange(period: String) async {
        sending = true; actionNotice = nil; defer { sending = false }
        do {
            let d: RiskDetail = try await session.post("/api/v1/risk/assessments/\(assessmentId)/reviews", body: ReviewBody(period: period, outcome: "NO_CHANGE"))
            detail = d; actionNotice = Notice(tone: .info, text: "\(period) dönemi \"Değişiklik yok\" olarak kaydedildi.")
        } catch let e as APIError {
            // 422 period_before_assessment: sunucu iletisi (ilk dönem dahil) olduğu gibi; kayıt yenilenerek seçenekler güncellenir.
            actionNotice = Notice(tone: e.isOffline || e.outcomeUnknown ? .warn : .error, text: e.message)
            if e.isConflict || e.outcomeUnknown || e.code == "period_before_assessment" { await load() }
        } catch { actionNotice = Notice.from(error) }
    }
}

/// 5×5 matris (RISK_MATRIX birebir): satır = risk bandı (üstte 80–100), sütun = kritiklik 1–5; seçili hücre vurgulu.
struct RiskMatrixView: View {
    let band: Int
    let column: Int
    @ScaledMetric(relativeTo: .caption2) private var labelWidth: CGFloat = 44
    @ScaledMetric(relativeTo: .caption) private var cellHeight: CGFloat = 28
    static let levels: [[Int]] = [[1, 1, 2, 2, 3], [1, 2, 2, 3, 3], [2, 2, 3, 3, 4], [2, 3, 3, 4, 5], [3, 3, 4, 5, 5]]
    static let bandLabels = ["0–20", "20–40", "40–60", "60–80", "80–100"]
    var body: some View {
        VStack(spacing: 3) {
            ForEach((1...5).reversed(), id: \.self) { b in
                HStack(spacing: 3) {
                    Text(Self.bandLabels[b - 1]).font(.caption2).foregroundStyle(.secondary).frame(width: labelWidth, alignment: .trailing).accessibilityHidden(true)
                    ForEach(1...5, id: \.self) { c in cell(b, c) }
                }
            }
            HStack(spacing: 3) {
                Spacer().frame(width: labelWidth)
                ForEach(1...5, id: \.self) { c in Text("\(c)").font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity).accessibilityHidden(true) }
            }
            Text("Satır: risk skoru bandı; sütun: kritiklik").font(.caption2).foregroundStyle(.secondary).accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
    }
    private func cell(_ b: Int, _ c: Int) -> some View {
        let level = Self.levels[b - 1][c - 1]
        let selected = b == band && c == column
        return Text("\(level)").font(.caption.weight(selected ? .bold : .regular))
            .frame(maxWidth: .infinity, minHeight: cellHeight)
            .background(RiskLabels.color(level).opacity(selected ? 0.9 : 0.25), in: RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(selected ? Color.primary : .clear, lineWidth: 2))
            .foregroundStyle(selected ? Color.black : Color.primary) // açık seviye renkleri (yeşil/nane/sarı/turuncu/kırmızı %90) üzerinde siyah ≥ 4,5:1
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Risk \(Self.bandLabels[b - 1]), kritiklik \(c), seviye \(level)")
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityValue(selected ? "Bu değerlendirmenin hücresi" : "")
    }
}

enum RiskLabels {
    static let status = ["OPEN": "Açık", "COMPLETED": "Tamamlandı", "CANCELLED": "İptal edildi"]
    static let scoreSource = ["QUESTIONS": "Soru seti", "MANUAL_RESULT": "Elle girilen şablon sonucu", "IMPORT": "Excel içe aktarımı"]
    static let actionKind = ["MITIGATION": "Aksiyon", "CONTROL": "Denetim / kontrol"]
    static let actionStatus = ["OPEN": "Açık", "DONE": "Tamamlandı", "VERIFIED": "Doğrulandı", "CANCELLED": "İptal"]
    static let criteria = [
        "businessImpact": "Hizmetin iş süreçlerine etkisi", "dataSensitivity": "Veri hassasiyeti", "continuity": "Süreklilik ve bağımlılık düzeyi",
        "integration": "Entegrasyon derinliği", "regulation": "Regülasyon uyumu gerekliliği", "serviceType": "Hizmet tipi ve süresi",
    ]
    static func field(_ key: String) -> String {
        if key == "riskScore" { return "Risk skoru" }
        if key.hasPrefix("criteria.") { return criteria[String(key.dropFirst(9))] ?? "Ölçüt" }
        if key.hasPrefix("answers.") { return "Soru \(key.dropFirst(8)) cevabı" }
        return key
    }
    static func color(_ level: Int) -> Color {
        switch level { case 1: .green; case 2: .mint; case 3: .yellow; case 4: .orange; default: .red }
    }
}

enum RiskFmt {
    /// Kritiklik: sunucunun 2 haneli gösterimi; yoksa 4 haneli değerden tr-TR 2 hane.
    static func criticality(_ c: RiskDetail.Criticality?) -> String {
        guard let c else { return "Henüz yok" }
        if let d = c.display { return d }
        guard let v = c.value, let dec = Decimal(string: v) else { return "Henüz yok" }
        let f = NumberFormatter(); f.locale = Locale(identifier: "tr_TR"); f.numberStyle = .decimal; f.minimumFractionDigits = 2; f.maximumFractionDigits = 2
        return f.string(from: dec as NSDecimalNumber) ?? v
    }
    /// Kaydı olmayan dönemler `YYYY-Ç`: değerlendirme yılının çeyrekleri, cari İstanbul çeyreğine kadar (geçmiş yılda 4'ü); en eski başta.
    static func missingPeriods(year: Int?, reviews: [RiskDetail.Review], floor: String? = nil, now: Date = Date()) -> [String] {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        let y = cal.component(.year, from: now), q = (cal.component(.month, from: now) - 1) / 3 + 1
        guard let year, year <= y else { return [] }
        let last = year == y ? q : 4
        let done = Set(reviews.compactMap(\.period))
        // Faz 6 M6: ilk revizyonun çeyreğinden önceki dönem seçilemez (sunucu 422 period_before_assessment verir).
        let low = floor.flatMap { f -> (Int, Int)? in let p = f.split(separator: "-"); guard p.count == 2, let a = Int(p[0]), let b = Int(p[1]) else { return nil }; return (a, b) }
        return (1...last).filter { q in low.map { (year, q) >= $0 } ?? true }.map { "\(year)-\($0)" }.filter { !done.contains($0) }
    }
    /// Görev başlığındaki dönem (`risk_quarterly_review` başlığı: "… gözden geçirmesi 2026-2: Tedarikçi").
    static func period(inTitle title: String) -> String? {
        guard let r = title.range(of: #"\d{4}-[1-4]"#, options: .regularExpression) else { return nil }
        return String(title[r])
    }
    /// Web taban adresi: Info.plist SPWebBaseURL; yoksa yerel geliştirmede 4100 → 5174, aksi halde API ile aynı kök.
    static func webURL(session: SessionStore, assessmentId: String) -> URL? {
        let configured = Bundle.main.object(forInfoDictionaryKey: "SPWebBaseURL") as? String
        var base: String
        if let configured, configured.hasPrefix("http") { base = configured }
        else {
            let api = session.api.baseURL
            if api.port == 4100, api.host == "localhost" { base = "http://localhost:5174" } else { base = api.absoluteString }
        }
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: "\(base)/tedarikciler/risk/\(assessmentId)")
    }
}

/// Tedarikçi özetindeki "Yıllık risk" bölümü: son tamamlanmış yıl, seviye ve skor (risk-history; kartta risk alanı yok).
/// Durum üst görünümde yüklenir (boş bir görünüme .task bağlanmaz); izin yoksa ya da istek başarısızsa bölüm görünmez.
enum AnnualRisk: Sendable {
    case empty
    case item(RiskHistory.Item)
}

struct SupplierAnnualRiskSection: View {
    let state: AnnualRisk?
    var body: some View {
        switch state {
        case .item(let item):
            Section("Yıllık risk") {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Son değerlendirme yılı: \(item.year.map(String.init) ?? "—")").font(.body)
                    Text(item.levelLabel ?? "Seviye yok").font(.subheadline.weight(.semibold))
                    Text("Risk skoru: \(item.riskScore.map { Fmt.amount($0) } ?? "—") · Kritiklik: \(item.criticalityDisplay ?? "—")").font(.subheadline).foregroundStyle(.secondary)
                }.accessibilityElement(children: .combine)
            }
        case .empty:
            Section("Yıllık risk") { Text("Tamamlanmış yıllık risk değerlendirmesi yok.").foregroundStyle(.secondary) }
        case nil: EmptyView()
        }
    }

    /// Son tamamlanmış yıl (çeyreklik güncelleme açıkken önceki tamamlanmış yıl gösterilir). Hata sessizdir: mevcut özet bozulmaz.
    static func load(session: SessionStore, supplierId: String) async -> AnnualRisk? {
        guard let (h, _): (RiskHistory, String?) = try? await session.get("/api/v1/suppliers/\(supplierId)/risk-history") else { return nil }
        let done = (h.items ?? []).filter { $0.status == "COMPLETED" }.max { ($0.year ?? 0) < ($1.year ?? 0) }
        return done.map { .item($0) } ?? AnnualRisk.empty
    }
}
