import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { Banner, Field, PageHeader } from '../ui/kit.tsx';
import { Button } from '@/components/ui/button';
import { Icon } from '../ui/icons.tsx';
import { UblFindings, ublTitle, type UblCheck } from '../ui/UblCheck.tsx';

interface Result {
  documentVersionId: string; duplicate: boolean; basicCheckStatus: string; basicCheckReason: string | null; avScanStatus: string;
  processing: { stage: string; message: string };
  invoice?: null | { created: boolean; invoiceId: string | null; duplicate: boolean; reason: string | null };
  ublCheck?: UblCheck;
  supplier: null | { outcome: string; supplierId: string | null; message: string; nameMismatch: boolean; bankChangeRequestId: string | null; suggestions: { id: string; legalName: string }[] };
}

/**
 * Belge yükleme. v2 (D93): menüdeki "Belge girişi" kalktı; Sözleşmeler > "Sözleşme ekle" ve Faturalar > "Fatura yükle" bu ekranı
 * türü önceden seçili açar. Teklif ve diğer türler de yüklenebilir (K-05), bu yüzden tür seçimi görünür kalır.
 */
export function IntakePage({ kind: initialKind = 'INVOICE', title = 'Belge girişi', back }: { kind?: 'INVOICE' | 'CONTRACT'; title?: string; back?: { to: string; label: string } } = {}) {
  const { me } = useSession();
  const [company, setCompany] = useState(me?.companies[0]?.id ?? '');
  const [kind, setKind] = useState<string>(initialKind);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const inFlight = useRef(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.set('companyId', company); fd.set('kind', kind); fd.set('title', file.name); fd.set('file', file);
      setResult((await api<Result>('/api/v1/documents', { method: 'POST', body: fd })).data);
    } catch (err) { setError(err as ApiError); } finally { setBusy(false); inFlight.current = false; }
  }

  const backLink = back && <Button variant="outline" asChild><Link to={back.to}>{back.label}</Link></Button>;
  if (!me?.companies.length) return <div className="page"><PageHeader title={title} actions={backLink} /><Banner tone="neutral" icon="lock" title="Belge yükleyebileceğiniz şirket yok">Şirket kapsamı tanımlı değil.</Banner></div>;
  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <PageHeader title={title} actions={backLink}>e-Fatura XML önce kural ile okunur. PDF/görüntü için OCR sağlayıcısı bağlı değilse alanlar elle girilir; sahte çıkarım yapılmaz.</PageHeader>
      <form className="panel panel-body" onSubmit={submit}>
        <Field label="Şirket">{(p) => <select className="input" {...p} value={company} onChange={(e) => setCompany(e.target.value)}>{me.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
        <Field label="Belge türü">{(p) => <select className="input" {...p} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="INVOICE">Fatura</option><option value="CONTRACT">Sözleşme</option><option value="QUOTE">Teklif</option><option value="OTHER">Diğer</option></select>}</Field>
        <Field label="Dosya" hint="PDF, PNG, JPEG veya XML · en fazla 25 MB. Aynı dosya tekrar yüklenirse yeni kayıt açılmaz.">
          {(p) => (
            <div className="flex flex-wrap items-center gap-3">
              <input className="peer sr-only" type="file" accept=".pdf,.png,.jpg,.jpeg,.xml" {...p} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <label htmlFor={p.id} className="btn cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus"><Icon name="file" />Dosya seç</label>
              <span className={file ? 'font-semibold text-ink' : 'text-ink-subtle'}>{file ? `${file.name} · ${(file.size / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 0 })} KB` : 'Dosya seçilmedi'}</span>
            </div>
          )}
        </Field>
        <Button type="submit" disabled={!file || busy}><Icon name="upload" />{busy ? 'Yükleniyor…' : 'Yükle'}</Button>
      </form>
      <div style={{ marginTop: 16 }} aria-live="polite">
        {error && <Banner tone="danger" title={error.message} />}
        {result && <ResultView r={result} />}
      </div>
    </div>
  );
}

function ResultView({ r }: { r: Result }) {
  const tone = r.basicCheckStatus === 'QUARANTINED' ? 'danger' : r.duplicate ? 'neutral' : 'info';
  return (
    <>
      <Banner tone={tone} title={r.processing.message} action={<Link className="btn btn-sm" to={`/belgeler/${r.documentVersionId}`}>Belgeyi aç</Link>}>
        {r.basicCheckReason ?? (r.avScanStatus === 'NOT_AVAILABLE' ? 'Yerleşik dosya kontrolleri geçti. Antivirüs taraması bu ortamda bağlı değil.' : null)}
      </Banner>
      {r.supplier && (
        <Banner tone={['SELLER_IS_OWN_COMPANY', 'IDENTITY_REVIEW_REQUIRED', 'MATCHED_RESTRICTED'].includes(r.supplier.outcome) ? 'warn' : 'info'} title={r.supplier.message}
          action={r.supplier.supplierId ? <Link className="btn btn-sm" to={`/tedarikciler/${r.supplier.supplierId}`}>Tedarikçiyi aç</Link> : undefined}>
          {r.supplier.nameMismatch && 'Belgedeki ünvan kayıtlı ünvandan farklı; ana veri incelemesi açıldı. '}
          {r.supplier.bankChangeRequestId && 'Belgede kayıtlı olmayan IBAN okundu; banka bilgisi değiştirilmedi, doğrulama görevi açıldı. '}
          {r.supplier.suggestions.length > 0 && `Benzer isimli kayıtlar (yalnız öneri): ${r.supplier.suggestions.map((s) => s.legalName).join(', ')}.`}
        </Banner>
      )}
      {r.invoice && (r.invoice.invoiceId ? (
        <Banner tone="info" icon="receipt" title={r.invoice.duplicate ? 'Bu fatura daha önce alınmıştı; yeni kayıt açılmadı, tekrar izi eklendi.' : 'Fatura kaydı e-Fatura satırlarından açıldı.'}
          action={<Link className="btn btn-sm" to={`/faturalar/${r.invoice.invoiceId}`}>Faturayı aç</Link>}>
          Tutar ve KDV satırlardan yeniden hesaplanır; belgedeki toplam tutmazsa faturada bulgu olarak görünür.
        </Banner>
      ) : <Banner tone="warn" title="Fatura kaydı açılamadı">{r.invoice.reason} Finans görevine düştü.</Banner>)}
      {r.ublCheck && (
        <Banner tone={r.ublCheck.errors ? 'warn' : 'info'} icon={r.ublCheck.errors ? 'alert' : 'check'} title={ublTitle(r.ublCheck)}>
          <UblFindings c={r.ublCheck} />
        </Banner>
      )}
    </>
  );
}
