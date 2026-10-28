import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { fmtDateTime, fmtMoney } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import { Banner, Empty, ErrorState, Field, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';

// Kurallı onay motoru (02 §13): sürümlü politika, yayın ikinci kişiyle, senaryo simülasyonu. Devam eden işler başladıkları sürümle biter.
type Action = 'RFQ_PUBLISH' | 'AWARD' | 'SOURCING_EXCEPTION';
interface Step { role: Role; label: string }
type Role = keyof typeof ROLE;
interface Rule { id: string; action: Action; companyId?: string | null; category?: string | null; currency: string; minAmount: string; maxAmount: string | null; steps: Step[];
  minInvitees?: number | null; minResponseDays?: number | null }
interface Policy { id: string; versionNo: number; status: 'DRAFT' | 'ACTIVE' | 'RETIRED'; note: string; rules: Rule[]; createdBy: string; createdByMe: boolean; createdAt: string;
  activatedBy: string | null; activatedAt: string | null }
interface Plan { policyVersion: number | null; ruleId: string | null; steps: Step[]; minInvitees: number | null; minResponseDays: number | null; explanation: string }

const ACTION: Record<Action, string> = { RFQ_PUBLISH: 'Teklif turu yayını', AWARD: 'Seçim kararı', SOURCING_EXCEPTION: 'Kaynak bulma istisnası' };
const ROLE = { PROCUREMENT_MANAGER: 'Satınalma yöneticisi', FINANCE: 'Finans', LEGAL: 'Hukuk', SECURITY: 'Bilgi güvenliği' } as const;
const STATUS = { ACTIVE: { text: 'Yürürlükte', tone: 'ok', icon: 'check' }, DRAFT: { text: 'Taslak', tone: 'info', icon: 'pen' }, RETIRED: { text: 'Emekli', tone: 'neutral', icon: 'minus' } } as const;
const blankRule = (n: number): Rule => ({ id: `K${n}`, action: 'AWARD', category: '', currency: 'TRY', minAmount: '0', maxAmount: null, steps: [{ role: 'PROCUREMENT_MANAGER', label: ROLE.PROCUREMENT_MANAGER }], minInvitees: null, minResponseDays: null });

export function ApprovalPolicyPage() {
  const r = useResource<{ items: Policy[]; can: { manage: boolean } }>('/api/v1/approval-policies');
  const [draft, setDraft] = useState<{ rules: Rule[]; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger' | 'warn'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ tone: 'info', text: ok }); await r.reload(); return true; } catch (e) { setMsg({ tone: (e as ApiError).status === 409 ? 'warn' : 'danger', text: (e as ApiError).message }); return false; } finally { setBusy(false); }
  };
  if (r.loading && !r.data) return <div className="page"><Loading rows={6} /></div>;
  if (r.error || !r.data) return <div className="page"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const active = r.data.items.find((p) => p.status === 'ACTIVE') ?? null;
  return (
    <div className="page">
      <p className="text-sm text-ink-subtle"><Link to="/projeler" className="text-ink-subtle">Projeler</Link> / Onay politikası</p>
      <PageHeader title="Onay politikası" actions={r.data.can.manage && !draft && <Button onClick={() => setDraft({ rules: active ? active.rules.map((x) => ({ ...x, steps: x.steps.map((s) => ({ ...s })) })) : [blankRule(1)], note: '' })}>
        <Icon name="pen" />Yeni sürüm hazırla</Button>}>
        Yayın, seçim ve istisna onaylarının adımları şirket, kategori ve tutara göre buradan gelir. Kural yoksa tek adım: satınalma yöneticisi. Yeni sürümü hazırlayan yayınlayamaz;
        devam eden işler başladıkları sürümle tamamlanır.
      </PageHeader>
      {msg && <Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text} />}
      {draft && <DraftEditor draft={draft} setDraft={setDraft} busy={busy}
        onSave={() => void run(() => api('/api/v1/approval-policies', { method: 'POST', json: { note: draft.note, rules: draft.rules.map(clean) } }), 'Taslak kaydedildi; başka bir yetkili yayınlamalı.').then((ok) => ok && setDraft(null))} />}
      <Simulator policies={r.data.items} />
      {!r.data.items.length ? (
        <div className="rounded-md border border-border bg-surface"><Empty icon="info" title="Yayınlanmış politika yok">Tüm onaylar varsayılan tek adımla (satınalma yöneticisi) yürür.</Empty></div>
      ) : r.data.items.map((p) => (
        <section key={p.id} className="panel mb-5">
          <div className="panel-head"><h2>Sürüm {p.versionNo}</h2><Tag label={STATUS[p.status]} />
            <span className="text-sm text-ink-subtle">{p.createdBy} hazırladı · {fmtDateTime(p.createdAt)}{p.activatedBy ? ` · ${p.activatedBy} yayınladı ${fmtDateTime(p.activatedAt!)}` : ''}</span>
            {p.status === 'DRAFT' && r.data!.can.manage && (p.createdByMe
              ? <span className="ml-auto text-sm text-ink-muted">Sizin hazırladığınız sürümü başka biri yayınlar.</span>
              : <Button size="sm" className="ml-auto" disabled={busy} onClick={() => void run(() => api(`/api/v1/approval-policies/${p.id}/activate`, { method: 'POST' }), `Sürüm ${p.versionNo} yürürlüğe girdi.`)}><Icon name="stamp" />Yayınla</Button>)}</div>
          <div className="panel-body grid gap-3">
            <p className="text-sm">{p.note}</p>
            <RulesTable rules={p.rules} />
          </div>
        </section>
      ))}
    </div>
  );
}

const clean = (x: Rule): Rule => ({ ...x, category: x.category?.trim() || null, companyId: x.companyId || null, maxAmount: x.maxAmount?.trim() ? x.maxAmount.replace(',', '.') : null,
  minAmount: x.minAmount.replace(',', '.') || '0', minInvitees: x.action === 'RFQ_PUBLISH' && x.minInvitees ? Number(x.minInvitees) : null,
  minResponseDays: x.action === 'RFQ_PUBLISH' && x.minResponseDays != null && String(x.minResponseDays) !== '' ? Number(x.minResponseDays) : null });

function RulesTable({ rules }: { rules: Rule[] }) {
  if (!rules.length) return <p className="text-ink-muted">Kural yok.</p>;
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Kurallar">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-ink-subtle"><th className="py-1.5 pr-3 font-semibold">Kural</th><th className="pr-3 font-semibold">İş</th><th className="pr-3 font-semibold">Kapsam</th><th className="pr-3 font-semibold">Tutar</th><th className="font-semibold">Adımlar ve koşullar</th></tr></thead>
        <tbody>{rules.map((x) => (
          <tr key={x.id} className="border-t border-border align-top">
            <td className="mono py-2 pr-3">{x.id}</td><td className="pr-3">{ACTION[x.action]}</td>
            <td className="pr-3">{x.category || 'Tüm kategoriler'}{x.companyId ? ' · şirkete özel' : ''}</td>
            <td className="tabular pr-3">{fmtMoney(x.minAmount, x.currency)} – {x.maxAmount ? fmtMoney(x.maxAmount, x.currency) : 'üstü'}</td>
            <td>{x.steps.map((s) => s.label).join(' → ')}{x.minInvitees ? ` · en az ${x.minInvitees} davetli` : ''}{x.minResponseDays ? ` · en az ${x.minResponseDays} gün` : ''}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function DraftEditor({ draft, setDraft, busy, onSave }: { draft: { rules: Rule[]; note: string }; setDraft: (d: { rules: Rule[]; note: string } | null) => void; busy: boolean; onSave: () => void }) {
  const set = (i: number, patch: Partial<Rule>) => setDraft({ ...draft, rules: draft.rules.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <form className="panel mb-5" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <div className="panel-head"><h2>Yeni sürüm taslağı</h2><span className="text-sm text-ink-subtle">En özel kural geçerlidir: kategori+şirket, kategori, şirket, genel. Aynı kapsamda tutar aralıkları çakışamaz.</span></div>
      <div className="panel-body grid gap-4">
        {draft.rules.map((x, i) => (
          <fieldset key={i} className="grid gap-2 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-semibold">Kural {x.id}</legend>
            <div className="grid grid-cols-6 items-start gap-x-3 max-[1100px]:grid-cols-3 max-[640px]:grid-cols-1">
              <Field label="Kural kodu">{(p) => <input className="input mono" required maxLength={40} {...p} value={x.id} onChange={(e) => set(i, { id: e.target.value })} />}</Field>
              <Field label="İş">{(p) => <select className="input" {...p} value={x.action} onChange={(e) => set(i, { action: e.target.value as Action })}>{Object.entries(ACTION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
              <Field label="Kategori" hint="Boş = tümü.">{(p) => <input className="input" {...p} value={x.category ?? ''} onChange={(e) => set(i, { category: e.target.value })} />}</Field>
              <Field label="Para">{(p) => <input className="input" maxLength={3} {...p} value={x.currency} onChange={(e) => set(i, { currency: e.target.value.toUpperCase() })} />}</Field>
              <Field label="En az tutar">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={x.minAmount} onChange={(e) => set(i, { minAmount: e.target.value })} />}</Field>
              <Field label="Üst sınır (hariç)" hint="Boş = sınırsız.">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={x.maxAmount ?? ''} onChange={(e) => set(i, { maxAmount: e.target.value || null })} />}</Field>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {x.steps.map((s, k) => (
                <Field key={k} label={`Adım ${k + 1}`}>{(p) => <select className="input" {...p} value={s.role} onChange={(e) => set(i, { steps: x.steps.map((y, m) => m === k ? { role: e.target.value as Role, label: ROLE[e.target.value as Role] } : y) })}>
                  {Object.entries(ROLE).map(([rk, rv]) => <option key={rk} value={rk}>{rv}</option>)}</select>}</Field>
              ))}
              <Button type="button" size="sm" variant="outline" className="mb-4" disabled={x.steps.length >= 6} onClick={() => set(i, { steps: [...x.steps, { role: 'FINANCE', label: ROLE.FINANCE }] })}>Adım ekle</Button>
              <Button type="button" size="sm" variant="ghost" className="mb-4" disabled={x.steps.length <= 1} onClick={() => set(i, { steps: x.steps.slice(0, -1) })}>Son adımı sil</Button>
              {x.action === 'RFQ_PUBLISH' && <>
                <Field label="En az davetli">{(p) => <input className="input tabular w-24 text-right" inputMode="numeric" {...p} value={x.minInvitees ?? ''} onChange={(e) => set(i, { minInvitees: e.target.value ? Number(e.target.value) : null })} />}</Field>
                <Field label="En az gün">{(p) => <input className="input tabular w-24 text-right" inputMode="numeric" {...p} value={x.minResponseDays ?? ''} onChange={(e) => set(i, { minResponseDays: e.target.value ? Number(e.target.value) : null })} />}</Field>
              </>}
            </div>
            <div><Button type="button" size="sm" variant="ghost" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}>Kuralı çıkar</Button></div>
          </fieldset>
        ))}
        <div><Button type="button" variant="outline" onClick={() => setDraft({ ...draft, rules: [...draft.rules, blankRule(draft.rules.length + 1)] })}>Kural ekle</Button></div>
        <Field label="Değişiklik notu" hint="Neden değişti; denetim kaydına ve sürüm kartına yazılır.">{(p) => <textarea className="input" rows={2} required minLength={10} {...p} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />}</Field>
        <div className="flex gap-2"><Button type="submit" disabled={busy || draft.note.trim().length < 10}>Taslağı kaydet</Button><Button type="button" variant="ghost" onClick={() => setDraft(null)}>Vazgeç</Button></div>
      </div>
    </form>
  );
}

function Simulator({ policies }: { policies: Policy[] }) {
  const { me } = useSession();
  const [f, setF] = useState({ policyId: '', action: 'AWARD' as Action, companyId: me?.companies[0]?.id ?? '', category: '', currency: 'TRY', amount: '' });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className="panel mb-5">
      <div className="panel-head"><h2>Senaryo simülasyonu</h2><span className="text-sm text-ink-subtle">Yayından önce bir taslağın hangi adımları üreteceğini görün.</span></div>
      <form className="panel-body grid gap-3" onSubmit={(e) => { e.preventDefault(); setErr(null);
        void api<Plan>('/api/v1/approval-policies/simulate', { method: 'POST', json: { policyId: f.policyId || null, action: f.action, companyId: f.companyId, category: f.category.trim() || null,
          currency: f.currency, amount: f.amount.replace(',', '.') || null } }).then((x) => setPlan(x.data), (x: ApiError) => setErr(x.message)); }}>
        <div className="grid grid-cols-6 items-start gap-x-3 max-[1100px]:grid-cols-3 max-[640px]:grid-cols-1">
          <Field label="Sürüm">{(p) => <select className="input" {...p} value={f.policyId} onChange={(e) => setF({ ...f, policyId: e.target.value })}>
            <option value="">Yürürlükteki</option>{policies.filter((x) => x.status === 'DRAFT').map((x) => <option key={x.id} value={x.id}>Taslak {x.versionNo}</option>)}</select>}</Field>
          <Field label="İş">{(p) => <select className="input" {...p} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value as Action })}>{Object.entries(ACTION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
          <Field label="Şirket">{(p) => <select className="input" {...p} value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>{me?.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
          <Field label="Kategori">{(p) => <input className="input" {...p} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />}</Field>
          <Field label="Para">{(p) => <input className="input" maxLength={3} {...p} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />}</Field>
          <Field label="Tutar" hint="Boş = bilinmiyor.">{(p) => <input className="input tabular text-right" inputMode="decimal" {...p} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
        </div>
        <div><Button type="submit" variant="outline" disabled={!f.companyId}>Simüle et</Button></div>
        {err && <Banner tone="danger" title={err} />}
        {plan && <div aria-live="polite" className="rounded-md bg-sunken px-3 py-2 text-sm"><p className="font-semibold">{plan.steps.map((s, i) => `${i + 1}. ${s.label}`).join(' → ')}</p><p className="text-ink-muted">{plan.explanation}</p></div>}
      </form>
    </section>
  );
}
