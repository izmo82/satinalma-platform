// v2 Faz 6 izleme (D111, I2): "Risk aksiyonlarım" — risk aksiyonunun sorumlusu (başka departmandan olabilir) kendisine atanmış aksiyonları
// GET /api/v1/risk/actions/mine ile görür ve kapanış notuyla "Tamamlandı" işaretler (PATCH /api/v1/risk/actions/:id). İşlerim'deki
// risk_action_owner görevi buraya ?aksiyon=<id> ile gelir. Ölçüt, cevap, görüş ve puan gösterilmez (sunucu da döndürmez); değerlendirme
// bağlantısı yalnız assessmentVisible ise.
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import { ACTION_KIND_TR, ACTION_STATUS_TR } from '../lib/risk.tsx';
import type { Label } from '../lib/labels.ts';
import { Banner, Empty, ErrorState, Field, Loading, Modal, PageHeader, Tag } from '../ui/kit.tsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface MyRiskAction {
  id: string; assessmentId: string; assessmentVisible: boolean; supplier: { id: string; name: string }; year: number;
  kind: 'MITIGATION' | 'CONTROL'; controlMethod: string | null; controlMethodLabel: string | null; title: string; description: string | null;
  dueOn: string | null; overdue: boolean; status: 'OPEN' | 'DONE' | 'VERIFIED' | 'CANCELLED'; completionNote: string | null; completedAt: string | null;
  can: { close: boolean };
}

const statusLabel = (a: MyRiskAction): Label => a.status === 'OPEN'
  ? (a.overdue ? { text: `${ACTION_STATUS_TR.OPEN} · gecikti`, tone: 'danger', icon: 'clock' } : { text: ACTION_STATUS_TR.OPEN!, tone: 'info', icon: 'clock' })
  : a.status === 'CANCELLED' ? { text: ACTION_STATUS_TR.CANCELLED!, tone: 'neutral', icon: 'x' }
    : { text: ACTION_STATUS_TR[a.status] ?? 'Durum bilinmiyor', tone: 'ok', icon: 'check' };

export function RiskActionsMinePage() {
  const r = useResource<{ items: MyRiskAction[] }>('/api/v1/risk/actions/mine');
  const [params] = useSearchParams();
  const focusId = params.get('aksiyon');
  const [closing, setClosing] = useState<MyRiskAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const focusRef = useRef<HTMLLIElement | null>(null);
  const items = r.data?.items ?? [];
  const focused = focusId ? items.find((x) => x.id === focusId) : undefined;
  useEffect(() => { if (focused) { focusRef.current?.scrollIntoView({ block: 'center' }); focusRef.current?.focus({ preventScroll: true }); } }, [focused]);
  const open = items.filter((x) => x.status === 'OPEN').length;

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <p className="text-sm text-ink-subtle"><Link to="/islerim" className="text-ink-subtle">İşlerim</Link> / Risk aksiyonlarım</p>
      <PageHeader title="Risk aksiyonlarım">
        Yıllık risk değerlendirmelerinde sorumlusu olduğunuz aksiyonlar. Tamamladığınızda ne yaptığınızı kısaca yazın; kapanış değerlendirmeyi yapan ekibe görünür.
      </PageHeader>
      {notice && <Banner tone="info" icon="check" title={notice} />}
      {focusId && r.data && !focused && <Banner tone="warn" title="Aksiyon bulunamadı">Bu aksiyon size atanmış değil, iptal edildi ya da değerlendirmesi kapandı. Size atanmış diğer aksiyonlar aşağıda.</Banner>}
      {r.loading && !r.data ? <Loading rows={4} /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="check" title="Size atanmış risk aksiyonu yok">Bir değerlendirmede sorumlu olarak seçildiğinizde aksiyon burada ve İşlerim'de görünür.</Empty></div>
      ) : (
        <>
          <p className="mb-2 text-sm text-ink-muted"><span className="tabular">{open}</span> açık · <span className="tabular">{items.length}</span> toplam</p>
          <ul className="grid gap-3" aria-label="Risk aksiyonlarım">
            {items.map((a) => (
              <li key={a.id} ref={a.id === focusId ? focusRef : undefined} aria-current={a.id === focusId ? 'true' : undefined} tabIndex={a.id === focusId ? -1 : undefined}
                className={cn('panel', a.id === focusId && 'outline-2 outline-offset-2 outline-focus')}>
                <div className="panel-body grid gap-2">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                    <h2 className="min-w-0 flex-1 text-base" style={{ overflowWrap: 'anywhere' }}>{a.title}</h2>
                    <Tag label={statusLabel(a)} />
                  </div>
                  <dl className="facts">
                    <dt>Tedarikçi</dt><dd>{a.supplier.name}</dd>
                    <dt>Değerlendirme yılı</dt><dd className="tabular">{a.year}</dd>
                    <dt>Tür</dt><dd>{ACTION_KIND_TR[a.kind] ?? 'Aksiyon'}{a.controlMethodLabel ? ` · ${a.controlMethodLabel}` : ''}</dd>
                    <dt>Hedef tarih</dt><dd className="tabular">{a.dueOn ? fmtDate(a.dueOn) : 'Tarih yok'}{a.status === 'OPEN' && a.overdue ? ' · gecikti' : ''}</dd>
                    {a.description && <><dt>Açıklama</dt><dd className="whitespace-pre-wrap">{a.description}</dd></>}
                    {a.completedAt && <><dt>Kapanış</dt><dd>{fmtDateTime(a.completedAt)}{a.completionNote ? ` · ${a.completionNote}` : ''}</dd></>}
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    {a.status === 'OPEN' && a.can.close && <Button size="sm" onClick={() => { setNotice(null); setClosing(a); }} aria-label={`Tamamlandı: ${a.title}`}>Tamamlandı</Button>}
                    {a.assessmentVisible && <Button size="sm" variant="outline" asChild><Link to={`/tedarikciler/risk/${a.assessmentId}`}>Değerlendirmeyi aç</Link></Button>}
                  </div>
                  {a.status === 'OPEN' && !a.can.close && <p className="text-sm text-ink-subtle">Bu aksiyonu değerlendirmeyi yapan ekip kapatır.</p>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {closing && <CompleteDialog a={closing} onClose={() => setClosing(null)}
        onDone={async () => { setNotice(`"${closing.title}" tamamlandı olarak işaretlendi.`); setClosing(null); await r.reload(); }} />}
    </div>
  );
}

function CompleteDialog({ a, onClose, onDone }: { a: MyRiskAction; onClose: () => void; onDone: () => Promise<void> }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (note.trim().length < 3) { setErr('Ne yapıldığını yazın.'); return; }
    setBusy(true); setErr(null);
    try {
      await api(`/api/v1/risk/actions/${a.id}`, { method: 'PATCH', json: { status: 'DONE', completionNote: note.trim() } });
      await onDone();
    } catch (e) { setErr((e as ApiError).message || 'İşlem tamamlanamadı.'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Aksiyonu tamamlandı olarak işaretle" onClose={onClose} footer={<>
      <Button variant="outline" onClick={onClose}>Vazgeç</Button>
      <Button disabled={busy} onClick={() => void submit()}>Tamamlandı</Button></>}>
      <p className="mb-3 font-semibold">{a.title}</p>
      <Field label="Kapanış notu" hint="Zorunlu. Ne yapıldığını ve varsa kanıtın nerede olduğunu yazın." error={err}>
        {(p) => <textarea className="input" rows={3} maxLength={2000} {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
    </Modal>
  );
}
