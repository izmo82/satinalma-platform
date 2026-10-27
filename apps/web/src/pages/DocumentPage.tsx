import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useResource } from '../lib/useApi.ts';
import { api, ApiError } from '../lib/api.ts';
import { fmtDateTime, shortHash } from '../lib/format.ts';
import { originLabel, supplierStatus } from '../lib/labels.ts';
import { hasRole, useSession } from '../lib/session.tsx';
import { Banner, ErrorState, Field, Loading, Tag } from '../ui/kit.tsx';
import { DocumentViewer } from '../ui/DocumentViewer.tsx';

interface Doc {
  id: string; title: string; kind: string; versionNo: number; sha256: string; mimeType: string; sizeBytes: string; filename: string; basicCheckStatus: string;
  basicCheckReason: string | null; avScanStatus: string; pageCount: number | null; createdAt: string;
  fields: { id: string; field: string; value: string | null; origin: string; sourceRef: { kind?: string; path?: string; page?: number | null }; confidence: string; reviewState: string }[];
  suppliers: { supplierId: string; legalName: string; status: string; nameMismatch: boolean; extractedName: string | null }[];
}
const fieldLabel: Record<string, string> = {
  invoice_number: 'Fatura no', ettn: 'ETTN', issue_date: 'Fatura tarihi', currency: 'Para birimi', payable_amount: 'Ödenecek tutar',
  seller_tax_id: 'Satıcı vergi kimliği', seller_tax_id_type: 'Satıcı kimlik türü', seller_name: 'Satıcı ünvanı', buyer_tax_id: 'Alıcı vergi kimliği',
  buyer_name: 'Alıcı ünvanı', seller_iban: 'Satıcı IBAN',
};

export function DocumentPage() {
  const { id } = useParams();
  const { me } = useSession();
  const r = useResource<Doc>(`/api/v1/document-versions/${id}`);
  const [targetPage, setTargetPage] = useState<number | null>(null);
  if (r.loading && !r.data) return <div className="page"><Loading /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  const latest = new Map<string, Doc['fields'][number]>();
  for (const f of d.fields) latest.set(f.field, f);
  const canEnter = d.kind === 'INVOICE' && d.basicCheckStatus === 'PASSED' && d.suppliers.length === 0 && hasRole(me, 'FINANCE', 'BUYER', 'MASTER_DATA', 'REQUESTER', 'LEGAL', 'PROCUREMENT_MANAGER');

  return (
    <div className="workspace">
      <section aria-label="Kaynak belge" style={{ borderRight: '1px solid var(--border)' }}>
        {d.basicCheckStatus === 'PASSED' ? <DocumentViewer versionId={d.id} mimeType={d.mimeType} targetPage={targetPage} />
          : <div className="page"><Banner tone="danger" icon="shield" title="Belge karantinada">{d.basicCheckReason}</Banner></div>}
      </section>
      <aside style={{ background: 'var(--surface)' }}>
        <div className="section">
          <h1 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{d.title}</h1>
          <div className="kv-inline" style={{ marginTop: 6 }}><span>Sürüm {d.versionNo}</span><span>{d.filename}</span><span className="mono" title={d.sha256}>SHA-256 {shortHash(d.sha256)}</span><span>{fmtDateTime(d.createdAt)}</span></div>
          <p className="subtle" style={{ marginTop: 6 }}>Antivirüs: {d.avScanStatus === 'NOT_AVAILABLE' ? 'bu ortamda bağlı değil (yerleşik kontroller geçti)' : d.avScanStatus}</p>
        </div>
        <div className="section">
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>Bağlı tedarikçi</h2>
          {d.suppliers.length ? d.suppliers.map((s) => <p key={s.supplierId}><Link to={`/tedarikciler/${s.supplierId}`}>{s.legalName}</Link> <Tag label={supplierStatus[s.status]} />
            {s.nameMismatch && <Tag className="ml-1.5" label={{ text: 'Ünvan farkı', tone: 'warn', icon: 'alert' }} />}</p>) : <p className="muted">Henüz tedarikçiye bağlanmadı.</p>}
        </div>
        <div className="section">
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>Çıkarılan alanlar</h2>
          {latest.size === 0 ? <p className="muted">Bu belge için çıkarılmış alan yok.</p> : (
            <table className="data compact">
              <thead><tr><th scope="col">Alan</th><th scope="col">Değer</th><th scope="col">Köken</th></tr></thead>
              <tbody>{[...latest.values()].map((f) => (
                <tr key={f.id}>
                  <td>{fieldLabel[f.field] ?? f.field}</td>
                  <td className="mono" style={{ overflowWrap: 'anywhere' }}>{f.value ?? <span className="muted">Belgede bulunamadı</span>}
                    {f.sourceRef?.page && <button className="btn btn-ghost btn-sm" onClick={() => setTargetPage(f.sourceRef.page!)}>sayfa {f.sourceRef.page}</button>}
                    {f.sourceRef?.path && <div className="subtle" title={f.sourceRef.path}>Kaynak: XML</div>}</td>
                  <td><Tag label={originLabel[f.origin]} /></td>
                </tr>))}
              </tbody>
            </table>
          )}
        </div>
        {canEnter && <SellerForm id={d.id} onDone={r.reload} />}
      </aside>
    </div>
  );
}

function SellerForm({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const [b, setB] = useState({ taxIdType: 'VKN', taxId: '', name: '', iban: '', page: '1' });
  const [err, setErr] = useState<Record<string, string>>({});
  const [res, setRes] = useState<{ tone: 'info' | 'warn' | 'danger'; msg: string } | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!b.taxId.trim()) er.taxId = 'Vergi kimliğini kaynak belgeden girin.';
    if (!b.name.trim()) er.name = 'Ünvanı girin.';
    setErr(er);
    if (Object.keys(er).length) return;
    try {
      const r = await api<{ outcome: string; message: string }>(`/api/v1/document-versions/${id}/seller-identity`, { method: 'POST',
        json: { taxIdType: b.taxIdType, taxId: b.taxId.trim(), name: b.name.trim(), country: 'TR', iban: b.iban.trim() || null, page: Number(b.page) || null } });
      setRes({ tone: r.data.outcome === 'SELLER_IS_OWN_COMPANY' ? 'warn' : 'info', msg: r.data.message });
      await onDone();
    } catch (e2) { setRes({ tone: 'danger', msg: (e2 as ApiError).message }); }
  }
  return (
    <form className="section" onSubmit={submit} aria-labelledby="seller-h">
      <h2 id="seller-h" style={{ fontSize: 15, marginBottom: 10 }}>Satıcı kimliğini girin</h2>
      <p className="subtle" style={{ marginBottom: 12 }}>Alıcı (kendi şirketiniz) bilgisi değil, faturayı kesen satıcının bilgisi girilir.</p>
      {res && <Banner tone={res.tone} title={res.msg} />}
      <Field label="Kimlik türü">{(p) => <select className="input" {...p} value={b.taxIdType} onChange={(e) => setB({ ...b, taxIdType: e.target.value })}><option>VKN</option><option>TCKN</option></select>}</Field>
      <Field label="Vergi kimliği" error={err.taxId}>{(p) => <input className="input mono" inputMode="numeric" {...p} value={b.taxId} onChange={(e) => setB({ ...b, taxId: e.target.value })} />}</Field>
      <Field label="Satıcı ünvanı" error={err.name}>{(p) => <input className="input" {...p} value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} />}</Field>
      <Field label="IBAN (varsa)" hint="Mevcut banka bilgisini değiştirmez; farklıysa doğrulama görevi açılır.">{(p) => <input className="input mono" {...p} value={b.iban} onChange={(e) => setB({ ...b, iban: e.target.value })} />}</Field>
      <Field label="Kaynak sayfa">{(p) => <input className="input num" type="number" min={1} style={{ width: 100 }} {...p} value={b.page} onChange={(e) => setB({ ...b, page: e.target.value })} />}</Field>
      <button className="btn btn-primary" type="submit">Kaydet ve eşleştir</button>
    </form>
  );
}
