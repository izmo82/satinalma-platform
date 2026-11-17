// v2 Faz 6 (D111) Görev 6: sentetik risk tablosu üretici. Kurumun Excel dosyasının düzenini (sayfa adları, satır 1–4, GEOMEAN formülü,
// J kesir ölçeği, otomatik süzgeç) taklit eder; içerik tamamen sentetiktir (ad "Test Bilişim A.Ş." vb.; ölçüt/skor sayıları analizdeki
// örnek tablodan). Gerçek dosya repoya kopyalanmaz.
import ExcelJS from 'exceljs';

export interface SyntheticRiskRow {
  name: string | null;
  services?: string | null;
  /** C..H; null hücre boş. */
  criteria?: (number | null)[] | null;
  /** I önbellek değeri; verilmezse ölçüt tamsa GEOMEAN hesaplanır. */
  excelCriticality?: number | null;
  /** J (dosyada yazılan ham değer: kesir ölçeğinde 0,15). */
  j?: number | string | null;
  k?: string | null;
  team?: string | null;
}

export const SOURCE_HEADERS = [
  'Tedarikçi Adı', 'Tedarik Edilen Hizmetler', '1. Hizmetin İş Süreçlerine Etkisi', '2. Veri Hassasiyeti', '3. Süreklilik ve Bağımlılık Düzeyi',
  '4. Entegrasyon Derinliği', '5. Regülasyon Uyumu Gerekliliği', '6. Hizmet Tipi ve Süresi', 'Kritiklik Skoru', 'Risk Skoru', 'Aksiyon Planları', 'Ekipler',
];
export const SOURCE_GROUPS: [string, string][] = [
  ['A2:B2', 'Tedarikçiler'], ['C2:H2', 'BT Tedarikçi Kritikliği Skorları'], ['I2:J2', 'Tedarikçi Skorları'], ['K2', 'Aksiyon'], ['L2', 'Ekipler'],
];
export const SOURCE_NOTES = [
  'Açık Metin', 'Açık Metin', '1,3,5 Değerleri', '1,3,5 Değerleri', '1,3,5 Değerleri', '1,3,5 Değerleri', '1,3,5 Değerleri', '1,3,5 Değerleri',
  '1-5 arası', '0-100 arası (Tedarikçi Riski Değerlendirme Şablonu\'ndan gelen sonuç değeri)', 'Açık metin', null,
];

const geo = (c: number[]) => Math.exp(c.reduce((s, x) => s + Math.log(x), 0) / c.length);

export async function riskWorkbook(rows: SyntheticRiskRow[], opts: { period?: string; headers?: string[]; extraSheet?: boolean } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Risk Tablosu');
  ws.getCell('A1').value = 'Dönem:';
  ws.getCell('B1').value = opts.period ?? '2026-1';
  for (const [range, text] of SOURCE_GROUPS) {
    if (range.includes(':')) ws.mergeCells(range);
    ws.getCell(range.split(':')[0]!).value = text;
  }
  (opts.headers ?? SOURCE_HEADERS).forEach((h, i) => { ws.getRow(3).getCell(i + 1).value = h; });
  SOURCE_NOTES.forEach((n, i) => { if (n) ws.getRow(4).getCell(i + 1).value = n; });
  rows.forEach((r, idx) => {
    const n = 5 + idx;
    const x = ws.getRow(n);
    x.getCell(1).value = r.name;
    x.getCell(2).value = r.services ?? null;
    const c = r.criteria ?? [];
    for (let i = 0; i < 6; i++) x.getCell(3 + i).value = c[i] ?? null;
    const full = c.length === 6 && c.every((v) => typeof v === 'number');
    if (full || r.excelCriticality != null) {
      x.getCell(9).value = { formula: `GEOMEAN(C${n}:H${n})`, result: r.excelCriticality ?? geo(c as number[]) };
    }
    x.getCell(9).numFmt = '0.00';
    x.getCell(10).value = r.j ?? null;
    x.getCell(11).value = r.k ?? null;
    x.getCell(12).value = r.team ?? null;
  });
  ws.autoFilter = `A4:L${4 + rows.length}`;
  const g = wb.addWorksheet('Risk Grafiği');
  g.getCell('C3').value = 'Risk Grafiği';
  if (opts.extraSheet !== false) {
    const t = wb.addWorksheet('Tanimlar', { state: 'hidden' });
    t.getCell('A2').value = '2026-1';
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Örnek tablo (analiz §3.4; Excel satır no ile): ölçütler, I önbelleği, J kesir, beklenen sütun ve seviye. */
export const SAMPLE_ROWS = [
  { excelRow: 5, criteria: [3, 5, 1, 3, 5, 5], i: 3.224968079727227, j: 0.15, column: 3, level: 2 },
  { excelRow: 7, criteria: [1, 3, 3, 3, 1, 3], i: 2.080083823051904, j: 0.18, column: 2, level: 1 },
  { excelRow: 9, criteria: [5, 3, 5, 5, 3, 5], i: 4.2171633265087465, j: 0.24, column: 4, level: 3 },
  { excelRow: 16, criteria: [3, 3, 3, 5, 3, 3], i: 3.266600666361009, j: 0.62, column: 3, level: 3 },
  { excelRow: 17, criteria: [5, 5, 5, 5, 5, 5], i: 5, j: 0.2, column: 5, level: 3 },
  { excelRow: 19, criteria: [1, 3, 1, 1, 1, 3], i: 1.4422495703074083, j: 0.24, column: 1, level: 1 },
  { excelRow: 26, criteria: [5, 5, 3, 3, 5, 3], i: 3.8729833462074166, j: 0.2, column: 4, level: 2 },
  { excelRow: 54, criteria: [5, 5, 5, 3, 5, 5], i: 4.591929510842227, j: 0.48, column: 5, level: 4 },
  { excelRow: 56, criteria: [3, 3, 3, 3, 1, 3], i: 2.498049532966813, j: 0.08, column: 2, level: 1 },
  { excelRow: 100, criteria: [3, 1, 3, 3, 5, 3], i: 2.7200434229973993, j: 0.65, column: 3, level: 3 },
] as const;
