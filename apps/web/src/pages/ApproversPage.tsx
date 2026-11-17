import { useEffect, useId, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { Label } from '../lib/labels.ts';
import { hasRole, useSession } from '../lib/session.tsx';
import { useResource } from '../lib/useApi.ts';
import { Banner, ErrorState, Loading, PageHeader, Tag } from '../ui/kit.tsx';
import { Button } from '@/components/ui/button';

// v2 Faz 2 (D105) Görev 6: Yönetim > Onaycılar (Figma 21). Sözleşme onay zincirinin üç unvanı: departman sorumlusu (+ vekil),
// satınalma sorumlusu (+ vekil, R2: Figma'ya ek alan) ve satınalma direktörü (+ vekil). Yalnız Yönetici atar (approver.manage);
// Satınalma ve Denetçi aynı ekranı düzenleme denetimi olmadan görür. Adaylar kiracının etkin iç kullanıcılarıdır.

interface Person { userId: string; displayName: string; email: string; active: boolean }
type Status = 'DEFINED' | 'NO_DEPUTY' | 'UNASSIGNED' | 'INACTIVE';
interface DeptRow { departmentId: string; departmentName: string; head: Person | null; deputy: Person | null; status: Status; suggestion: Person | null }
interface Approvers {
  organization: { lead: Person | null; leadDeputy: Person | null; director: Person | null; directorDeputy: Person | null };
  departments: DeptRow[];
  candidates: Person[];
}
type OrgKey = 'lead' | 'leadDeputy' | 'director' | 'directorDeputy';
type Draft = { org: Record<OrgKey, string>; depts: Record<string, { head: string; deputy: string }> };

const ORG_FIELDS: { key: OrgKey; label: string; hint?: string }[] = [
  { key: 'lead', label: 'Satınalma sorumlusu' },
  { key: 'leadDeputy', label: 'Sorumlu vekili', hint: 'Sorumlu, kendi eklediği sözleşmeyi onaylayamaz; o zaman vekil onaylar.' },
  { key: 'director', label: 'Satınalma direktörü' },
  { key: 'directorDeputy', label: 'Direktör vekili' },
];

const STATUS: Record<Status, Label> = {
  DEFINED: { text: 'Tanımlı', tone: 'info', icon: 'check' },
  NO_DEPUTY: { text: 'Vekil yok', tone: 'warn', icon: 'alert', hint: 'Sorumlu kendi eklediği sözleşmeyi onaylayamaz; vekil yoksa onay tıkanabilir.' },
  UNASSIGNED: { text: 'Atanmadı', tone: 'danger', icon: 'x', hint: 'Sorumlusu atanmamış departmanın sözleşmeleri onaya gönderilemez.' },
  INACTIVE: { text: 'Pasif kişi', tone: 'danger', icon: 'x', hint: 'Atanan sorumlu artık etkin değil (Entra\'da kapalı, askıda ya da erişimi kaldırıldı); yeni sorumlu seçin.' },
};

function draftOf(d: Approvers): Draft {
  const o = d.organization;
  return {
    org: { lead: o.lead?.userId ?? '', leadDeputy: o.leadDeputy?.userId ?? '', director: o.director?.userId ?? '', directorDeputy: o.directorDeputy?.userId ?? '' },
    depts: Object.fromEntries(d.departments.map((r) => [r.departmentId, { head: r.head?.userId ?? '', deputy: r.deputy?.userId ?? '' }])),
  };
}

/** Kişi seçici: etkin adaylar; atanmış ama etkin olmayan kişi "(pasif)" seçeneği olarak görünür, yeniden seçilemez. */
function PersonSelect({ id, value, onChange, candidates, assigned, label, disabled }: {
  id?: string; value: string; onChange: (v: string) => void; candidates: Person[]; assigned: Person | null; label?: string; disabled: boolean;
}) {
  const inactive = assigned && !candidates.some((c) => c.userId === assigned.userId) ? assigned : null;
  return (
    <select id={id} className="input min-w-0" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">Atanmadı</option>
      {inactive && <option value={inactive.userId} disabled>{inactive.displayName} (pasif)</option>}
      {candidates.map((c) => <option key={c.userId} value={c.userId}>{c.displayName}</option>)}
    </select>
  );
}

const name = (p: Person | null) => (p ? <span>{p.displayName}{!p.active && <span className="text-danger"> (pasif)</span>}</span> : <span className="text-ink-muted">Atanmadı</span>);

export function ApproversPage() {
  const { me } = useSession();
  const admin = hasRole(me, 'ADMIN');
  const r = useResource<Approvers>('/api/v1/approver-assignments');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const ids = useId();
  useEffect(() => { if (r.data) setDraft(draftOf(r.data)); }, [r.data]);

  const isActive = (id: string) => !!id && !!r.data?.candidates.some((c) => c.userId === id);

  if (r.loading && !r.data) return <div className="page"><PageHeader title="Onaycılar" /><Loading rows={6} /></div>;
  if (r.error || !r.data || !draft) return <div className="page"><PageHeader title="Onaycılar" /><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const data = r.data;
  const initial = draftOf(data);
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  const statusOf = (dep: string): Status => {
    const d = draft.depts[dep] ?? { head: '', deputy: '' };
    if (!d.head) return 'UNASSIGNED';
    if (!isActive(d.head)) return 'INACTIVE';
    if (!d.deputy || !isActive(d.deputy)) return 'NO_DEPUTY';
    return 'DEFINED';
  };
  const setOrg = (k: OrgKey, v: string) => { setMsg(null); setDraft({ ...draft, org: { ...draft.org, [k]: v } }); };
  const setDept = (dep: string, k: 'head' | 'deputy', v: string) => { setMsg(null); setDraft({ ...draft, depts: { ...draft.depts, [dep]: { ...draft.depts[dep]!, [k]: v } } }); };

  async function save() {
    if (!draft || busy) return;
    setBusy(true); setMsg(null);
    try {
      await api('/api/v1/approver-assignments', { method: 'PUT', json: {
        organization: { leadUserId: draft.org.lead || null, leadDeputyUserId: draft.org.leadDeputy || null, directorUserId: draft.org.director || null, directorDeputyUserId: draft.org.directorDeputy || null },
        departments: data.departments.map((d) => ({ departmentId: d.departmentId, headUserId: draft.depts[d.departmentId]?.head || null, deputyUserId: draft.depts[d.departmentId]?.deputy || null })),
      } });
      await r.reload();
      setMsg({ tone: 'info', text: 'Onaycılar kaydedildi.' });
    } catch (err) {
      let text = err instanceof ApiError ? err.message : 'Onaycılar kaydedilemedi.';
      // Hangi satırın reddedildiğini söyle (ayrıntı: kind, departmentId).
      const det = err instanceof ApiError ? err.details as { kind?: string; departmentId?: string | null } | undefined : undefined;
      if (det?.departmentId) text = `${data.departments.find((d) => d.departmentId === det.departmentId)?.departmentName ?? 'Departman'}: ${text}`;
      else if (det?.kind === 'PROCUREMENT_LEAD') text = `Satınalma sorumlusu: ${text}`;
      else if (det?.kind === 'PROCUREMENT_DIRECTOR') text = `Satınalma direktörü: ${text}`;
      setMsg({ tone: 'danger', text });
    } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <PageHeader title="Onaycılar"
        actions={admin && <Button disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Kaydediliyor…' : 'Değişiklikleri kaydet'}</Button>}>
        Her sözleşme sırayla üç onaydan geçer: departman sorumlusu, satınalma sorumlusu, satınalma direktörü.
      </PageHeader>
      {!admin && <Banner tone="info" title="Onaycıları Yönetici atar">Bu ekranı görüntüleyebilirsiniz; değişiklik için Yönetici'ye başvurun.</Banner>}
      <div aria-live="polite">{msg && <Banner tone={msg.tone} icon={msg.tone === 'info' ? 'check' : undefined} title={msg.text} />}</div>
      {admin && dirty && <p className="mb-3 text-sm text-warn">Kaydedilmemiş değişiklik var.</p>}

      <section className="panel" aria-labelledby={`${ids}-org`}>
        <div className="panel-head"><h2 id={`${ids}-org`}>Kurum geneli</h2></div>
        <div className="panel-body grid gap-4">
          <div className="grid gap-x-6 gap-y-3 min-[700px]:grid-cols-2">
            {ORG_FIELDS.map((f) => {
              const fid = `${ids}-${f.key}`;
              const assigned = data.organization[f.key];
              return (
                <div key={f.key} className="grid content-start gap-1">
                  {admin ? <>
                    <label htmlFor={fid} className="text-sm font-semibold">{f.label}</label>
                    <PersonSelect id={fid} value={draft.org[f.key]} onChange={(v) => setOrg(f.key, v)} candidates={data.candidates} assigned={assigned} disabled={busy} />
                  </> : <>
                    <span className="text-sm font-semibold">{f.label}</span>{name(assigned)}
                  </>}
                  {f.hint && <span className="text-xs text-ink-muted">{f.hint}</span>}
                  {admin && draft.org[f.key] && !isActive(draft.org[f.key]) && <span className="text-sm text-danger">Seçili kişi etkin değil; başka birini seçin.</span>}
                </div>
              );
            })}
          </div>
          <p className="text-sm text-ink-muted">Onaycılar eşitlenen Entra kullanıcı listesinden seçilir. Kişi kendi eklediği sözleşmeyi onaylayamaz; bu durumda vekil devreye girer.</p>
        </div>
      </section>

      <section className="panel mt-5" aria-labelledby={`${ids}-dep`}>
        <div className="panel-head"><h2 id={`${ids}-dep`}>Departman sorumluları</h2></div>
        <div className="panel-body grid gap-3">
          {!data.departments.length ? <p className="text-ink-muted">Henüz departman yok. Departmanlar Kullanıcılar ve Entra sekmesinde görünür.</p> : (
            <div className="table-wrap">
              <table className="data stack-narrow">
                <thead><tr><th scope="col">Departman</th><th scope="col">Departman sorumlusu</th><th scope="col">Vekil</th><th scope="col">Durum</th></tr></thead>
                <tbody>
                  {data.departments.map((d) => {
                    const cur = draft.depts[d.departmentId] ?? { head: '', deputy: '' };
                    const s = statusOf(d.departmentId);
                    const sugg = d.suggestion && d.suggestion.userId !== cur.head && isActive(d.suggestion.userId) ? d.suggestion : null;
                    return (
                      <tr key={d.departmentId} data-testid={`approver-row-${d.departmentName}`}>
                        <td data-label="Departman" className="font-semibold">{d.departmentName}</td>
                        <td data-label="Departman sorumlusu">
                          {admin ? <div className="grid gap-1.5">
                            <PersonSelect label={`${d.departmentName} departman sorumlusu`} value={cur.head} onChange={(v) => setDept(d.departmentId, 'head', v)}
                              candidates={data.candidates} assigned={d.head} disabled={busy} />
                            {sugg && (
                              <button type="button" disabled={busy} onClick={() => setDept(d.departmentId, 'head', sugg.userId)}
                                className="inline-flex w-fit items-center gap-1.5 rounded-sm border-[1.5px] border-dashed border-ai px-2 py-px text-left text-[0.8125rem] font-semibold text-ai hover:bg-sunken"
                                title="Öneri: bu departmandaki Entra kullanıcılarının en sık yöneticisi. Seçmek için dokunun; kaydedene kadar atanmaz.">
                                Entra yöneticisi: {sugg.displayName}
                              </button>
                            )}
                          </div> : <div className="grid gap-1">{name(d.head)}
                            {d.suggestion && d.suggestion.userId !== d.head?.userId && <span className="text-xs text-ai">Öneri (Entra yöneticisi): {d.suggestion.displayName}</span>}</div>}
                        </td>
                        <td data-label="Vekil">
                          {admin ? <PersonSelect label={`${d.departmentName} vekil`} value={cur.deputy} onChange={(v) => setDept(d.departmentId, 'deputy', v)}
                            candidates={data.candidates} assigned={d.deputy} disabled={busy} /> : name(d.deputy)}
                          {admin && cur.head && cur.head === cur.deputy && <span className="mt-1 block text-sm text-danger">Sorumlu ile vekil aynı kişi olamaz.</span>}
                        </td>
                        <td data-label="Durum"><Tag label={STATUS[s]} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-sm text-ink-muted">Sorumlusu atanmamış departmanın sözleşmeleri onaya gönderilemez.</p>
        </div>
      </section>
    </div>
  );
}
