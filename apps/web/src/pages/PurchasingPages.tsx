import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SavedViews } from '../ui/SavedViews.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { useSession, hasRole } from '../lib/session.tsx';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import { roleLabel, supplierPickHint, supplierRecordNote, type SupplierOption } from '../lib/labels.ts';
import { Banner, Empty, ErrorState, Field, FilterChip, Loading, PageHeader, Tag, toneClass } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { UblFindings, ublTitle, type UblCheck } from '../ui/UblCheck.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { allocationMatched, REMOVED_ISSUE_CODES } from '../../../../packages/domain/src/invoiceMatch.ts';
import { DepartmentFilter, DepartmentName, useDepartmentParam, withDepartment } from '../ui/Departments.tsx';

// UX10 Fatura. v2 (D93/D95): fatura onayı, istisna onayı, tolerans ve üçlü eşleştirme kaldırma listesinde; fatura girişi (elle ve
// e-Fatura XML), UBL-TR denetimi, sözleşmeye tahsis (eşleştirme) ve sözleşme limiti kalır. Ödeme ERP'de yürür.
const num = (s: string) => Number(s).toLocaleString('tr-TR', { maximumFractionDigits: 6 });
// --- Faturalar ------------------------------------------------------------------------------------

const KIND = { INVOICE: 'Fatura', CREDIT_NOTE: 'İade / alacak', ADVANCE: 'Avans' } as const;
type Label = { text: string; tone: 'human' | 'ok' | 'warn' | 'danger' | 'info' | 'neutral'; icon: string };
/** Eşleşme durumu (v2): sözleşmeye (ya da eski sipariş bağına) tam tahsis edilmiş mi; hukuken iptal/ret ayrı. */
const MATCH: Record<'ESLESTI' | 'ESLESMEDI' | 'IPTAL', Label> = {
  ESLESTI: { text: 'Eşleşti', tone: 'ok', icon: 'check' }, ESLESMEDI: { text: 'Eşleşmedi', tone: 'warn', icon: 'alert' },
  IPTAL: { text: 'Hukuken iptal/ret', tone: 'danger', icon: 'x' },
};
/** v1'de verilmiş kararlar salt okunur geçmiş olarak görünür (W-18-11). */
const PAST_DECISION: Record<string, string> = { APPROVAL: 'Onaylandı (v1 kaydı)', REJECTION: 'Reddedildi (v1 kaydı)', EXCEPTION_APPROVAL: 'İstisna onaylandı (v1 kaydı)' };
/** Kaldırılan üçlü eşleştirme (sipariş/kabul), tolerans ve istisna bulguları gösterilmez; vergi, tahsis, tedarikçi ve limit bulguları kalır.
 *  Liste alan adı paketinde tektir (API görevleri de aynı listeyle süzer). */
const REMOVED_ISSUES = new Set(REMOVED_ISSUE_CODES);
const ERP: Record<string, string> = { PENDING: 'ERP: aktarım bekliyor', UNKNOWN: 'ERP: belirsiz (zaman aşımı) — sorgulanacak', CONFIRMED: 'ERP: aktarıldı', FAILED: 'ERP: hata', NOT_CONFIGURED: 'ERP bağlantısı yapılandırılmadı' };
const MATCH_FILTERS = [['', 'Tümü'], ['ESLESMEDI', 'Eşleşmedi'], ['ESLESTI', 'Eşleşti'], ['IPTAL', 'Hukuken iptal/ret']] as const;

interface InvoiceRow { id: string; kind: keyof typeof KIND; invoiceNo: string; issueDate: string; currency: string; supplierName: string; supplierStatus: string; supplierIdentityVerified: boolean;
  netAmount: string; legalStatus: string; paymentStatus: string; decision: string | null; erpStatus: string | null; duplicateCount: number; matched: boolean; departmentId: string | null; departmentName: string | null }
const matchOf = (x: InvoiceRow) => (x.legalStatus !== 'RECEIVED' ? 'IPTAL' : x.matched ? 'ESLESTI' : 'ESLESMEDI');

export function InvoicesPage() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [dep, setDep] = useDepartmentParam();
  const r = useResource<{ items: InvoiceRow[] }>(withDepartment('/api/v1/invoices', dep));
  const [creating, setCreating] = useState(false);
  // Süzgeç ve kolonlar URL'de (kayıtlı görünüm ve paylaşılabilir bağlantı); yetki ve kapsam sunucuda.
  const [params, setParams] = useSearchParams();
  // Eski (v1 onay durumu) kayıtlı görünüm değerleri tanınmaz; "Tümü" sayılır.
  const durum = MATCH_FILTERS.some(([k]) => k === params.get('durum')) ? params.get('durum')! : '';
  const para = params.get('para') ?? '';
  const hidden = new Set((params.get('gizle') ?? '').split(',').filter(Boolean));
  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p, { replace: true }); };
  const toggleCol = (c: string) => { const n = new Set(hidden); n.has(c) ? n.delete(c) : n.add(c); setParam('gizle', [...n].sort().join(',')); };
  const all = r.data?.items ?? [];
  const matches = (x: InvoiceRow, k: string) => !k || matchOf(x) === k;
  const items = all.filter((x) => matches(x, durum) && (!para || x.currency === para));
  const currencies = [...new Set(all.map((x) => x.currency))].sort();
  const COLS = [['tedarikci', 'Tedarikçi'], ['erp', 'ERP / ödeme'], ['tarih', 'Tarih']] as const;
  const show = (c: string) => !hidden.has(c);
  return (
    <div className="page">
      <PageHeader title="Faturalar" actions={<div className="flex flex-wrap gap-2">
        {hasRole(me, 'PROCUREMENT', 'AUDITOR') && <Button variant="outline" asChild><Link to="/yonetim/entegrasyonlar">ERP mutabakatı</Link></Button>}
        {/* D95 c: e-Fatura XML ve elle fatura girişi Satınalma'da; departman kullanıcısı faturayı yalnız okur. */}
        {hasRole(me, 'PROCUREMENT') && <Button variant="outline" asChild><Link to="/faturalar/yukle"><Icon name="upload" />Fatura yükle</Link></Button>}
        {hasRole(me, 'PROCUREMENT') && <Button onClick={() => setCreating(true)}><Icon name="receipt" />Fatura gir</Button>}</div>}>
        Faturanın sözleşmeyle eşleştirilmesi ve sözleşme limiti. Hukuki e-belge durumu, ERP aktarımı ve ödeme ayrı durumlardır; ödeme bu sistemden yürütülmez.
      </PageHeader>
      {creating && <InvoiceForm onCancel={() => setCreating(false)} onCreated={(id) => navigate(`/faturalar/${id}`)} />}
      <SavedViews page="invoices" />
      <div className="mb-3"><DepartmentFilter value={dep} onChange={setDep} /></div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Eşleşme süzgeci">
          {MATCH_FILTERS.map(([k, l]) =>
            <FilterChip key={k} pressed={durum === k} count={all.filter((x) => matches(x, k)).length} onClick={() => setParam('durum', k)}>{l}</FilterChip>)}
        </div>
        {currencies.length > 1 && <label className="flex items-center gap-2 text-sm">Para birimi
          <select className="input h-8 w-24" value={para} onChange={(e) => setParam('para', e.target.value)}><option value="">Tümü</option>{currencies.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>}
        <fieldset className="flex flex-wrap items-center gap-3 text-sm"><legend className="sr-only">Kolonlar</legend><span className="text-ink-subtle">Kolonlar:</span>
          {COLS.map(([k, l]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" className="accent-[var(--ink)]" aria-label={`${l} kolonunu göster`} checked={show(k)} onChange={() => toggleCol(k)} />{l}</label>)}
        </fieldset>
      </div>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="receipt" title={all.length || dep ? 'Süzgece uyan fatura yok' : 'Fatura yok'}>{all.length || dep ? 'Süzgeci değiştirin veya “Tümü”nü seçin.' : 'e-Fatura girişi veya elle giriş sonrası burada görünür.'}</Empty></div>
      ) : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Fatura no</TableHead>{show('tedarikci') && <TableHead>Tedarikçi</TableHead>}<TableHead>Departman</TableHead><TableHead className="text-right">Net</TableHead>
            <TableHead>Eşleşme</TableHead>{show('erp') && <TableHead className="max-[900px]:hidden">ERP / ödeme</TableHead>}{show('tarih') && <TableHead>Tarih</TableHead>}</TableRow></TableHeader>
          <TableBody>{items.map((x) => (
            <TableRow key={x.id}>
              <TableCell className="whitespace-nowrap"><Link className="font-semibold text-ink no-underline hover:underline" to={`/faturalar/${x.id}`}>{x.invoiceNo}</Link>
                <span className="block text-sm text-ink-subtle">{KIND[x.kind]}{x.duplicateCount > 0 ? ` · ${x.duplicateCount} tekrar geliş` : ''}</span></TableCell>
              {show('tedarikci') && <TableCell>{x.supplierName}{supplierRecordNote(x.supplierStatus, x.supplierIdentityVerified) && <span className="block text-sm text-warn">{supplierRecordNote(x.supplierStatus, x.supplierIdentityVerified)}</span>}</TableCell>}
              <TableCell><DepartmentName name={x.departmentName} /></TableCell>
              <TableCell className="whitespace-nowrap text-right">{fmtMoney(x.netAmount, x.currency)}</TableCell>
              <TableCell><Tag label={MATCH[matchOf(x)]} />{x.decision && <span className="mt-1 block text-sm text-ink-subtle">{PAST_DECISION[x.decision]}</span>}</TableCell>
              {show('erp') && <TableCell className="text-sm text-ink-muted max-[900px]:hidden">{x.erpStatus ? ERP[x.erpStatus] : '—'}{x.paymentStatus === 'PAID' ? ' · ödendi (ERP)' : ''}</TableCell>}
              {show('tarih') && <TableCell className="whitespace-nowrap text-sm text-ink-subtle">{fmtDate(x.issueDate)}</TableCell>}
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
    </div>
  );
}

function InvoiceForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const { me } = useSession();
  const sup = useResource<{ items: SupplierOption[] }>('/api/v1/supplier-options');
  const [f, setF] = useState({ companyId: me?.companies[0]?.id ?? '', supplierId: '', kind: 'INVOICE', invoiceNo: '', ettn: '', issueDate: '', currency: 'TRY', originalInvoiceId: '' });
  const [lines, setLines] = useState([{ description: '', quantity: '', unit: '', unitPrice: '', taxRate: '20' }]);
  const [declared, setDeclared] = useState({ declaredTaxTotal: '', declaredWithholding: '', declaredPayable: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const net = (l: { quantity: string; unitPrice: string }) => (Number(l.quantity) * Number(l.unitPrice) || 0).toFixed(2);
  return (
    <form className="panel mb-5" onSubmit={(e) => { e.preventDefault(); setBusy(true); setErr(null);
      void api<{ id: string; duplicate: boolean }>('/api/v1/invoices', { method: 'POST', json: { ...f, ettn: f.ettn || null, originalInvoiceId: f.kind === 'CREDIT_NOTE' ? f.originalInvoiceId || null : null,
        declaredTaxTotal: declared.declaredTaxTotal || null, declaredWithholding: declared.declaredWithholding || null, declaredPayable: declared.declaredPayable || null,
        lines: lines.map((l) => ({ ...l, netAmount: net(l) })) } }).then((r) => onCreated(r.data.id), (x: ApiError) => setErr(x.message)).finally(() => setBusy(false)); }}>
      <div className="panel-head"><h2>Fatura gir</h2><span className="text-sm text-ink-subtle">Aynı tedarikçi için aynı ETTN veya fatura no ikinci kayıt açmaz.</span></div>
      <div className="panel-body grid gap-3">
        <div className="grid grid-cols-4 gap-x-3 max-[900px]:grid-cols-2">
          <Field label="Şirket">{(p) => <select className="input" {...p} value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>{me?.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
          <Field label="Tedarikçi" hint={supplierPickHint(sup.data?.items.find((s) => s.id === f.supplierId))}>{(p) => <select className="input" required {...p} value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="">Seçin</option>{sup.data?.items.map((s) => <option key={s.id} value={s.id}>{s.label ?? s.legalName}</option>)}</select>}</Field>
          <Field label="Tür">{(p) => <select className="input" {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
          <Field label="Fatura no">{(p) => <input className="input" required {...p} value={f.invoiceNo} onChange={(e) => setF({ ...f, invoiceNo: e.target.value })} />}</Field>
          <Field label="ETTN (varsa)">{(p) => <input className="input mono" {...p} value={f.ettn} onChange={(e) => setF({ ...f, ettn: e.target.value })} />}</Field>
          <Field label="Fatura tarihi">{(p) => <input className="input" type="date" required {...p} value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} />}</Field>
          <Field label="Para birimi">{(p) => <input className="input" maxLength={3} {...p} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />}</Field>
          {f.kind === 'CREDIT_NOTE' && <Field label="Özgün fatura kimliği">{(p) => <input className="input mono" {...p} value={f.originalInvoiceId} onChange={(e) => setF({ ...f, originalInvoiceId: e.target.value })} />}</Field>}
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_100px_90px_130px_80px_120px_auto] items-start gap-3 max-[1200px]:grid-cols-3">
            <div className="max-[1200px]:col-span-full"><Field label={`Satır ${i + 1}`}>{(p) => <input className="input" required {...p} value={l.description} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />}</Field></div>
            <Field label="Miktar">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, quantity: e.target.value.replace(',', '.') } : x))} />}</Field>
            <Field label="Birim">{(p) => <input className="input" required {...p} value={l.unit} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))} />}</Field>
            <Field label="Birim fiyat">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={l.unitPrice} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unitPrice: e.target.value.replace(',', '.') } : x))} />}</Field>
            <Field label="KDV %">{(p) => <input className="input tabular text-right" required inputMode="decimal" {...p} value={l.taxRate} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, taxRate: e.target.value.replace(',', '.') } : x))} />}</Field>
            <div className="field"><span className="text-sm font-semibold">Net</span><span className="tabular min-h-[34px] py-1.5 text-right">{fmtMoney(net(l), f.currency)}</span></div>
            <Button type="button" variant="ghost" size="sm" className="mt-6" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Satır ${i + 1} sil`}><Icon name="close" /></Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setLines([...lines, { description: '', quantity: '', unit: '', unitPrice: '', taxRate: '20' }])}>Satır ekle</Button>
        </div>
        <div className="grid grid-cols-3 items-start gap-x-3 max-[900px]:grid-cols-1">
          <Field label="Belgedeki KDV toplamı" hint="Belgede yazanı girin; satırlarla karşılaştırılır.">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={declared.declaredTaxTotal} onChange={(e) => setDeclared({ ...declared, declaredTaxTotal: e.target.value.replace(',', '.') })} />}</Field>
          <Field label="Tevkifat (varsa)">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={declared.declaredWithholding} onChange={(e) => setDeclared({ ...declared, declaredWithholding: e.target.value.replace(',', '.') })} />}</Field>
          <Field label="Belgedeki ödenecek tutar">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={declared.declaredPayable} onChange={(e) => setDeclared({ ...declared, declaredPayable: e.target.value.replace(',', '.') })} />}</Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>Faturayı kaydet</Button><Button type="button" variant="ghost" onClick={onCancel}>Vazgeç</Button>
        </div>
        {err && <Banner tone="danger" title={err} />}
      </div>
    </form>
  );
}

/** GİB vergi türü kodları (yalnız görünüm). */
const TAX_CODE: Record<string, string> = { '4080': 'ÖİV', '4081': 'ÖİV (5035)', '0071': 'ÖTV (I sayılı liste)', '0073': 'ÖTV (III sayılı liste)', '0074': 'ÖTV (IV sayılı liste)', '0075': 'ÖTV (III sayılı liste)', '0076': 'ÖTV (II sayılı liste)', '0077': 'ÖTV (II sayılı liste)', '1047': 'Damga vergisi', '9021': 'Konaklama vergisi' };

interface InvDetail {
  invoice: { id: string; kind: keyof typeof KIND; invoiceNo: string; ettn: string | null; issueDate: string; currency: string; companyId: string; supplierId: string; supplierName: string; supplierStatus: string; supplierIdentityVerified: boolean; supplierRootId: string;
    legalStatus: string; paymentStatus: string; documentVersionId: string | null; declaredTaxTotal: string | null; declaredWithholding: string | null; declaredPayable: string | null; originalInvoiceId: string | null; advanceInvoiceId: string | null; advanceOffset: string; createdByMe: boolean; createdBy: string; createdAt: string;
    departmentId: string | null; departmentName: string | null };
  lines: { lineNo: number; description: string; quantity: string; unit: string; unitPrice: string; netAmount: string; taxRate: string; taxAmount: string | null;
    otherTax: string | null; otherTaxes: { code: string | null; name: string | null; rate: string | null; amount: string }[] | null }[];
  allocations: { lineNo: number; poLineId: string | null; contractVersionId: string | null; quantity: string; amount: string; poId: string | null; poCode: string | null; poLineDescription: string | null; contractTitle: string | null }[];
  decisions: { kind: string; reason: string | null; decidedAt: string; decidedBy: string }[];
  intake: { source: string; duplicate: boolean; receivedAt: string }[];
  erp: null | { status: string; externalId: string | null; attempts: number; lastError: string | null; updatedAt: string };
  check: { issues: { code: string; severity: string; message: string; ownerRole: string; lineNo?: number }[]; canApprove: boolean; needsException: boolean; netAmount: string; payable: string; taxTotal: string; otherTaxTotal: string; grossAmount: string };
  contracts: { contractVersionId: string; title: string; currency: string; ceiling: string | null; netConsumption: string; openCommitment: string }[];
  status: string; exceptionCurrent: boolean | null; checkFingerprint: string;
  can: { manage: boolean; approve: boolean; approveException: boolean };
  ublCheck: UblCheck | null;
}
const SEV = { BLOCK: { text: 'Engel', tone: 'danger', icon: 'x' }, EXCEPTION: { text: 'İstisna', tone: 'warn', icon: 'alert' }, REVIEW: { text: 'İnceleme', tone: 'info', icon: 'help' } } as const;

export function InvoicePage() {
  const { id } = useParams();
  const r = useResource<InvDetail>(`/api/v1/invoices/${id}`);
  const [editing, setEditing] = useState(false);
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  const decided = d.decisions.some((x) => x.kind === 'APPROVAL' || x.kind === 'REJECTION');
  const issues = d.check.issues.filter((x) => !REMOVED_ISSUES.has(x.code));
  const issuesFor = (lineNo?: number) => issues.filter((x) => x.lineNo === lineNo);
  // I5: eksik, fazla ya da yanlış tedarikçi/şirkete tahsis eşleşme sayılmaz (liste ve iOS ile aynı kural).
  const match = d.invoice.legalStatus !== 'RECEIVED' ? 'IPTAL' : d.allocations.length && allocationMatched(d.lines.length > 0, d.check.issues) ? 'ESLESTI' : 'ESLESMEDI';
  const supplierNote = supplierRecordNote(d.invoice.supplierStatus, d.invoice.supplierIdentityVerified);
  return (
    <div className="page">
      <p className="text-sm text-ink-subtle"><Link to="/faturalar" className="text-ink-subtle">Faturalar</Link> / {d.invoice.invoiceNo}</p>
      <div className="mb-4 mt-1 flex flex-wrap items-start gap-3">
        <h1 className="min-w-0 flex-1">{KIND[d.invoice.kind]} {d.invoice.invoiceNo} · {d.invoice.supplierName}</h1>
        <Tag label={MATCH[match]} />
      </div>
      <div className="mb-5 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-muted">
        {supplierNote && <span className="text-warn">Tedarikçi: {supplierNote}</span>}
        <Link to={`/tedarikciler/${d.invoice.supplierId}`}>Tedarikçi kaydını aç</Link>
        <span>Departman: <DepartmentName name={d.invoice.departmentName} /></span>
        <span>Tarih {fmtDate(d.invoice.issueDate)}</span>{d.invoice.ettn && <span className="mono">ETTN {d.invoice.ettn}</span>}
        <span>Hukuki durum: {d.invoice.legalStatus === 'RECEIVED' ? 'alındı' : 'iptal/ret'}</span>
        <span>{d.erp ? ERP[d.erp.status] : 'ERP: aktarım kaydı yok'}</span><span>Ödeme: {d.invoice.paymentStatus === 'PAID' ? 'ödendi (ERP teyidi)' : 'ödenmedi'}</span>
        {d.intake.filter((x) => x.duplicate).length > 0 && <span className="text-warn">Bu fatura {d.intake.filter((x) => x.duplicate).length} kez tekrar geldi; yeni kayıt açılmadı.</span>}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_380px] gap-6 max-[1100px]:grid-cols-1">
        <div className="grid content-start gap-5">
          <section className="panel">
            <div className="panel-head"><h2>Satırlar ve tahsis</h2>{d.can.manage && !decided && !editing && <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEditing(true)}><Icon name="pen" />Tahsisi düzenle</Button>}</div>
            <div className="panel-body grid gap-4">
              {d.lines.map((l) => (
                <div key={l.lineNo} className="grid gap-1.5 border-b border-[#ebe6da] pb-3 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap justify-between gap-2"><span className="font-semibold">{l.lineNo}. {l.description}</span>
                    <span className="tabular">{num(l.quantity)} {l.unit} × {fmtMoney(l.unitPrice, d.invoice.currency)} = <span className="font-semibold">{fmtMoney(l.netAmount, d.invoice.currency)}</span>
                      <span className="block text-right text-sm text-ink-subtle">KDV %{num(l.taxRate)}{l.taxAmount ? ` · belgede ${fmtMoney(l.taxAmount, d.invoice.currency)}` : ''}</span>
                      {l.otherTaxes?.length ? l.otherTaxes.map((t, i) => (
                        <span key={i} className="block text-right text-sm text-ink-subtle">{t.name || TAX_CODE[t.code ?? ''] || t.code || 'KDV dışı vergi'} {t.rate ? `%${num(t.rate)}` : '(oransız, beyan)'} · {fmtMoney(t.amount, d.invoice.currency)}</span>))
                        : Number(l.otherTax) > 0 && <span className="block text-right text-sm text-ink-subtle">KDV dışı vergiler (kalem ayrımı yok) · {fmtMoney(l.otherTax, d.invoice.currency)}</span>}</span></div>
                  {d.allocations.filter((x) => x.lineNo === l.lineNo).map((x, i) => (
                    <p key={i} className="flex flex-wrap gap-x-2 text-sm text-ink-muted"><Icon name="arrow" size={14} className="mt-0.5" />
                      {/* v2 (D93): siparişler kalktı; eski sipariş bağı numarasıyla metin olarak görünür (bağlantı yok). */}
                      {x.poLineId ? <>Sipariş {x.poCode ?? '(erişiminiz dışında)'}{x.poLineDescription ? ` · ${x.poLineDescription}` : ''}{x.contractTitle ? ` · Sözleşme: ${x.contractTitle}` : ''}</> : x.contractTitle ? <>Sözleşme: {x.contractTitle}</> : 'Bağsız'}
                      <span className="tabular">· {num(x.quantity)} {l.unit} · {fmtMoney(x.amount, d.invoice.currency)}</span></p>
                  ))}
                  {issuesFor(l.lineNo).map((x, i) => <Issue key={i} x={x} />)}
                </div>
              ))}
              {issuesFor(undefined).map((x, i) => <Issue key={i} x={x} />)}
              {editing && <AllocationEditor d={d} onDone={() => { setEditing(false); void r.reload(); }} />}
            </div>
          </section>
        </div>
        <aside className="grid content-start gap-5">
          <section className="panel">
            <div className="panel-head"><h2>Tutar</h2></div>
            <div className="panel-body"><dl className="facts">
              <dt>Net</dt><dd className="tabular font-semibold">{fmtMoney(d.check.netAmount, d.invoice.currency)}</dd>
              {Number(d.check.otherTaxTotal) > 0 && <><dt>Diğer vergiler (ÖTV/ÖİV)</dt><dd className="tabular">{fmtMoney(d.check.otherTaxTotal, d.invoice.currency)}</dd></>}
              <dt>KDV</dt><dd className="tabular">{fmtMoney(d.check.taxTotal, d.invoice.currency)}{d.invoice.declaredTaxTotal && <span className="block text-sm text-ink-subtle">belgede {fmtMoney(d.invoice.declaredTaxTotal, d.invoice.currency)}</span>}</dd>
              {d.invoice.declaredWithholding && Number(d.invoice.declaredWithholding) > 0 && <><dt>Tevkifat</dt><dd className="tabular">− {fmtMoney(d.invoice.declaredWithholding, d.invoice.currency)}</dd></>}
              <dt>Ödenecek (vergi dahil, tevkifat sonrası)</dt><dd className="tabular">{fmtMoney(d.check.grossAmount, d.invoice.currency)}{d.invoice.declaredPayable && <span className="block text-sm text-ink-subtle">belgede ödenecek {fmtMoney(d.invoice.declaredPayable, d.invoice.currency)}</span>}</dd>
              {Number(d.invoice.advanceOffset) > 0 && <><dt>Avans mahsubu</dt><dd className="tabular">− {fmtMoney(d.invoice.advanceOffset, d.invoice.currency)}</dd></>}
              <dt>Net (avans mahsubu sonrası)</dt><dd className="tabular">{fmtMoney(d.check.payable, d.invoice.currency)}</dd>
            </dl>
            <p className="mt-2 text-sm text-ink-subtle">KDV satırlardan yeniden hesaplanır; belgede yazan tutar ancak bu hesapla tutarsa kabul edilir.{d.invoice.documentVersionId && <> <Link to={`/belgeler/${d.invoice.documentVersionId}`}>Kaynak e-Fatura</Link></>}</p></div>
          </section>
          {d.ublCheck && (
            <section className="panel" aria-labelledby="ubl-h">
              <div className="panel-head"><h2 id="ubl-h">{ublTitle(d.ublCheck)}</h2></div>
              <div className="panel-body"><UblFindings c={d.ublCheck} /></div>
            </section>
          )}
          {d.contracts.filter((c) => c.ceiling).map((c) => (
            <section key={c.contractVersionId} className="panel">
              <div className="panel-head"><h2>Limit · {c.title}</h2></div>
              <div className="panel-body"><dl className="facts">
                <dt>Tavan</dt><dd className="tabular">{fmtMoney(c.ceiling, c.currency)}</dd><dt>Net tüketim</dt><dd className="tabular">{fmtMoney(c.netConsumption, c.currency)}</dd>
                <dt>Açık taahhüt</dt><dd className="tabular">{fmtMoney(c.openCommitment, c.currency)}</dd>
                <dt>Kullanılabilir</dt><dd className="tabular font-semibold">{fmtMoney((Number(c.ceiling) - Number(c.netConsumption) - Number(c.openCommitment)).toFixed(2), c.currency)}</dd>
              </dl><p className="mt-2 text-sm text-ink-subtle">Bu fatura hariç. Aşım yalnız bilgidir; ödeme kararı ERP'dedir.</p></div>
            </section>
          ))}
          {/* v2 (D93): fatura onayı, istisna onayı ve ret kaldırma listesinde. v1'de verilmiş kararlar salt okunur geçmiş olarak kalır. */}
          {(d.decisions.length > 0 || d.erp?.lastError) && <section className="panel">
            <div className="panel-head"><h2>Karar geçmişi</h2></div>
            <div className="panel-body grid gap-3">
              {d.decisions.map((x, i) => <p key={i}><Tag label={{ text: `${PAST_DECISION[x.kind] ?? 'Karar (v1 kaydı)'} · ${x.decidedBy}`, tone: x.kind === 'REJECTION' ? 'neutral' : 'human', icon: x.kind === 'REJECTION' ? 'x' : 'stamp' }} />
                <span className="block text-sm text-ink-subtle">{fmtDateTime(x.decidedAt)}{x.reason ? ` · ${x.reason}` : ''}</span></p>)}
              {d.decisions.length > 0 && <p className="text-sm text-ink-subtle">Fatura onayı artık bu sistemde verilmez; ödeme ERP'de yürür.</p>}
              {d.erp?.lastError && <p className="text-sm text-ink-muted">{d.erp.lastError}</p>}
            </div>
          </section>}
        </aside>
      </div>
    </div>
  );
}

function Issue({ x }: { x: InvDetail['check']['issues'][number] }) {
  const s = SEV[x.severity as keyof typeof SEV];
  return (
    <div className={cn('flex flex-wrap items-start gap-2 rounded-md px-3 py-2 text-sm', x.severity === 'BLOCK' ? 'bg-danger-soft' : x.severity === 'EXCEPTION' ? 'bg-warn-soft' : 'bg-info-soft')}>
      <span className={cn('inline-flex items-center gap-1 rounded-sm px-1.5 font-semibold', toneClass[s.tone])}><Icon name={s.icon} size={13} />{s.text}</span>
      <span className="min-w-0 flex-1">{x.message}</span>
      <span className="font-semibold">Çözen: {roleLabel[x.ownerRole] ?? x.ownerRole}</span>
    </div>
  );
}

/** Sözleşme seçeneği: yalnız faturanın şirketinden (D86/D87) ve tedarikçi köküne bağlı ya da tedarikçisi kayıtlı olmayan sözleşmeler (D84/D85). */
type ContractOption = { id: string; title: string; companyId: string; supplierRootIds: string[] };

/**
 * Tahsis (v2 eşleştirme): fatura satırı sözleşmeye bağlanır. Sipariş kalemine YENİ bağ kurmak kaldırma listesinde (D93). Eski sipariş
 * bağı kendi numarasıyla seçenek olarak kalır: aynen bırakılabilir, kaldırılabilir ("Bağı kaldır") ya da bir sözleşmeye yeniden
 * bağlanabilir (düzeltme dalgası I4: tedarikçi/şirket uyuşmazlığı taşıyan eski bağ aksi halde her kaydı 422 ile durduruyordu).
 */
function AllocationEditor({ d, onDone }: { d: InvDetail; onDone: () => void }) {
  const cons = useResource<{ items: ContractOption[]; truncated: boolean }>('/api/v1/contract-options');
  const [rows, setRows] = useState(d.allocations.length ? d.allocations.map((x) => ({ lineNo: x.lineNo, target: x.poLineId ? `po:${x.poLineId}` : x.contractVersionId ? `cv:${x.contractVersionId}` : '', quantity: x.quantity, amount: x.amount,
    legacy: x.poLineId ? `Sipariş ${x.poCode ?? '(erişiminiz dışında)'}${x.poLineDescription ? ` · ${x.poLineDescription}` : ''}` : null,
    legacyTarget: x.poLineId ? `po:${x.poLineId}` : null }))
    : d.lines.map((l) => ({ lineNo: l.lineNo, target: '', quantity: l.quantity, amount: l.netAmount, legacy: null as string | null, legacyTarget: null as string | null })));
  const [offset, setOffset] = useState(d.invoice.advanceOffset);
  const [advanceId, setAdvanceId] = useState(d.invoice.advanceInvoiceId ?? '');
  const [err, setErr] = useState<string | null>(null);
  const fits = (c: ContractOption) => c.companyId === d.invoice.companyId && (!c.supplierRootIds.length || c.supplierRootIds.includes(d.invoice.supplierRootId));
  const options = (cons.data?.items ?? []).filter(fits);
  // Kayıtlı sözleşme bağı listede yoksa (erişim dışı ya da uygun değil) yine seçenek olarak görünür; "Seçin" ile kaldırılabilir (D84).
  const current = [...new Map(d.allocations.filter((a) => !a.poLineId && a.contractVersionId && !options.some((c) => c.id === a.contractVersionId))
    .map((a) => [`cv:${a.contractVersionId}`, a.contractTitle ? `Sözleşme · ${a.contractTitle}` : 'Erişiminiz dışındaki sözleşme'])).entries()];
  return (
    <form className="grid gap-3 rounded-md border border-border bg-white p-3" onSubmit={(e) => { e.preventDefault(); setErr(null);
      void api(`/api/v1/invoices/${d.invoice.id}/allocations`, { method: 'PUT', json: { advanceOffset: offset || '0', advanceInvoiceId: advanceId || null,
        allocations: rows.filter((x) => x.target).map((x) => ({ lineNo: x.lineNo, poLineId: x.target.startsWith('po:') ? x.target.slice(3) : null, contractVersionId: x.target.startsWith('cv:') ? x.target.slice(3) : null, quantity: x.quantity, amount: x.amount })) } })
        .then(onDone, (x: ApiError) => setErr(x.message)); }}>
      <p className="text-sm text-ink-muted">Satırı sözleşmeye bağlayın. Tek satır birden çok sözleşmeye bölünebilir; tahsis toplamı satır tutarını aşamaz.</p>
      {!cons.loading && !options.length && <span className="text-sm text-ink-subtle">Bu şirkette bu tedarikçiye uygun sözleşme yok.</span>}
      {cons.data?.truncated && <span className="text-sm text-ink-subtle">Sözleşme sayısı liste sınırını aştı; aradığınız sözleşme burada görünmeyebilir.</span>}
      {d.check.issues.some((x) => x.code === 'SUPPLIER_MISMATCH' || x.code === 'COMPANY_MISMATCH') && <p className="text-sm text-warn">Kayıtlı bağ başka bir tedarikçiye veya şirkete ait. Hedefi “Seçin” ya da eski sipariş bağında “Bağı kaldır” yapıp kaydederek bağı kaldırın veya bir sözleşme seçin.</p>}
      {rows.map((x, i) => (
        <div key={i} className="grid grid-cols-[60px_minmax(0,1fr)_100px_130px_auto] items-start gap-2 max-[640px]:grid-cols-2">
          <span className="pt-2 text-sm font-semibold">Satır {x.lineNo}</span>
          {x.legacyTarget && x.target === x.legacyTarget ? <>
            <select className="input" aria-label={`Satır ${x.lineNo} hedef`} value={x.target} onChange={(e) => setRows(rows.map((y, j) => j === i ? { ...y, target: e.target.value } : y))}>
              <option value={x.legacyTarget}>{x.legacy} (eski sipariş bağı)</option>
              <option value="">Bağı kaldır</option>
              {options.map((c) => <option key={c.id} value={`cv:${c.id}`}>Sözleşme · {c.title}</option>)}
            </select>
            <span className="tabular pt-2 text-right text-sm">{num(x.quantity)}</span><span className="tabular pt-2 text-right text-sm">{fmtMoney(x.amount, d.invoice.currency)}</span><span />
          </> : <>
            <select className="input" aria-label={`Satır ${x.lineNo} hedef`} value={x.target} onChange={(e) => setRows(rows.map((y, j) => j === i ? { ...y, target: e.target.value } : y))}>
              <option value="">Seçin</option>
              {x.legacyTarget && <option value={x.legacyTarget}>{x.legacy} (eski sipariş bağı)</option>}
              {current.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              {options.map((c) => <option key={c.id} value={`cv:${c.id}`}>Sözleşme · {c.title}</option>)}
            </select>
            <input className="input tabular text-right" aria-label="Miktar" value={x.quantity} onChange={(e) => setRows(rows.map((y, j) => j === i ? { ...y, quantity: e.target.value.replace(',', '.') } : y))} />
            <input className="input tabular text-right" aria-label="Tutar" value={x.amount} onChange={(e) => setRows(rows.map((y, j) => j === i ? { ...y, amount: e.target.value.replace(',', '.') } : y))} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setRows([...rows.slice(0, i + 1), { ...x, target: '', quantity: '', amount: '', legacy: null, legacyTarget: null }, ...rows.slice(i + 1)])}>Böl</Button>
          </>}
        </div>
      ))}
      {d.invoice.kind === 'INVOICE' && <div className="grid grid-cols-2 gap-x-3 max-[640px]:grid-cols-1">
        <Field label="Avans faturası kimliği (mahsup)">{(p) => <input className="input mono" {...p} value={advanceId} onChange={(e) => setAdvanceId(e.target.value)} />}</Field>
        <Field label="Mahsup tutarı">{(p) => <input className="input tabular text-right" {...p} value={offset} onChange={(e) => setOffset(e.target.value.replace(',', '.'))} />}</Field></div>}
      <div className="flex gap-2"><Button type="submit">Tahsisi kaydet ve kontrol et</Button><Button type="button" variant="outline" onClick={onDone}>Vazgeç</Button></div>
      {err && <Banner tone="danger" title={err} />}
    </form>
  );
}
