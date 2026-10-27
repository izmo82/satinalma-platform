import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { fmtMoney } from '../lib/format.ts';
import { Banner, Field, PageHeader } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// UX03: İhtiyaç → kalem → bütçe → kriter → özet. Adım başına doğrulama, ilk hataya odak; taslak bu cihazda otomatik saklanır.
interface Line { lot: string; description: string; unit: string; quantity: string; spec: string }
interface Crit { code: string; name: string; kind: 'PRICE' | 'SCORE'; weight: string }
interface Draft {
  companyId: string; title: string; category: string; need: string; currency: string; budget: string; budgetVerified: boolean;
  costCenter: string; deliveryLocation: string; neededBy: string; lines: Line[]; criteria: Crit[];
}
const STEPS = ['İhtiyaç', 'Kalemler', 'Bütçe', 'Kriterler', 'Özet'] as const;
const DEC = /^\d{1,18}(\.\d{1,6})?$/;
const blankLine = (lot = 'Lot 1'): Line => ({ lot, description: '', unit: '', quantity: '', spec: '' });
const defaultCriteria: Crit[] = [
  { code: 'PRICE', name: 'Fiyat (TCO)', kind: 'PRICE', weight: '40' },
  { code: 'TECH', name: 'Teknik uygunluk', kind: 'SCORE', weight: '30' },
  { code: 'DELIVERY', name: 'Teslimat ve hizmet', kind: 'SCORE', weight: '15' },
  { code: 'PERF', name: 'Doğrulanmış performans', kind: 'SCORE', weight: '15' },
];
const toNum = (s: string) => (DEC.test(s) ? Number(s) : NaN);

export function ProjectWizard() {
  const { me } = useSession();
  const navigate = useNavigate();
  const storeKey = `sp.projectDraft.${me?.user.id}.${me?.activeTenantId}`;
  const [d, setD] = useState<Draft>(() => {
    try { const s = localStorage.getItem(storeKey); if (s) return JSON.parse(s) as Draft; } catch { /* yok */ }
    return { companyId: me?.companies[0]?.id ?? '', title: '', category: '', need: '', currency: 'TRY', budget: '', budgetVerified: false,
      costCenter: '', deliveryLocation: '', neededBy: '', lines: [blankLine()], criteria: defaultCriteria };
  });
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem(storeKey, JSON.stringify(d)); setSavedAt(new Date()); } catch { /* yok */ } }, 600);
    return () => clearTimeout(t);
  }, [d, storeKey]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setLine = (i: number, k: keyof Line, v: string) => setD((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));
  const setCrit = (i: number, k: keyof Crit, v: string) => setD((x) => ({ ...x, criteria: x.criteria.map((c, j) => (j === i ? { ...c, [k]: v } as Crit : c)) }));
  const weightSum = d.criteria.reduce((a, c) => a + (toNum(c.weight) || 0), 0);

  function validate(s: number): Record<string, string> {
    const e: Record<string, string> = {};
    if (s === 0) {
      if (!d.companyId) e.companyId = 'Alıcı şirketi seçin.';
      if (d.title.trim().length < 3) e.title = 'En az 3 karakterlik bir proje adı yazın.';
      if (d.category.trim().length < 2) e.category = 'Kategori gerekli (ör. BT hizmetleri).';
    }
    if (s === 1) d.lines.forEach((l, i) => {
      if (l.description.trim().length < 2) e[`line-${i}-description`] = 'Kalem açıklaması gerekli.';
      if (!l.unit.trim()) e[`line-${i}-unit`] = 'Birim gerekli (ör. ay, saat, adet).';
      if (!DEC.test(l.quantity) || Number(l.quantity) <= 0) e[`line-${i}-quantity`] = 'Pozitif sayı yazın; ondalık ayırıcı nokta (ör. 12.5).';
    });
    if (s === 2) {
      if (!DEC.test(d.budget)) e.budget = 'Bütçe tutarını yazın; ondalık ayırıcı nokta (ör. 1900000.00).';
      if (!/^[A-Z]{3}$/.test(d.currency)) e.currency = 'ISO para birimi (ör. TRY, EUR).';
    }
    if (s === 3) {
      d.criteria.forEach((c, i) => {
        if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(c.code)) e[`crit-${i}-code`] = 'Büyük harf kod (ör. TECH).';
        if (c.name.trim().length < 2) e[`crit-${i}-name`] = 'Kriter adı gerekli.';
        if (!(toNum(c.weight) > 0)) e[`crit-${i}-weight`] = 'Pozitif ağırlık.';
      });
      if (d.criteria.filter((c) => c.kind === 'PRICE').length !== 1) e.criteria = 'Tam olarak bir fiyat kriteri olmalı.';
      else if (Math.abs(weightSum - 100) > 1e-9) e.criteria = `Ağırlıkların toplamı 100 olmalı (şu an ${weightSum.toLocaleString('tr-TR')}).`;
    }
    return e;
  }
  function next() {
    const e = validate(step);
    setErrors(e);
    if (Object.keys(e).length) {
      requestAnimationFrame(() => (document.getElementById(`f-${Object.keys(e)[0]}`) ?? summaryRef.current)?.focus());
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  async function submit() {
    for (let s = 0; s < 4; s++) { const e = validate(s); if (Object.keys(e).length) { setErrors(e); setStep(s); return; } }
    setBusy(true); setSubmitError(null);
    try {
      const r = await api<{ id: string }>('/api/v1/projects', { method: 'POST', json: {
        companyId: d.companyId, title: d.title.trim(), category: d.category.trim(), need: d.need, currency: d.currency, budget: d.budget, budgetVerified: d.budgetVerified,
        costCenter: d.costCenter || null, deliveryLocation: d.deliveryLocation || null, neededBy: d.neededBy || null,
        lines: d.lines.map((l) => ({ ...l, lot: l.lot.trim() || 'Lot 1' })), criteria: d.criteria } });
      try { localStorage.removeItem(storeKey); } catch { /* yok */ }
      navigate(`/projeler/${r.data.id}`);
    } catch (err) { setSubmitError(err as ApiError); } finally { setBusy(false); }
  }
  const err = (k: string) => errors[k] ?? null;
  const inputCls = (k: string) => cn('input', err(k) && 'border-danger');
  const errCount = Object.keys(errors).length;

  return (
    <div className="page max-w-[1100px]">
      <PageHeader title="Yeni proje" actions={<span className="text-sm text-ink-subtle" aria-live="polite">{savedAt ? `Taslak bu cihazda kaydedildi · ${savedAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>}>
        Taslak sunucuya "Projeyi oluştur" ile kaydedilir. Yayın, ayrı bir tur onayıyla ve görev ayrılığıyla yapılır.
      </PageHeader>
      <ol className="mb-5 flex flex-wrap gap-x-1 gap-y-2" aria-label="Adımlar">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-1">
            <button type="button" onClick={() => i < step && setStep(i)} disabled={i > step} aria-current={i === step ? 'step' : undefined}
              className={cn('flex min-h-8 items-center gap-2 rounded-md px-2.5 text-sm font-semibold', i === step ? 'bg-ink text-primary-foreground' : i < step ? 'text-ink hover:bg-sunken' : 'text-ink-subtle')}>
              <span className="tabular">{i + 1}</span>{s}
            </button>
            {i < STEPS.length - 1 && <Icon name="chevron" size={14} className="text-ink-subtle" />}
          </li>
        ))}
      </ol>
      {errCount > 0 && (
        <div ref={summaryRef} tabIndex={-1}><Banner tone="danger" title="Formda düzeltilecek alanlar var">{errors.criteria ?? `${errCount} alan eksik veya hatalı; her alanın yanında açıklama var.`}</Banner></div>
      )}
      <section className="rounded-md border border-border bg-surface p-5 max-[640px]:p-3">
        {step === 0 && (
          <div className="grid max-w-[720px] gap-0">
            <Field id="f-companyId" label="Alıcı şirket" error={err('companyId')}>{(p) => <select className="input" {...p} value={d.companyId} onChange={(e) => set('companyId', e.target.value)}>
              {me?.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
            <Field id="f-title" label="Proje adı" hint="Ör. BT altyapı bakım hizmeti 2027" error={err('title')}>{(p) => <input className={inputCls('title')} {...p} value={d.title} onChange={(e) => set('title', e.target.value)} />}</Field>
            <Field id="f-category" label="Kategori" hint="Onay akışı ve değerlendirme kategoriye göre seçilir." error={err('category')}>{(p) => <input className={inputCls('category')} {...p} value={d.category} onChange={(e) => set('category', e.target.value)} />}</Field>
            <Field id="f-need" label="İhtiyaç açıklaması">{(p) => <textarea className="input" rows={4} {...p} value={d.need} onChange={(e) => set('need', e.target.value)} />}</Field>
            <div className="grid grid-cols-2 gap-x-4 max-[640px]:grid-cols-1">
              <Field id="f-deliveryLocation" label="Teslimat yeri">{(p) => <input className="input" {...p} value={d.deliveryLocation} onChange={(e) => set('deliveryLocation', e.target.value)} />}</Field>
              <Field id="f-neededBy" label="İhtiyaç tarihi">{(p) => <input className="input" type="date" {...p} value={d.neededBy} onChange={(e) => set('neededBy', e.target.value)} />}</Field>
            </div>
          </div>
        )}
        {step === 1 && (
          <div className="grid gap-3">
            <p className="text-ink-muted">Teklifler bu kalemlere eşlenir. Birim teklif karşılaştırmasında esas alınır; farklı birim yalnız tanımlı dönüşümle (ör. yıl→ay) karşılaştırılır.</p>
            {d.lines.map((l, i) => (
              <fieldset key={i} className="grid grid-cols-[110px_minmax(0,1fr)_110px_120px_auto] items-start gap-3 rounded-md border border-border bg-white p-3 max-[900px]:grid-cols-2">
                <legend className="sr-only">Kalem {i + 1}</legend>
                <Field id={`f-line-${i}-lot`} label="Lot">{(p) => <input className="input" {...p} value={l.lot} onChange={(e) => setLine(i, 'lot', e.target.value)} />}</Field>
                <Field id={`f-line-${i}-description`} label={`Kalem ${i + 1}`} error={err(`line-${i}-description`)}>{(p) => <input className={inputCls(`line-${i}-description`)} {...p} value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} />}</Field>
                <Field id={`f-line-${i}-unit`} label="Birim" error={err(`line-${i}-unit`)}>{(p) => <input className={inputCls(`line-${i}-unit`)} {...p} value={l.unit} onChange={(e) => setLine(i, 'unit', e.target.value)} />}</Field>
                <Field id={`f-line-${i}-quantity`} label="Miktar" error={err(`line-${i}-quantity`)}>{(p) => <input className={cn(inputCls(`line-${i}-quantity`), 'tabular text-right')} inputMode="decimal" {...p} value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value.replace(',', '.'))} />}</Field>
                <Button type="button" variant="ghost" size="sm" className="mt-6" disabled={d.lines.length === 1} onClick={() => set('lines', d.lines.filter((_, j) => j !== i))} aria-label={`Kalem ${i + 1} sil`}><Icon name="close" /></Button>
                <div className="col-span-full"><Field id={`f-line-${i}-spec`} label="Teknik şartname / kabul koşulu">{(p) => <textarea className="input" rows={2} {...p} value={l.spec} onChange={(e) => setLine(i, 'spec', e.target.value)} />}</Field></div>
              </fieldset>
            ))}
            <Button type="button" variant="outline" className="justify-self-start" onClick={() => set('lines', [...d.lines, blankLine(d.lines.at(-1)?.lot)])}><Icon name="folder" />Kalem ekle</Button>
          </div>
        )}
        {step === 2 && (
          <div className="grid max-w-[720px] gap-0">
            <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-x-4">
              <Field id="f-budget" label="Bütçe" hint="Ondalık ayırıcı nokta. Para hesabı ondalık tutulur, yuvarlanmaz." error={err('budget')}>{(p) => <input className={cn(inputCls('budget'), 'tabular text-right')} inputMode="decimal" {...p} value={d.budget} onChange={(e) => set('budget', e.target.value.replace(',', '.'))} />}</Field>
              <Field id="f-currency" label="Para birimi" error={err('currency')}>{(p) => <input className={inputCls('currency')} {...p} value={d.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} />}</Field>
            </div>
            <label className="mb-4 flex items-start gap-2"><input type="checkbox" className="mt-1 accent-[var(--ink)]" checked={d.budgetVerified} onChange={(e) => set('budgetVerified', e.target.checked)} />
              <span>Bütçe kaynağı finans tarafından doğrulandı<span className="block text-sm text-ink-muted">İşaretlenmezse proje boyunca "Bütçe doğrulanmadı" olarak görünür.</span></span></label>
            <Field id="f-costCenter" label="Maliyet merkezi">{(p) => <input className="input" {...p} value={d.costCenter} onChange={(e) => set('costCenter', e.target.value)} />}</Field>
          </div>
        )}
        {step === 3 && (
          <div className="grid gap-3">
            <p className="text-ink-muted">Kriterler ve ağırlıklar yayında kilitlenir. Fiyat puanı hesaplanır (100 × en düşük uygun TCO / teklif TCO); diğer kriterler kanıtlı puanla verilir.</p>
            {d.criteria.map((c, i) => (
              <div key={i} className="grid grid-cols-[140px_minmax(0,1fr)_160px_110px_auto] items-start gap-3 max-[900px]:grid-cols-2">
                <Field id={`f-crit-${i}-code`} label="Kod" error={err(`crit-${i}-code`)}>{(p) => <input className={inputCls(`crit-${i}-code`)} {...p} value={c.code} onChange={(e) => setCrit(i, 'code', e.target.value.toUpperCase())} />}</Field>
                <Field id={`f-crit-${i}-name`} label="Kriter" error={err(`crit-${i}-name`)}>{(p) => <input className={inputCls(`crit-${i}-name`)} {...p} value={c.name} onChange={(e) => setCrit(i, 'name', e.target.value)} />}</Field>
                <Field id={`f-crit-${i}-kind`} label="Tür">{(p) => <select className="input" {...p} value={c.kind} onChange={(e) => setCrit(i, 'kind', e.target.value)}><option value="PRICE">Fiyat (hesaplanır)</option><option value="SCORE">Puan (kanıtlı)</option></select>}</Field>
                <Field id={`f-crit-${i}-weight`} label="Ağırlık" error={err(`crit-${i}-weight`)}>{(p) => <input className={cn(inputCls(`crit-${i}-weight`), 'tabular text-right')} inputMode="decimal" {...p} value={c.weight} onChange={(e) => setCrit(i, 'weight', e.target.value.replace(',', '.'))} />}</Field>
                <Button type="button" variant="ghost" size="sm" className="mt-6" disabled={d.criteria.length === 1} onClick={() => set('criteria', d.criteria.filter((_, j) => j !== i))} aria-label={`${c.name || 'Kriter'} sil`}><Icon name="close" /></Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-4">
              <Button type="button" variant="outline" onClick={() => set('criteria', [...d.criteria, { code: '', name: '', kind: 'SCORE', weight: '' }])}>Kriter ekle</Button>
              <span className={cn('tabular font-semibold', Math.abs(weightSum - 100) > 1e-9 ? 'text-danger' : 'text-verified')} aria-live="polite">Toplam ağırlık: {weightSum.toLocaleString('tr-TR')} / 100</span>
            </div>
          </div>
        )}
        {step === 4 && (
          <div className="grid gap-5">
            <dl className="facts">
              <dt>Şirket</dt><dd>{me?.companies.find((c) => c.id === d.companyId)?.name}</dd>
              <dt>Proje</dt><dd className="font-semibold">{d.title}</dd>
              <dt>Kategori</dt><dd>{d.category}</dd>
              <dt>Bütçe</dt><dd className="tabular">{DEC.test(d.budget) ? fmtMoney(d.budget, d.currency) : '—'} {!d.budgetVerified && <span className="text-warn">· doğrulanmadı</span>}</dd>
              <dt>Kalemler</dt><dd>{d.lines.length} kalem, {new Set(d.lines.map((l) => l.lot || 'Lot 1')).size} lot</dd>
              <dt>Kriterler</dt><dd>{d.criteria.map((c) => `${c.name} %${c.weight}`).join(' · ')}</dd>
            </dl>
            {submitError && <Banner tone="danger" title={submitError.message} />}
          </div>
        )}
      </section>
      <div className="mt-4 flex flex-wrap gap-2">
        {step > 0 && <Button variant="outline" onClick={() => { setErrors({}); setStep((s) => s - 1); }}>Geri</Button>}
        {step < STEPS.length - 1 ? <Button onClick={next}>Devam</Button> : <Button onClick={() => void submit()} disabled={busy}>{busy ? 'Oluşturuluyor…' : 'Projeyi oluştur'}</Button>}
        <Button variant="ghost" className="ml-auto" onClick={() => { try { localStorage.removeItem(storeKey); } catch { /* yok */ } navigate('/projeler'); }}>Taslağı at</Button>
      </div>
    </div>
  );
}
