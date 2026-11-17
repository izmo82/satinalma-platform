import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';
import type { Label } from '../lib/labels.ts';
import { Banner, Empty, ErrorState, Field, Loading, Modal, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { trDecimal } from './ContractReview.tsx';

// v2 Faz 7 (D112, R6–R7, Figma 19): sürümlü satınalma kuralı seti. Taslak → yayım (yürürlük tarihi ≥ bugün); yayımlı set değişmez, değişiklik
// yeni sürüm taslağıyla yapılır. Düzenleme yalnız Yönetici (rule.manage); Satınalma ve Denetçi salt okur. Taslak silinmez (veritabanı kuralı).

type Phase = 'DRAFT' | 'IN_FORCE' | 'SCHEDULED' | 'SUPERSEDED';
interface SetSummary { id: string; versionNo: number; status: 'DRAFT' | 'PUBLISHED'; statusLabel: string; phase: Phase; phaseLabel: string; effectiveFrom: string | null;
  ruleCount: number; mandatoryCount: number; totalWeight: number; createdByName: string | null; createdAt: string; publishedByName: string | null; publishedAt: string | null }
interface Rule { id: string; code: string; name: string; description: string | null; checkType: 'DATA' | 'EVIDENCE_AI' | 'MANUAL'; checkTypeLabel: string; checkKey: string | null; checkName: string | null;
  params: Record<string, number | string>; paramLabels: Record<string, string>; methods: string[]; methodLabels: string[]; amountThreshold: string | null; currency: string | null;
  weight: number; mandatory: boolean; sortOrder: number }
interface SetDetail extends SetSummary { rules: Rule[]; can: { manage: boolean } }
interface SetList { today: string; items: SetSummary[]; current: SetSummary | null; draft: SetSummary | null; scheduled: SetSummary[]; can: { manage: boolean } }
interface Checks { items: { key: string; name: string; checkType: 'DATA' | 'EVIDENCE_AI'; checkTypeLabel: string; params: { key: string; label: string; kind: 'int' | 'decimal'; min?: number; max?: number; default: number | string }[] }[];
  checkTypes: { key: string; label: string }[]; methods: { key: string; label: string }[] }

const PHASE_TAG: Record<Phase, Omit<Label, 'text'>> = { IN_FORCE: { tone: 'ok', icon: 'check' }, DRAFT: { tone: 'info', icon: 'pen' }, SCHEDULED: { tone: 'warn', icon: 'clock' }, SUPERSEDED: { tone: 'neutral', icon: 'archive' } };
const phaseTag = (s: SetSummary): Label => ({ text: s.phaseLabel, ...PHASE_TAG[s.phase] });
const setLabel = (s: SetSummary) => `Sürüm ${s.versionNo} · ${s.phaseLabel}${s.effectiveFrom ? ` (${fmtDate(s.effectiveFrom)})` : ''}`;

export function RulesPage() {
  const list = useResource<SetList>('/api/v1/procurement-rule-sets');
  const [params, setParams] = useSearchParams();
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string; errors?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const l = list.data;
  const selectedId = params.get('surum') && l?.items.some((x) => x.id === params.get('surum')) ? params.get('surum')! : (l?.current ?? l?.draft ?? l?.items[0])?.id ?? null;
  const detail = useResource<SetDetail>(selectedId ? `/api/v1/procurement-rule-sets/${selectedId}` : null);
  const select = (id: string) => { const p = new URLSearchParams(params); p.set('surum', id); setParams(p, { replace: true }); };
  const reloadAll = async () => { await list.reload(); await detail.reload(); };
  const fail = (e: unknown) => { const x = e as ApiError; setMsg({ tone: x.status === 409 || x.status === 422 ? 'warn' : 'danger', text: x.message, errors: x.details?.errors }); };
  const create = async (from: string) => {
    setBusy(true); setMsg(null);
    try {
      const d = (await api<SetDetail>('/api/v1/procurement-rule-sets', { method: 'POST', json: { from } })).data;
      setMsg({ tone: 'info', text: `Sürüm ${d.versionNo} taslağı oluşturuldu (${d.ruleCount} kural).` }); await list.reload(); select(d.id);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  if (list.loading && !l) return <div className="page"><Loading rows={6} /></div>;
  if (list.error || !l) return <div className="page"><ErrorState error={list.error} onRetry={list.reload} /></div>;
  const manage = l.can.manage;
  const d = detail.data && detail.data.id === selectedId ? detail.data : null;
  const baseForCopy = l.current ?? l.items.find((x) => x.status === 'PUBLISHED');
  return (
    <div className="page">
      <PageHeader title="Satınalma kuralları" actions={manage && !l.draft ? <div className="flex flex-wrap gap-2">
        {baseForCopy && <Button variant="outline" disabled={busy} onClick={() => void create(baseForCopy.id)}><Icon name="pen" />Yeni sürüm taslağı (sürüm {baseForCopy.versionNo} kopyası)</Button>}
        <Button variant={baseForCopy ? 'outline' : 'default'} disabled={busy} onClick={() => void create('DEFAULT')}><Icon name="upload" />Varsayılan kataloğu yükle</Button></div> : undefined}>
        Tamamlanan proje, tamamlandığı gün yürürlükte olan kural setiyle denetlenir. Yayımlanmış set değişmez; değişiklik yeni sürüm taslağıyla yapılır ve yayım tarihinden itibaren geçerli olur.
      </PageHeader>
      {!manage && <Banner tone="neutral" icon="lock" title="Salt okunur">Kural setlerini Yönetici düzenler ve yayımlar.</Banner>}
      <div aria-live="polite">{msg && <Banner tone={msg.tone} title={msg.text}>{msg.errors?.length ? <ul className="list-disc pl-5">{msg.errors.map((x, i) => <li key={i}>{x}</li>)}</ul> : undefined}</Banner>}</div>
      {!l.items.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="shield" title="Henüz kural seti yok">
        {manage ? '“Varsayılan kataloğu yükle” ile önerilen 14 kurallık taslağı oluşturun, gözden geçirip yayımlayın.' : 'Yönetici kural setini yayımlayana kadar tamamlanan projeler “Kural seti yok” olarak denetlenir.'}</Empty></div> : <>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Field label="Sürüm">{(p) => <select className="input min-w-[280px]" {...p} value={selectedId ?? ''} onChange={(e) => select(e.target.value)}>
            {l.items.map((s) => <option key={s.id} value={s.id}>{setLabel(s)}</option>)}</select>}</Field>
          <div className="mb-4 flex flex-wrap gap-2 text-sm">
            {l.current && <span>Yürürlükte: <strong>sürüm {l.current.versionNo}</strong></span>}
            {l.draft && <span className="text-ink-muted">· Taslak: sürüm {l.draft.versionNo}</span>}
            {l.scheduled.map((x) => <span key={x.id} className="text-ink-muted">· İleri tarihli: sürüm {x.versionNo} ({fmtDate(x.effectiveFrom)})</span>)}
          </div>
        </div>
        {detail.loading && !d ? <Loading rows={6} /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} /> : d && <SetView d={d} today={l.today} manage={manage && d.status === 'DRAFT'}
          scheduled={l.scheduled} onChanged={reloadAll} setMsg={setMsg} fail={fail} />}
      </>}
    </div>
  );
}

function SetView({ d, today, manage, scheduled, onChanged, setMsg, fail }: { d: SetDetail; today: string; manage: boolean; scheduled: SetSummary[]; onChanged: () => Promise<void>;
  setMsg: (m: { tone: 'info' | 'warn' | 'danger'; text: string } | null) => void; fail: (e: unknown) => void }) {
  const checks = useResource<Checks>(manage ? '/api/v1/compliance-checks' : null);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [removing, setRemoving] = useState<Rule | null>(null);
  const [date, setDate] = useState(today);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const publish = async () => {
    setConfirmPublish(false); setBusy(true); setMsg(null);
    try {
      const x = (await api<{ rerunQueued?: number }>(`/api/v1/procurement-rule-sets/${d.id}/publish`, { method: 'POST', json: { effectiveFrom: date } })).data;
      setMsg({ tone: 'info', text: `Sürüm ${d.versionNo} yayımlandı; ${fmtDate(date)} tarihinden itibaren yürürlükte.${x.rerunQueued ? ` Kural seti olmadan denetlenmiş ${x.rerunQueued} proje yeniden denetlenecek.` : ''}` });
      await onChanged();
    }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const remove = async (x: Rule) => {
    setBusy(true); setMsg(null);
    try { await api(`/api/v1/procurement-rule-sets/${d.id}/rules/${x.id}`, { method: 'DELETE' }); setRemoving(null); setMsg({ tone: 'info', text: `${x.code} taslaktan çıkarıldı.` }); await onChanged(); }
    catch (e) { setRemoving(null); fail(e); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-5">
      <section className="panel" aria-labelledby="set-h">
        <div className="panel-head flex-wrap gap-2"><h2 id="set-h" className="flex-1">Sürüm {d.versionNo}</h2><Tag label={phaseTag(d)} /></div>
        <div className="panel-body"><dl className="facts">
          <dt>Yürürlük</dt><dd>{d.effectiveFrom ? fmtDate(d.effectiveFrom) : 'Yayımlanmadı'}</dd>
          <dt>Kurallar</dt><dd className="tabular">{d.ruleCount} kural · {d.mandatoryCount} zorunlu</dd>
          <dt>Ağırlık toplamı</dt><dd className="tabular">{d.totalWeight} <span className="text-sm text-ink-subtle">(puan, uygulanan kuralların ağırlığına oranlanır; toplamın 100 olması gerekmez)</span></dd>
          <dt>Oluşturan</dt><dd>{d.createdByName ?? '—'} · {fmtDateTime(d.createdAt)}</dd>
          {d.publishedAt && <><dt>Yayımlayan</dt><dd>{d.publishedByName ?? '—'} · {fmtDateTime(d.publishedAt)}</dd></>}
        </dl></div>
      </section>
      {manage && <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setEditing('new')}><Icon name="pen" />Kural ekle</Button></div>}
      {editing && (checks.loading && !checks.data ? <Loading rows={3} /> : checks.error ? <ErrorState error={checks.error} onRetry={checks.reload} /> : checks.data &&
        <RuleForm setId={d.id} rule={editing === 'new' ? null : editing} checks={checks.data} onCancel={() => setEditing(null)}
          onSaved={async (text) => { setEditing(null); setMsg({ tone: 'info', text }); await onChanged(); }} />)}
      {!d.rules.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="shield" title="Bu sürümde kural yok">{manage ? 'Kural ekleyin; kuralsız set yayımlanamaz.' : null}</Empty></div> : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Kod</TableHead><TableHead>Ad</TableHead><TableHead>Kontrol türü</TableHead><TableHead>Kapsam</TableHead>
            <TableHead className="text-right">Ağırlık</TableHead><TableHead>Zorunlu</TableHead>{manage && <TableHead><span className="sr-only">İşlem</span></TableHead>}</TableRow></TableHeader>
          <TableBody>{d.rules.map((x) => (
            <TableRow key={x.id}>
              <TableCell className="tabular whitespace-nowrap font-semibold">{x.code}</TableCell>
              <TableCell className="min-w-[220px]">{x.name}{x.description && <span className="block text-sm text-ink-muted">{x.description}</span>}
                {Object.entries(x.params ?? {}).map(([k, v]) => <span key={k} className="block text-sm text-ink-subtle">{x.paramLabels?.[k] ?? 'Parametre'}: {String(v).replace('.', ',')}</span>)}</TableCell>
              <TableCell className="text-sm">{x.checkTypeLabel}{x.checkName && <span className="block text-ink-subtle">{x.checkName}</span>}</TableCell>
              <TableCell className="text-sm">{x.methodLabels.length ? x.methodLabels.join(', ') : 'Tüm yöntemler'}{x.amountThreshold && <span className="block text-ink-subtle">Tutar ≥ {fmtMoney(x.amountThreshold, x.currency)}</span>}</TableCell>
              <TableCell className="tabular text-right">{x.weight}</TableCell>
              <TableCell>{x.mandatory ? <Tag label={{ text: 'Zorunlu', tone: 'warn', icon: 'alert' }} /> : 'Hayır'}</TableCell>
              {manage && <TableCell className="whitespace-nowrap"><Button size="xs" variant="outline" onClick={() => setEditing(x)} aria-label={`${x.code} düzenle`}>Düzenle</Button>{' '}
                <Button size="xs" variant="ghost" onClick={() => setRemoving(x)} aria-label={`${x.code} çıkar`}>Çıkar</Button></TableCell>}
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
      {manage && (
        <form className="panel" onSubmit={(e) => { e.preventDefault(); setConfirmPublish(true); }}>
          <div className="panel-head"><h2>Yayımla</h2></div>
          <div className="panel-body grid gap-2">
            <p className="text-sm text-ink-muted">Yayımlanan set değiştirilemez. Yürürlük tarihi bugün ya da ileri bir gün olabilir; o günden sonra tamamlanan projeler bu setle denetlenir.
              {scheduled.length > 0 && ` İleri tarihli yayımlı set var (sürüm ${scheduled.map((x) => `${x.versionNo}: ${fmtDate(x.effectiveFrom)}`).join(', ')}); daha erken bir tarihe yayımlanamaz.`}</p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Yürürlük tarihi">{(p) => <input className="input" type="date" required min={today} {...p} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
              <Button type="submit" className="mb-4" disabled={busy || !d.rules.length || !date || date < today}><Icon name="stamp" />Yayımla</Button>
            </div>
          </div>
        </form>
      )}
      {confirmPublish && <Modal title={`Sürüm ${d.versionNo} yayımlansın mı?`} onClose={() => setConfirmPublish(false)} footer={<>
        <Button variant="ghost" onClick={() => setConfirmPublish(false)}>Vazgeç</Button><Button disabled={busy} onClick={() => void publish()}>Yayımla</Button></>}>
        <p>Yayım geri alınamaz; yayımlanan set değiştirilemez. Sürüm {d.versionNo}, {fmtDate(date)} tarihinden itibaren tamamlanan projelerde uygulanır. Kural seti olmadan denetlenmiş projeler bu setle kendiliğinden yeniden denetlenir.</p>
      </Modal>}
      {removing && <Modal title={`${removing.code} kuralını çıkar`} onClose={() => setRemoving(null)} footer={<>
        <Button variant="ghost" onClick={() => setRemoving(null)}>Vazgeç</Button><Button disabled={busy} onClick={() => void remove(removing)}>Kuralı çıkar</Button></>}>
        <p>{removing.name} bu taslaktan çıkarılır. Yayımlanmış sürümler etkilenmez.</p></Modal>}
    </div>
  );
}

/** tr-TR ya da nokta ondalıklı sayı metnini API biçimine çevirir: "1.000,50" → "1000.50", "70,5" → "70.5", "1000.50" aynen. */
const toDecimalString = (v: string) => { const t = v.trim().replace(/\s/g, ''); return t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t; };
/** v2 Faz 7 izleme: tutar eşiği tr-TR yazılır ("1.000,50"); virgülsüz ve noktaları üçlü grup olan değer ("1.000", "12.500.000") binlik ayraçlı tam sayıdır. */
const toAmountString = (v: string) => { const t = v.trim().replace(/\s/g, ''); return !t.includes(',') && /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '') : toDecimalString(t); };

interface FormState { code: string; name: string; description: string; checkType: 'DATA' | 'EVIDENCE_AI' | 'MANUAL'; checkKey: string; params: Record<string, string>;
  methods: string[]; amountThreshold: string; currency: string; weight: string; mandatory: boolean }

function RuleForm({ setId, rule, checks, onCancel, onSaved }: { setId: string; rule: Rule | null; checks: Checks; onCancel: () => void; onSaved: (msg: string) => Promise<void> }) {
  const [f, setF] = useState<FormState>(() => rule ? { code: rule.code, name: rule.name, description: rule.description ?? '', checkType: rule.checkType, checkKey: rule.checkKey ?? '',
    params: Object.fromEntries(Object.entries(rule.params ?? {}).map(([k, v]) => [k, String(v)])), methods: rule.methods, amountThreshold: rule.amountThreshold ? trDecimal(rule.amountThreshold) : '', currency: rule.currency ?? '',
    weight: String(rule.weight), mandatory: rule.mandatory }
    : { code: '', name: '', description: '', checkType: 'DATA', checkKey: '', params: {}, methods: [], amountThreshold: '', currency: '', weight: '5', mandatory: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; errors?: string[] } | null>(null);
  const keys = checks.items.filter((c) => c.checkType === f.checkType);
  const check = checks.items.find((c) => c.key === f.checkKey);
  const pickKey = (key: string) => {
    const c = checks.items.find((x) => x.key === key);
    setF({ ...f, checkKey: key, params: Object.fromEntries((c?.params ?? []).map((p) => [p.key, String(f.params[p.key] ?? p.default)])) });
  };
  const save = async () => {
    setBusy(true); setErr(null);
    // Ondalık parametreler metin olarak gönderilir (para/oran hassasiyeti); tam sayı parametreler sayı.
    const params = f.checkType === 'MANUAL' ? {} : Object.fromEntries((check?.params ?? []).map((p) => [p.key, p.kind === 'int' ? Number(f.params[p.key]) : toDecimalString(f.params[p.key] ?? '')]));
    const body = { code: f.code.trim(), name: f.name.trim(), description: f.description.trim() || null, checkType: f.checkType, checkKey: f.checkType === 'MANUAL' ? null : f.checkKey || null,
      params, methods: f.methods, amountThreshold: f.amountThreshold.trim() ? toAmountString(f.amountThreshold) : null, currency: f.amountThreshold.trim() ? (f.currency.trim() || 'TRY').toUpperCase() : null,
      weight: Number(f.weight), mandatory: f.mandatory };
    try {
      if (rule) await api(`/api/v1/procurement-rule-sets/${setId}/rules/${rule.id}`, { method: 'PUT', json: { ...body, sortOrder: rule.sortOrder } });
      else await api(`/api/v1/procurement-rule-sets/${setId}/rules`, { method: 'POST', json: body });
      await onSaved(rule ? `${body.code} güncellendi.` : `${body.code} eklendi.`);
    } catch (e) { const x = e as ApiError; setErr({ text: x.message, errors: x.details?.errors }); } finally { setBusy(false); }
  };
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="panel-head"><h2>{rule ? `Kuralı düzenle · ${rule.code}` : 'Yeni kural'}</h2></div>
      <div className="panel-body grid grid-cols-2 gap-x-4 max-[900px]:grid-cols-1">
        <Field label="Kod">{(p) => <input className="input" required maxLength={40} {...p} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />}</Field>
        <Field label="Ad">{(p) => <input className="input" required maxLength={200} {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <div className="col-span-full"><Field label="Açıklama (isteğe bağlı)">{(p) => <textarea className="input" rows={2} maxLength={2000} {...p} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field></div>
        <Field label="Kontrol türü">{(p) => <select className="input" {...p} value={f.checkType} onChange={(e) => setF({ ...f, checkType: e.target.value as FormState['checkType'], checkKey: '', params: {} })}>
          {checks.checkTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>}</Field>
        {f.checkType !== 'MANUAL' ? <Field label="Kontrol">{(p) => <select className="input" required {...p} value={f.checkKey} onChange={(e) => pickKey(e.target.value)}>
          <option value="">Seçin</option>{keys.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select>}</Field>
          : <p className="self-center text-sm text-ink-muted">Elle değerlendirilen kural: Satınalma kanıt belgesine dayanarak işaretler.</p>}
        {(check?.params ?? []).map((p) => <Field key={p.key} label={p.label} hint={p.min !== undefined || p.max !== undefined ? `${p.min ?? ''}–${p.max ?? ''}` : undefined}>{(x) =>
          <input className="input tabular" inputMode={p.kind === 'int' ? 'numeric' : 'decimal'} required {...x} value={f.params[p.key] ?? ''} onChange={(e) => setF({ ...f, params: { ...f.params, [p.key]: e.target.value } })} />}</Field>)}
        <fieldset className="field col-span-full"><legend>Kapsam: satınalma yöntemi</legend>
          <div className="flex flex-wrap gap-4 text-sm">{checks.methods.map((m) => <label key={m.key} className="flex items-center gap-1.5"><input type="checkbox" checked={f.methods.includes(m.key)}
            onChange={(e) => setF({ ...f, methods: e.target.checked ? [...f.methods, m.key] : f.methods.filter((x) => x !== m.key) })} />{m.label}</label>)}</div>
          <span className="hint">Hiçbiri seçilmezse kural tüm yöntemlerde uygulanır.</span></fieldset>
        <Field label="Tutar eşiği (isteğe bağlı)" hint="Bu tutar ve üstündeki projelere uygulanır. Binlik ayracı nokta, ondalık ayracı virgül: 1.000,50 (en çok 2 ondalık). 1.000 bin olarak okunur.">{(p) => <input className="input tabular" inputMode="decimal" {...p} value={f.amountThreshold} onChange={(e) => setF({ ...f, amountThreshold: e.target.value })} />}</Field>
        <Field label="Para birimi">{(p) => <input className="input" maxLength={3} placeholder="TRY" {...p} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />}</Field>
        <Field label="Ağırlık" hint="1–100 arası tam sayı.">{(p) => <input className="input tabular" type="number" min={1} max={100} step={1} required {...p} value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} />}</Field>
        <label className="flex items-center gap-2 self-center text-sm font-semibold"><input type="checkbox" checked={f.mandatory} onChange={(e) => setF({ ...f, mandatory: e.target.checked })} />Zorunlu (karşılanmazsa proje uyumsuz)</label>
        <div className="col-span-full flex flex-wrap gap-2"><Button type="submit" disabled={busy}>{rule ? 'Kuralı kaydet' : 'Kuralı ekle'}</Button><Button type="button" variant="ghost" onClick={onCancel}>Vazgeç</Button></div>
        {err && <div className="col-span-full"><Banner tone="warn" title={err.text}>{err.errors?.length ? <ul className="list-disc pl-5">{err.errors.map((x, i) => <li key={i}>{x}</li>)}</ul> : undefined}</Banner></div>}
      </div>
    </form>
  );
}
