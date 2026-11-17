import SwiftUI

/// v2 Faz 4 (D109): sözleşme yapay zekâ ekranlarının ortak parçaları (web `ContractReview.tsx` ile aynı dil). Okuma önerisi ve ön inceleme
/// yalnız bilgidir: kritik alanlar forma önceden yazılmaz, puan onay vermez ve gönderimi/onayı engellemez. Test sağlayıcısının çıktısı her
/// yerde "Test sağlayıcısı — gerçek değil" etiketiyle görünür.
enum AiText {
    static let disclaimer = "Yapay zekâ ön incelemesidir, hukuki görüş değildir."
    static let testProvider = "Test sağlayıcısı — gerçek değil"
    static let confidence: [String: String] = ["HIGH": "yüksek", "MEDIUM": "orta", "LOW": "düşük", "MISSING": "okunamadı"]
    static let severity: [String: String] = ["HIGH": "Yüksek", "MEDIUM": "Orta", "LOW": "Düşük", "INFO": "Bilgi"]
    static let severities = ["HIGH", "MEDIUM", "LOW", "INFO"]
    static let kind: [String: String] = [
        "MISSING_CLAUSE": "Şablondaki madde eksik", "MODIFIED_CLAUSE": "Şablondan farklı", "UNFAVORABLE": "Kurum aleyhine",
        "EXTRA_CLAUSE": "Şablonda olmayan madde", "LEGAL_RISK": "Hukuki risk",
    ]
    private static let flag: [String: String] = [
        "UNVERIFIED_SCAN": "Taranmış sayfa: alıntı doğrulanamadı", "UNDERIVABLE": "Değer alıntıdan kesin türetilemedi", "SOURCE_NOT_FOUND": "Kaynak alıntı belgede bulunamadı",
        "VALUE_NOT_IN_SOURCE": "Değer alıntıda yok", "NO_SOURCE": "Kaynak gösterilmedi", "SHORT_QUOTE": "Alıntı çok kısa", "INVALID_TAX_ID": "VKN kontrol basamağı tutmuyor",
        "INVALID_VALUE": "Değer biçimi geçersiz", "INVALID_FORMAT": "Değer biçimi geçersiz", "SOURCE_NOT_VERIFIED": "Kaynak doğrulanamadı",
    ]
    /// İşaret kodları Türkçe; bilinmeyen kod ham gösterilmez. MISSING zaten güven metninde.
    static func flags(_ codes: [String]) -> [String] {
        var out: [String] = []
        for c in codes where c != "MISSING" { let t = flag[c] ?? "Denetim işareti var"; if !out.contains(t) { out.append(t) } }
        return out
    }
    /// Sunucu sebebi yoksa durumdan Türkçe açıklama (ham kod gösterilmez).
    static func reason(_ run: AiRun?, review: Bool = false) -> String {
        guard let run else { return "" }
        if let r = run.reason, !r.isEmpty { return r }
        switch run.status {
        case "WAITING_QUOTA": return "Aylık yapay zekâ bütçesi doldu."
        case "NO_PROVIDER": return "Etkin yapay zekâ sağlayıcısı yok."
        case "NOT_ALLOWED": return "Kiracı politikası bu sağlayıcıya izin vermiyor."
        case "FAILED": return review ? "İnceleme tamamlanamadı." : "Okuma tamamlanamadı."
        default: return ""
        }
    }
    static func runLabel(_ run: AiRun?, review: Bool) -> String {
        guard let run else { return review ? "İncelenmedi" : "Okunmadı" }
        switch run.status {
        case "QUEUED": return "Kuyrukta"
        case "RUNNING": return review ? "İnceleniyor" : "Okunuyor"
        case "SUCCEEDED": return "Tamamlandı"
        case "FAILED": return "Başarısız"
        // Persona K5: politika ya da sağlayıcı yokken inceleme beklemez, hiç çalışmaz.
        case "NOT_ALLOWED", "NO_PROVIDER": return review ? "Çalışmayacak" : "Bekliyor"
        default: return "Bekliyor"
        }
    }
    /// Normalize öneri değeri → ekranda tr-TR (ham kod gösterilmez).
    static func value(_ field: String, _ value: String?, currency: String?) -> String {
        guard let value else { return "—" }
        switch field {
        // Final inceleme M2: para birimi okunmadıysa simge yok (web ile aynı); tutar tr-TR, en az 2 ondalık.
        case "amount": return currency.map { Fmt.money(value, $0) } ?? Fmt.amount(value)
        case "signedOn", "startDate", "endDate": return Fmt.date(value)
        case "indefinite", "autoRenewal": return value == "true" ? "Evet" : value == "false" ? "Hayır" : value
        case "contractType": return ContractLabels.types.first { $0.0 == value }?.1 ?? "Diğer"
        case "limitBasis": return ContractLabels.limitBasis[value] ?? value
        case "noticePeriodDays", "paymentTermDays": return "\(value) gün"
        default: return value
        }
    }
    /// Bulgular: doğrulanmış önce, sonra önem sırası (web ReviewCard ile aynı).
    static func ordered(_ f: [ContractReviews.Finding]) -> [ContractReviews.Finding] {
        // Kararlı sıralama: eşit anahtarda sunucu sırası (ord) korunur.
        f.enumerated().sorted { a, b in
            if a.element.verified != b.element.verified { return a.element.verified }
            let sa = severities.firstIndex(of: a.element.severity) ?? 9, sb = severities.firstIndex(of: b.element.severity) ?? 9
            return sa != sb ? sa < sb : a.offset < b.offset
        }.map(\.element)
    }
    /// "2 yüksek · 1 orta önemde bulgu" (yalnız doğrulanmış bulgular puana girer).
    static func counts(_ f: [ContractReviews.Finding]) -> String {
        let parts = severities.compactMap { s -> String? in
            let n = f.filter { $0.verified && $0.severity == s }.count
            return n > 0 ? "\(n) \((severity[s] ?? s).lowercased(with: Locale(identifier: "tr_TR")))" : nil
        }
        let unverified = f.filter { !$0.verified }.count
        let base = parts.isEmpty ? "Doğrulanmış bulgu yok" : parts.joined(separator: " · ") + " önemde bulgu"
        return unverified > 0 ? "\(base) · \(unverified) kaynağı doğrulanamayan (puana girmez)" : base
    }
}

/// "Test sağlayıcısı — gerçek değil" etiketi: test sağlayıcısının çıktısı gerçek okuma ya da gerçek inceleme değildir.
struct TestProviderTag: View {
    var label: String?
    var body: some View {
        Label(label ?? AiText.testProvider, systemImage: "exclamationmark.triangle")
            .font(.caption.weight(.semibold))
            .foregroundStyle(StatusBadge.adaptive(light: (0.60, 0.29, 0.0), dark: (1.0, 0.72, 0.40)))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
            .accessibilityLabel(label ?? AiText.testProvider)
    }
}

/// Önem etiketi (kırmızı yüksek, turuncu orta, gri düşük/bilgi).
struct SeverityBadge: View {
    let severity: String
    var body: some View {
        let text = AiText.severity[severity] ?? "Bilgi"
        let color: Color = severity == "HIGH" ? .red : severity == "MEDIUM" ? .orange : .secondary
        let fg: Color = switch severity {
        case "HIGH": StatusBadge.adaptive(light: (0.70, 0.07, 0.07), dark: (1.0, 0.55, 0.52))
        case "MEDIUM": StatusBadge.adaptive(light: (0.60, 0.29, 0.0), dark: (1.0, 0.72, 0.40))
        default: .secondary
        }
        Text(text).font(.caption.weight(.semibold)).foregroundStyle(fg)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
            .accessibilityLabel("Önem: \(text)")
    }
}

/// Puan "78 / 100" (yalnız bilgi).
struct ScoreText: View {
    let score: Int
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text("\(score)").font(.title.weight(.bold)).monospacedDigit()
            Text("/ 100").font(.subheadline).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Ön inceleme puanı \(score) / 100")
    }
}

/// Bulgu satırı (özet kartında kısa; tam listede alıntı, şablon atfı, öneri ve sayfa bağlantısıyla).
struct FindingRow: View {
    let f: ContractReviews.Finding
    var full = false
    var documentVersionId: String?
    var sha256: String?
    var title = "Sözleşme"
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AdaptiveStack {
                SeverityBadge(severity: f.severity)
                Text(f.title).font(.subheadline.weight(.semibold))
            }
            if !f.verified { Text(f.sourceLabel ?? "kaynak doğrulanamadı").font(.footnote).foregroundStyle(.orange) }
            if full {
                Text("\(AiText.kind[f.kind] ?? "Bulgu") · \(f.categoryLabel)").font(.footnote).foregroundStyle(.secondary)
                if let q = f.quote, !q.isEmpty { Text("“\(q)”").font(.footnote).italic() }
                if f.kind == "MISSING_CLAUSE", let t = f.templateRef, !t.isEmpty { Text("Şablonda: \(t)").font(.footnote).foregroundStyle(.secondary) }
                if let s = f.suggestion, !s.isEmpty { Text("Öneri: \(s)").font(.footnote) }
            }
            if let p = f.page {
                if full, let dv = documentVersionId {
                    NavigationLink { DocumentPreview(documentVersionId: dv, expectedSha256: sha256, title: title, page: p) } label: {
                        Text("\(p). sayfa").font(.footnote.weight(.semibold)).tapTarget()
                    }
                    // Ek almayan biçim (web ile aynı); etiket görünen metni içerir.
                    .accessibilityLabel("\(f.title): Belgeyi \(p). sayfada aç, \(p). sayfa")
                } else {
                    Text("s. \(p)").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// İnceleme kayıtlarını getirir; iş kuyruktayken 3 sn aralıkla yeniden sorar, en çok 2 dk (R11).
@MainActor
func pollReviews(_ session: SessionStore, familyId: String, update: (Result<ContractReviews, Error>) -> Void, timedOut: () -> Void) async {
    let start = Date()
    while !Task.isCancelled {
        do {
            let (r, _): (ContractReviews, String?) = try await session.get("/api/v1/contracts/\(familyId)/reviews")
            update(.success(r))
            guard r.run?.active == true else { return }
        } catch {
            // Görev iptali (ekrandan çıkış, yenileme) hata olarak gösterilmez.
            if Task.isCancelled || error is CancellationError { return }
            update(.failure(error)); return
        }
        if Date().timeIntervalSince(start) > 120 { timedOut(); return }
        try? await Task.sleep(for: .seconds(3))
    }
}

/// Sözleşme onayı (Figma iOS 4) ve özetteki ön inceleme kartı: puan, en önemli 3 bulgu, uyarı metni, "Tüm bulgular".
/// Onaycı için yalnız bilgi; karar düğmelerini değiştirmez, istek göndermez.
struct ReviewInfoCard: View {
    let data: ContractReviews?
    let error: Notice?
    let timedOut: Bool
    let familyId: String
    /// Hata durumunda "Yeniden dene" (yeniden sorar).
    var retry: (() -> Void)? = nil
    var body: some View {
        if let d = data {
            if let cur = d.current {
                AdaptiveStack {
                    Text("Ön inceleme puanı").font(.subheadline.weight(.semibold))
                    HSpacer()
                    ScoreText(score: cur.score)
                }
                if cur.isTestProvider { TestProviderTag(label: cur.providerLabel) }
                Label(d.disclaimer, systemImage: "sparkles").font(.footnote).foregroundStyle(.secondary)
                Text(statusLine(d, cur)).font(.footnote).foregroundStyle(cur.stale ? .orange : .secondary)
                if let a = d.submitAcknowledgement { AckLine(ack: a) }
                Text(AiText.counts(cur.findings)).font(.footnote)
                ForEach(AiText.ordered(cur.findings).prefix(3)) { f in FindingRow(f: f) }
                NavigationLink { ContractReviewView(familyId: familyId) } label: {
                    Text(cur.findings.isEmpty ? "İnceleme ayrıntısı" : "Tüm bulgular (\(cur.findings.count))").font(.subheadline.weight(.semibold))
                }
            } else {
                if let run = d.run, run.isTestProvider { TestProviderTag(label: run.providerLabel) }
                Label {
                    Text(emptyLine(d, timedOut: timedOut)).font(.footnote).foregroundStyle(.secondary)
                } icon: { Image(systemName: "sparkles").foregroundStyle(.secondary) }
                if d.run?.active == true && !timedOut { ProgressView().accessibilityLabel("İnceleniyor") }
                if !d.history.isEmpty {
                    NavigationLink { ContractReviewView(familyId: familyId) } label: { Text("Geçmiş incelemeler").font(.subheadline) }
                }
            }
        } else if let error {
            Label("Ön inceleme alınamadı: \(error.text) Belgeyi kendiniz inceleyin.", systemImage: "sparkles").font(.footnote).foregroundStyle(.secondary)
            if let retry { Button("Yeniden dene", action: retry) }
        } else {
            ProgressView("Ön inceleme yükleniyor").frame(maxWidth: .infinity)
        }
    }
    private func statusLine(_ d: ContractReviews, _ cur: ContractReviews.Current) -> String {
        var s = "Eşik \(d.threshold)"
        if d.belowThreshold { s += " · eşiğin altında (bilgi; onayı engellemez)" }
        if cur.stale { s += " · güncel değil: belge ya da şablon sürümü incelemeden sonra değişti" }
        if let n = cur.templateNote { s += " · \(n)" }
        if let n = cur.templateUsageNote { s += " · \(n)" }
        return s + ". Puan onay vermez; belgeyi siz incelersiniz."
    }
}

/// Persona K3: gönderen, gönderim anında eşik altı puanı onaylayarak gönderdi (o anki eşikle; canlı eşik sonradan değişebilir).
struct AckLine: View {
    let ack: ReviewAcknowledgement
    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(ack.text)
                Text("\(ack.by.map { "\($0.displayName) · " } ?? "")\(Fmt.date(ack.at))").foregroundStyle(.secondary)
            }
        } icon: { Image(systemName: "exclamationmark.triangle") }
        .font(.footnote).foregroundStyle(.orange)
    }
}

/// İnceleme yoksa dürüst durum (sebep metniyle).
func emptyLine(_ d: ContractReviews, timedOut: Bool) -> String {
    guard let run = d.run else { return "Bu belge sürümü için ön inceleme yapılmadı. Belgeyi kendiniz inceleyin." }
    if run.active { return timedOut ? "İnceleme sürüyor; beklemeniz gerekmez." : "İnceleniyor… Sonuç birkaç saniye içinde burada görünür." }
    if run.status == "FAILED" { return "İnceleme tamamlanamadı. \(AiText.reason(run, review: true)) Belgeyi kendiniz inceleyin." }
    // Persona K5: politika ya da sağlayıcı yokken "bekliyor" değil; inceleme çalışmayacak.
    if run.status == "NOT_ALLOWED" || run.status == "NO_PROVIDER" {
        return "Ön inceleme çalışmayacak: \(AiText.reason(run, review: true)) İnceleme yapılmadı; gönderim açık, belgeyi kendiniz inceleyin."
    }
    return "İnceleme yapılmadı. \(AiText.reason(run, review: true)) Belgeyi kendiniz inceleyin."
}

/// "Tüm bulgular" (Figma iOS 4'ten): puan, alt puanlar, bulgu listesi (önem, tür, alıntı, sayfa, öneri), genel yorum, köken ve geçmiş.
/// Yeni inceleme yalnız `can.request` (ekleyen departman / Satınalma) ve güncel olmayan, eksik ya da çalışmamış incelemede istenir (R9).
struct ContractReviewView: View {
    let familyId: String
    @Environment(SessionStore.self) private var session
    @State private var data: ContractReviews?
    @State private var contract: ContractV2?
    @State private var error: Notice?
    @State private var notice: Notice?
    @State private var timedOut = false
    @State private var busy = false
    @State private var severity = ""
    @State private var pollToken = UUID()

    var body: some View {
        List {
            OfflineBanner().listRowInsets(EdgeInsets())
            if let notice { NoticeView(notice: notice) }
            Loadable(value: data, error: error, retry: { pollToken = UUID() }) { d in
                Section {
                    Label(d.disclaimer, systemImage: "sparkles").font(.footnote)
                    Text("Puan onay vermez, onayı ve gönderimi engellemez; onaycılar bilgi olarak görür.").font(.footnote).foregroundStyle(.secondary)
                    if let label = d.current?.isTestProvider == true ? d.current?.providerLabel ?? AiText.testProvider : d.run?.isTestProvider == true ? d.run?.providerLabel ?? AiText.testProvider : nil {
                        TestProviderTag(label: label)
                    }
                    if canAsk(d) {
                        Button { Task { await request() } } label: { Label(d.current == nil ? "İncele" : "Yeniden incele", systemImage: "arrow.clockwise") }
                            .disabled(busy || !session.isOnline)
                    }
                }
                if let cur = d.current {
                    if cur.stale {
                        Section { Label("Bu inceleme güncel değil: belge ya da şablon sürümü incelemeden sonra değişti.", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange) }
                    }
                    if !cur.stale, let run = d.run, run.status != "SUCCEEDED" {
                        Section { Text("Son istek: \(AiText.runLabel(run, review: true)). \(AiText.reason(run, review: true))").font(.footnote).foregroundStyle(.secondary) }
                    }
                    Section("Ön inceleme puanı") {
                        AdaptiveStack {
                            ScoreText(score: cur.score)
                            HSpacer()
                            Text("Eşik \(d.threshold)\(d.belowThreshold ? " · eşiğin altında" : "")").font(.footnote).foregroundStyle(d.belowThreshold ? .orange : .secondary)
                        }
                        if d.belowThreshold, let a = d.advice { Text("\(a) Ek onaycı web uygulamasında eklenir; zorunlu değildir.").font(.footnote).foregroundStyle(.orange) }
                        if let n = cur.templateNote { Text(n).font(.footnote).foregroundStyle(.secondary) }
                        if let n = cur.templateUsageNote { Text(n).font(.footnote).foregroundStyle(.secondary) }
                        if let a = d.submitAcknowledgement { AckLine(ack: a) }
                        ForEach(cur.subScoreList) { s in LabeledContent(s.label, value: s.score.map(String.init) ?? "—") }
                    }
                    Section {
                        Picker("Önem", selection: $severity) {
                            Text("Tümü (\(cur.findings.count))").tag("")
                            ForEach(AiText.severities, id: \.self) { s in Text("\(AiText.severity[s] ?? s) (\(cur.findings.filter { $0.severity == s }.count))").tag(s) }
                        }
                        .pickerStyle(.menu)
                        let list = AiText.ordered(cur.findings).filter { severity.isEmpty || $0.severity == severity }
                        if list.isEmpty { Text(cur.findings.isEmpty ? "Bulgu yok." : "Bu önemde bulgu yok.").foregroundStyle(.secondary) }
                        ForEach(list) { f in
                            FindingRow(f: f, full: true, documentVersionId: docVersion(cur), sha256: contract?.document?.sha256, title: contract?.family.title ?? "Sözleşme")
                        }
                    } header: { Text("Bulgular") } footer: { Text(AiText.counts(cur.findings)) }
                    if let s = cur.summary, !s.isEmpty { Section("Genel yorum") { Text(s).font(.subheadline) } }
                    Section("Köken") {
                        Text("Model \(cur.modelId ?? "—") · istem \(cur.promptVersion) · puan kuralı \(cur.rubricVersion) · \(cur.template.map { "şablon \($0.code) v\($0.versionNo)" } ?? "şablon yok") · \(Fmt.date(cur.createdAt))")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                } else {
                    Section("Ön inceleme") {
                        Text(emptyLine(d, timedOut: timedOut)).font(.subheadline)
                        if d.run?.active == true && !timedOut { ProgressView() }
                    }
                }
                if !d.history.isEmpty {
                    Section("Geçmiş incelemeler") {
                        ForEach(d.history) { h in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Puan \(h.score) · \(Fmt.date(h.createdAt))").font(.subheadline)
                                Text("\(h.template.map { "Şablon \($0.code) v\($0.versionNo)" } ?? "Şablon yok") · model \(h.modelId ?? "—") · \(h.stale ? "güncel değil" : "güncel")")
                                    .font(.footnote).foregroundStyle(.secondary)
                                if h.isTestProvider { TestProviderTag(label: h.providerLabel) }
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
        }
        .navigationTitle("Ön inceleme")
        .refreshable { pollToken = UUID() }
        .task(id: pollToken) {
            timedOut = false
            if contract == nil {
                let r: (ContractV2, String?)? = try? await session.get("/api/v1/contracts/\(familyId)/v2")
                contract = r?.0
            }
            await pollReviews(session, familyId: familyId, update: { r in
                switch r { case .success(let d): data = d; error = nil; case .failure(let e): error = Notice.from(e) }
            }, timedOut: { timedOut = true })
        }
    }

    /// Bulgunun sayfası incelenen belge sürümünde; yalnız güncel belge sürümüyse önizleme açılır (eski sürümün sayfası yanıltmasın).
    private func docVersion(_ cur: ContractReviews.Current) -> String? {
        guard let dv = contract?.document?.documentVersionId, dv == cur.documentVersionId else { return nil }
        return dv
    }
    private func canAsk(_ d: ContractReviews) -> Bool {
        guard d.can.request, d.run?.active != true else { return false }
        guard let cur = d.current else { return true }
        return cur.stale || (d.run.map { $0.status != "SUCCEEDED" } ?? false)
    }
    private func request() async {
        busy = true; defer { busy = false }
        do {
            let r: AiRequestResult = try await session.post("/api/v1/contracts/\(familyId)/reviews")
            notice = Notice(tone: .info, text: r.status == "QUEUED" || r.status == "RUNNING" ? "İnceleme istendi." : (r.reason ?? "İnceleme istendi."))
            pollToken = UUID()
        } catch { notice = Notice.from(error) }
    }
}

/// İncele ve gönder adımındaki ön inceleme kartı (web ReviewCard). İstek yalnız iş yoksa ya da çalışmadan bekliyorsa (ücret yaratmaz)
/// kendiliğinden gönderilir; ücretli denemesi başarısız olmuş iş kendiliğinden yeniden istenmez ("Yeniden incele" kullanıcı eylemidir).
/// Puan gönderimi engellemez; eşik altındaysa ek onaycı önerilir (zorunlu değil).
struct ReviewSubmitCard: View {
    let familyId: String
    /// Ekran yenilenince (aşağı çek) değişir; kart yeniden sorar.
    var refreshID = UUID()
    @Environment(SessionStore.self) private var session
    @State private var data: ContractReviews?
    @State private var error: Notice?
    @State private var notice: Notice?
    @State private var timedOut = false
    @State private var asked = false
    @State private var busy = false
    @State private var pollToken = UUID()

    var body: some View {
        Section {
            if let d = data, let cur = d.current, !cur.stale {
                if d.belowThreshold, let a = d.advice {
                    Label("\(a) Puan \(cur.score), eşik \(d.threshold). Öneri zorunlu değildir; gönderim açık kalır. Ek onaycı web uygulamasında eklenir.", systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(.orange)
                }
            }
            ReviewInfoCard(data: freshOrRun, error: error, timedOut: timedOut, familyId: familyId, retry: { pollToken = UUID() })
            if let d = data, let cur = d.current, cur.stale, !(d.run?.active ?? false) {
                Text("Önceki inceleme (puan \(cur.score)) güncel değil: belge ya da şablon sürümü değişti.").font(.footnote).foregroundStyle(.secondary)
            }
            if let d = data, d.can.request, d.run?.active != true, d.current == nil || d.current?.stale == true {
                Button { Task { await request() } } label: { Label(d.current != nil ? "Yeniden incele" : "İncele", systemImage: "arrow.clockwise") }
                    .disabled(busy || !session.isOnline)
            }
            if let notice { NoticeView(notice: notice) }
        } header: { Text("Ön inceleme") }
        .onChange(of: refreshID) { _, _ in pollToken = UUID() }
        .task(id: pollToken) {
            timedOut = false
            await pollReviews(session, familyId: familyId, update: { r in
                switch r {
                case .success(let d):
                    data = d; error = nil
                    let fresh = d.current.map { !$0.stale } ?? false
                    if !asked, d.can.request, !fresh, d.run == nil || d.run?.waiting == true {
                        asked = true
                        Task { await request() }
                    }
                case .failure(let e): error = Notice.from(e)
                }
            }, timedOut: { timedOut = true })
        }
    }

    /// Adıma girişte: iş yoksa ya da çalışmadan bekliyorsa (ücret yaratmaz) inceleme istenir; başarısız ücretli iş kendiliğinden istenmez.
    @MainActor
    static func requestIfNeeded(_ session: SessionStore, familyId: String) async {
        guard session.isOnline, let (d, _): (ContractReviews, String?) = try? await session.get("/api/v1/contracts/\(familyId)/reviews") else { return }
        let fresh = d.current.map { !$0.stale } ?? false
        guard d.can.request, !fresh, d.run == nil || d.run?.waiting == true else { return }
        let _: AiRequestResult? = try? await session.post("/api/v1/contracts/\(familyId)/reviews")
    }

    /// Güncel olmayan inceleme bu kartta puan olarak gösterilmez (yalnız not); iş durumu gösterilir.
    private var freshOrRun: ContractReviews? {
        guard let d = data else { return nil }
        if let c = d.current, c.stale {
            return ContractReviews(familyId: d.familyId, contractVersionId: d.contractVersionId, documentVersionId: d.documentVersionId, templateVersionId: d.templateVersionId,
                                   current: nil, run: d.run, history: d.history, threshold: d.threshold, belowThreshold: false, advice: nil, disclaimer: d.disclaimer, can: d.can)
        }
        return d
    }

    private func request() async {
        busy = true; defer { busy = false }
        do {
            let r: AiRequestResult = try await session.post("/api/v1/contracts/\(familyId)/reviews")
            if r.status != "QUEUED" && r.status != "RUNNING" && r.status != "SUCCEEDED", let reason = r.reason { notice = Notice(tone: .warn, text: reason) } else { notice = nil }
            pollToken = UUID()
        } catch { notice = Notice.from(error) }
    }
}
