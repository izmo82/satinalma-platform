// v2 Faz 6 (D111): yıllık tedarikçi risk değerlendirmesi — web ortak sabitleri, canlı hesap ve 5×5 matris bileşeni.
// Sabitler @sp/domain riskV2.ts ile birebirdir (web paketi domain'i içe aktarmaz). Sunucu her okumada aynı hesabı yeniden yapar;
// buradaki canlı hesap yalnız kaydetmeden önceki önizlemedir (kayıtlı sonuç sunucunundur).
import type { Label } from './labels.ts';
import { cn } from '@/lib/utils';

export const RISK_CRITERIA = ['businessImpact', 'dataSensitivity', 'continuity', 'integration', 'regulation', 'serviceType'] as const;
export type RiskCriterion = (typeof RISK_CRITERIA)[number];
export const RISK_CRITERIA_TR: Record<RiskCriterion, string> = {
  businessImpact: 'Hizmetin İş Süreçlerine Etkisi',
  dataSensitivity: 'Veri Hassasiyeti',
  continuity: 'Süreklilik ve Bağımlılık Düzeyi',
  integration: 'Entegrasyon Derinliği',
  regulation: 'Regülasyon Uyumu Gerekliliği',
  serviceType: 'Hizmet Tipi ve Süresi',
};
export const RISK_CRITERIA_LEVELS: Record<RiskCriterion, Record<1 | 3 | 5, string>> = {
  businessImpact: { 1: 'Yardımcı hizmet', 3: 'Önemli ama yedeklenebilir', 5: 'Kritik süreç bu tedarikçiye bağlı' },
  dataSensitivity: { 1: 'Genel/halka açık', 3: 'Kurumsal hassas', 5: 'Kişisel, finansal, regülasyona tabi' },
  continuity: { 1: 'Alternatif var, geçici', 3: 'Orta bağımlılık, dönemsel', 5: 'Alternatifsiz, sistemik' },
  integration: { 1: 'Sistem erişimi yok', 3: 'Sınırlı entegrasyon/VPN', 5: 'Sürekli erişim, yüksek entegrasyon' },
  regulation: { 1: 'Tabi değil', 3: 'Dolaylı (iç politika, denetim)', 5: 'KVKK, ISO vb. zorunlu' },
  serviceType: { 1: 'Kısa, tek seferlik', 3: 'Orta vadeli, proje bazlı', 5: 'Sürekli, SLA\'lı uzun dönem' },
};
/** Satır = bant 1 (0–20) … 5 (80–100); sütun = kritiklik 1–5 (Excel "Risk Grafiği" ile birebir). */
export const RISK_MATRIX = [
  [1, 1, 2, 2, 3],
  [1, 2, 2, 3, 3],
  [2, 2, 3, 3, 4],
  [2, 3, 3, 4, 5],
  [3, 3, 4, 5, 5],
] as const;
export const RISK_BAND_LABEL: Record<number, string> = { 1: '0–20', 2: '20–40', 3: '40–60', 4: '60–80', 5: '80–100' };
export const RISK_LEVEL_TR: Record<number, string> = {
  1: 'Seviye 1 — Kabul edilebilir', 2: 'Seviye 2', 3: 'Seviye 3', 4: 'Seviye 4 — Turuncu', 5: 'Seviye 5 — Kırmızı',
};
export const SCORE_SOURCE_TR: Record<string, string> = { QUESTIONS: 'Soru seti', MANUAL_RESULT: 'Elle girilen şablon sonucu', IMPORT: 'Excel içe aktarımı' };
export const ASSESSMENT_STATUS_TR: Record<string, string> = { OPEN: 'Açık', COMPLETED: 'Tamamlandı', CANCELLED: 'İptal' };
export const ACTION_STATUS_TR: Record<string, string> = { OPEN: 'Açık', DONE: 'Tamamlandı', VERIFIED: 'Doğrulandı', CANCELLED: 'İptal' };
export const ACTION_KIND_TR: Record<string, string> = { MITIGATION: 'Aksiyon (azaltım)', CONTROL: 'Denetim/kontrol' };
export const CONTROL_METHOD_TR: Record<string, string> = { ON_SITE: 'Yerinde', ONLINE: 'Online', DESK: 'Kanıt kontrolü – masabaşı' };
export const REVIEW_OUTCOME_TR: Record<string, string> = { NO_CHANGE: 'Değişiklik yok', UPDATED: 'Güncellendi', UPDATE: 'Güncellendi' };

/** Seviye renkleri Figma 16: 1–2 kâğıt grisi, 3 sarı (uyarı zemini), 5 kırmızı zemin + koyu çerçeve. v2 Faz 6 izleme: 4 etiketindeki "Turuncu" ile tutarlı turuncu zemin (Figma'da 4 ve 5 aynı kırmızıydı). */
export const LEVEL_CELL: Record<number, string> = {
  1: 'bg-sunken', 2: 'bg-sunken', 3: 'bg-warn-soft', 4: 'bg-orange-soft', 5: 'bg-danger-soft',
};
export const levelTag = (level: number | null | undefined, label?: string | null): Label | undefined => {
  if (!level) return undefined;
  const text = label ?? RISK_LEVEL_TR[level] ?? `Seviye ${level}`;
  if (level >= 5) return { text, tone: 'danger', icon: 'alert' };
  if (level === 4) return { text, tone: 'orange', icon: 'alert' };
  if (level === 3) return { text, tone: 'warn', icon: 'alert' };
  return { text, tone: 'neutral', icon: level === 1 ? 'check' : 'minus' };
};

/** Decimal string → tr-TR ("46.00" → "46,00"); 2 hane. */
export const fmtScore = (v: string | number | null | undefined) => {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
};

/** Kritiklik canlı önizleme (R1): geometrik ortalama, 6 hane, ekranda yarım yukarı 2 hane; sütun yuvarlanmamış değerden. */
export function liveCriticality(c: Partial<Record<RiskCriterion, number>>): { display: string; column: number } | null {
  if (!RISK_CRITERIA.every((k) => c[k] === 1 || c[k] === 3 || c[k] === 5)) return null;
  const raw = Math.exp(RISK_CRITERIA.reduce((s, k) => s + Math.log(c[k]!), 0) / RISK_CRITERIA.length);
  const micro = Math.round(raw * 1e6);
  const hundredths = Math.floor((micro + 5000) / 10000);
  const display = `${Math.floor(hundredths / 100)},${String(hundredths % 100).padStart(2, '0')}`;
  return { display, column: Math.min(5, Math.max(1, Math.round(raw))) };
}

const cents = (w: string) => Math.round(Number(w) * 100);
/** Risk skoru canlı önizleme (R3): Σ(ağırlık × riskli cevap) / Σ ağırlık × 100, 2 hane yarım yukarı; eksik cevapta yok. */
export function liveScore(questions: { code: string; weight: string; riskAnswer: string }[], answers: Record<string, string | null | undefined>): string | null {
  if (!questions.length || questions.some((q) => answers[q.code] !== 'YES' && answers[q.code] !== 'NO')) return null;
  const total = questions.reduce((s, q) => s + cents(q.weight), 0);
  if (!total) return null;
  const risky = questions.reduce((s, q) => s + (answers[q.code] === q.riskAnswer ? cents(q.weight) : 0), 0);
  const q = Math.floor((2 * risky * 10000 + total) / (2 * total));
  return `${Math.floor(q / 100)}.${String(q % 100).padStart(2, '0')}`;
}

/** Bant üst sınırı dahil: [0,20], (20,40], … (R2). */
export function bandOf(score: string | number): number {
  const n = Number(score);
  for (let b = 1; b <= 5; b++) if (n <= b * 20 + 1e-9) return b;
  return 5;
}
export const levelOf = (score: string | number, column: number) => RISK_MATRIX[bandOf(score) - 1]![column - 1]!;

/** "2026-11-18" İstanbul günü. */
export const istanbulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
export const currentYear = () => Number(istanbulToday().slice(0, 4));
export const currentPeriod = () => { const d = istanbulToday(); return `${d.slice(0, 4)}-${Math.ceil(Number(d.slice(5, 7)) / 3)}`; };

/** Değişen alan anahtarı → Türkçe ("criteria.dataSensitivity" → "Veri Hassasiyeti"). */
export const changedLabel = (k: string) => k.startsWith('criteria.') ? RISK_CRITERIA_TR[k.slice(9) as RiskCriterion] ?? k
  : k.startsWith('answers.') ? `Soru ${k.slice(8)}` : k === 'riskScore' ? 'Risk skoru' : k;

export interface MatrixCell { band: number; column: number; level: number; count?: number }

/**
 * 5×5 risk matrisi (Figma 16): üstte 80–100, sütunlar kritiklik 1–5. `counts` verilirse hücrede sayı (seviye ipucunda), yoksa seviye no.
 * `onSelect` verilirse hücreler düğmedir (basılı durum `selected`). `highlight` tek hücreyi kalın çerçeveyle vurgular.
 */
export function RiskMatrix({ cells, selected, onSelect, highlight, caption, compact }: {
  cells?: MatrixCell[]; selected?: { band: number; column: number } | null; onSelect?: (c: { band: number; column: number }) => void;
  highlight?: { band: number; column: number } | null; caption: string; compact?: boolean;
}) {
  const at = (band: number, column: number) => cells?.find((c) => c.band === band && c.column === column);
  const size = compact ? 'h-8 min-w-9 text-sm' : 'h-11 min-w-11';
  return (
    <div className="min-w-0">
      <table className="w-full border-separate border-spacing-1">
        <caption className="sr-only">{caption}</caption>
        <thead><tr>
          <th scope="col" className="w-14 text-left text-xs font-semibold text-ink-subtle"><span className="sr-only">Risk skoru bandı</span></th>
          {[1, 2, 3, 4, 5].map((c) => <th key={c} scope="col" className="text-center text-xs font-semibold text-ink-muted"><span className="sr-only">Kritiklik </span>{c}</th>)}
        </tr></thead>
        <tbody>{[5, 4, 3, 2, 1].map((band) => (
          <tr key={band}>
            <th scope="row" className="whitespace-nowrap pr-1 text-left text-xs font-semibold text-ink-muted"><span className="sr-only">Risk </span>{RISK_BAND_LABEL[band]}</th>
            {[1, 2, 3, 4, 5].map((column) => {
              const level = RISK_MATRIX[band - 1]![column - 1]!;
              const cell = at(band, column);
              const count = cell?.count;
              const isSel = !!selected && selected.band === band && selected.column === column;
              const isHi = !!highlight && highlight.band === band && highlight.column === column;
              const label = `Risk ${RISK_BAND_LABEL[band]}, kritiklik ${column}, seviye ${level}${count !== undefined ? `: ${count} değerlendirme` : ''}`;
              const body = count !== undefined
                ? <><span className="tabular font-semibold">{count}</span><span className="sr-only"> değerlendirme</span></>
                : <span className="tabular font-semibold">{level}</span>;
              const cls = cn('flex w-full items-center justify-center rounded-sm border text-ink', size, LEVEL_CELL[level],
                level === 5 ? 'border-[#e5b9b0]' : 'border-transparent',
                (isSel || isHi) && 'border-2 border-ink', count === 0 && 'text-ink-subtle');
              return (
                <td key={column} className="p-0">
                  {onSelect ? (
                    <button type="button" aria-pressed={isSel} aria-label={label} title={`Seviye ${level}`} className={cn(cls, 'transition-colors duration-150 hover:border-ink-muted')}
                      onClick={() => onSelect({ band, column })}>{body}</button>
                  ) : <div className={cls} title={label} aria-label={isHi ? `${label} (bu değerlendirme)` : undefined} role={isHi ? 'img' : undefined}>{body}</div>}
                </td>
              );
            })}
          </tr>
        ))}</tbody>
      </table>
      <p className="mt-1 text-xs text-ink-subtle">Sütun: kritiklik (1–5) · Satır: risk skoru (0–100){cells?.some((c) => c.count !== undefined) ? ' · hücrede değerlendirme sayısı' : ' · hücrede seviye'}</p>
    </div>
  );
}
