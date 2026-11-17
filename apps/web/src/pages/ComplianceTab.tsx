import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiDownload, ApiError } from '../lib/api.ts';
import { useResource } from '../lib/useApi.ts';
import { hasPermission, hasRole, useSession } from '../lib/session.tsx';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import type { Label } from '../lib/labels.ts';
import { Banner, Empty, ErrorState, Field, Loading, Modal, Tag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// v2 Faz 7 (D112): proje tamamlama (R5), çıkar çatışması beyanı (R9) ve uyum denetimi raporu (R6–R10, Figma 18). Puan ve hüküm sunucuda
// kodla hesaplanır; özet kodla yazılır ("Otomatik özet"). Yapay zekâ sağlayıcısının etiketi (test sağlayıcısı dahil) her koşuda görünür.

// --- Proje tamamlama ----------------------------------------------------------------------------------------------------------

export interface CompletionInfo { status: string; completedOn?: string | null; completedBy?: string | null; ready?: boolean; blockedReason?: string | null; canComplete?: boolean }

export function CompletionBar({ projectId, info, onDone }: { projectId: string; info: CompletionInfo; onDone: () => Promise<void> | void }) {
  const { me } = useSession();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const complete = async () => {
    setBusy(true); setErr(null);
    try {
      const r = (await api<{ completedOn: string }>(`/api/v1/projects/${projectId}/complete`, { method: 'POST' })).data;
      setConfirm(false); setDone(`Proje ${fmtDate(r.completedOn)} tarihiyle tamamlandı; uyum denetimi sıraya alındı.`); await onDone();
    } catch (e) { setConfirm(false); setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  if (info.status === 'COMPLETED') return (
    <div className="mb-4 grid gap-2">
      <div aria-live="polite">{done && <Banner tone="info" icon="check" title={done} />}</div>
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted"><Tag label={{ text: 'Tamamlandı', tone: 'ok', icon: 'check' }} />
        {info.completedOn && <span>{fmtDate(info.completedOn)}{info.completedBy ? ` · ${info.completedBy}` : ''}</span>}
        {hasPermission(me, 'compliance.read') && <Link to="?sekme=uyum">Uyum denetimini aç</Link>}</p>
    </div>
  );
  if (info.status !== 'CONTRACTING' || !hasRole(me, 'PROCUREMENT')) return err ? <Banner tone="warn" title={err} /> : null;
  return (
    <div className="mb-4 grid gap-2">
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-4 py-3">
        <div className="min-w-[220px] flex-1">
          <p className="font-semibold">Projeyi tamamla</p>
          <p className="text-sm text-ink-muted">{info.canComplete ? 'Projeye bağlı onaylı sözleşme var. Tamamlanınca proje “Tamamlandı” olur ve uyum denetimi koşar.'
            : info.blockedReason ?? 'Tamamlamak için projeye bağlı en az bir onaylı ya da eski kayıt sözleşme gerekir.'}</p>
        </div>
        <Button disabled={!info.canComplete || busy} onClick={() => setConfirm(true)}><Icon name="check" />Projeyi tamamla</Button>
      </div>
      <div aria-live="polite">{err && <Banner tone="warn" title={err} />}{done && <Banner tone="info" icon="check" title={done} />}</div>
      {confirm && <Modal title="Projeyi tamamla" onClose={() => setConfirm(false)} footer={<>
        <Button variant="ghost" onClick={() => setConfirm(false)}>Vazgeç</Button><Button disabled={busy} onClick={() => void complete()}>Tamamla</Button></>}>
        <p>Tamamlanan projede teklif puanlanamaz ve kriter değişmez. Tamamlanma tarihi bugünün tarihi olur; uyum denetimi o gün yürürlükteki satınalma kuralı setiyle koşar.</p>
      </Modal>}
    </div>
  );
}

// --- Çıkar çatışması beyanı (R9) ----------------------------------------------------------------------------------------------

interface CoiLatest { id: string; kind: 'NONE' | 'DECLARED'; kindLabel: string; statement: string | null; declaredAt: string; count: number }
export interface Coi {
  participants: { userId: string; name: string; isMe: boolean; roles: string[]; roleLabels: string[]; latest: CoiLatest | null }[];
  missing: { userId: string; name: string }[]; conflicts: { userId: string; name: string; statement: string }[];
  complete: boolean; hasConflict: boolean; status: 'MISSING' | 'DECLARED' | 'COMPLETE'; statusLabel: string;
  me: { participant: boolean; latest: CoiLatest | null; canDeclare: boolean };
}
const COI_TONE: Record<Coi['status'], Omit<Label, 'text'>> = { COMPLETE: { tone: 'ok', icon: 'check' }, MISSING: { tone: 'warn', icon: 'clock' }, DECLARED: { tone: 'danger', icon: 'alert' } };

function DeclareForm({ projectId, onDone, again }: { projectId: string; onDone: (msg: string) => void; again?: boolean }) {
  const [declaring, setDeclaring] = useState(false);
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async (kind: 'NONE' | 'DECLARED') => {
    setBusy(true); setErr(null);
    try {
      await api(`/api/v1/projects/${projectId}/coi`, { method: 'POST', json: { kind, statement: kind === 'DECLARED' ? statement.trim() : null } });
      setDeclaring(false); setStatement('');
      onDone(kind === 'NONE' ? 'Beyanınız kaydedildi: çıkar çatışmanız yok.' : 'Beyanınız kaydedildi: çıkar çatışması bildirdiniz.');
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void send('NONE')}>Çıkar çatışmam yok</Button>
        <Button size="sm" variant="outline" disabled={busy} aria-expanded={declaring} onClick={() => setDeclaring(true)}>Çıkar çatışmam var</Button>
      </div>
      {declaring && <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void send('DECLARED'); }}>
        <Field label="Açıklama" hint="İlişkiyi ve kapsamı yazın (en az 10 karakter). Beyan proje okuyucularına ve denetçiye görünür.">{(p) =>
          <textarea className="input" rows={3} required minLength={10} maxLength={4000} {...p} value={statement} onChange={(e) => setStatement(e.target.value)} />}</Field>
        <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || statement.trim().length < 10}>Beyanı gönder</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDeclaring(false)}>Vazgeç</Button></div>
      </form>}
      {again && <p className="text-sm text-ink-subtle">Yeni beyan öncekinin yerine geçer; önceki beyan kayıtta kalır.</p>}
      <div aria-live="polite">{err && <Banner tone="warn" title={err} />}</div>
    </div>
  );
}

/** Proje başlığı altında: beyanı bekleyen katılımcıya iki düğmeli bant (tek tık "yok"). */
export function CoiBand({ projectId, coi, onDone }: { projectId: string; coi: Coi | undefined; onDone: () => Promise<void> | void }) {
  const [done, setDone] = useState<string | null>(null);
  if (done) return <Banner tone="info" icon="check" title={done} />;
  if (!coi?.me.participant || !coi.me.canDeclare || coi.me.latest) return null;
  return (
    <section aria-labelledby="coi-band" className="mb-4 grid gap-2 rounded-md border border-[#e8d29c] bg-warn-soft px-4 py-3">
      <h2 id="coi-band" className="text-base">Çıkar çatışması beyanınız bekleniyor</h2>
      <p className="text-sm text-ink-muted">Bu projede {coi.participants.find((p) => p.isMe)?.roleLabels.join(', ').toLocaleLowerCase('tr-TR') || 'katılımcı'} olarak yer aldınız. Tedarikçilerle çıkar ilişkiniz olup olmadığını beyan edin.</p>
      <DeclareForm projectId={projectId} onDone={(m) => { setDone(m); void onDone(); }} />
    </section>
  );
}

export function CoiTab({ projectId }: { projectId: string }) {
  const r = useResource<Coi>(`/api/v1/projects/${projectId}/coi`);
  const [done, setDone] = useState<string | null>(null);
  if (r.loading && !r.data) return <Loading rows={4} />;
  if (r.error || !r.data) return <div className="rounded-md border border-border bg-surface"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const c = r.data;
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3"><Tag label={{ text: c.statusLabel, ...COI_TONE[c.status] }} />
        <span className="text-sm text-ink-muted">Katılımcılar: puan verenler, kazananı öneren ve karar verenler, proje sahibi. Beyanlar değiştirilemez; yenisi eklenir ve sonuncusu geçerlidir.</span></div>
      {c.missing.length > 0 && <Banner tone="warn" title={`Beyan bekleniyor: ${c.missing.map((m) => m.name).join(', ')}`} />}
      {c.conflicts.length > 0 && <Banner tone="danger" title="Çıkar çatışması bildirildi">{c.conflicts.map((x) => `${x.name}: ${x.statement}`).join(' · ')}</Banner>}
      {!c.participants.length ? <div className="rounded-md border border-border bg-surface"><Empty icon="users" title="Henüz katılımcı yok">Puan, kazanan önerisi ya da karar verildiğinde katılımcılar burada görünür.</Empty></div> : (
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Kişi</TableHead><TableHead>Projedeki rolü</TableHead><TableHead>Beyan</TableHead><TableHead>Tarih</TableHead><TableHead>Açıklama</TableHead></TableRow></TableHeader>
          <TableBody>{c.participants.map((p) => (
            <TableRow key={p.userId}>
              <TableCell className="font-semibold">{p.name}{p.isMe && <span className="ml-1 text-sm font-normal text-ink-subtle">(siz)</span>}</TableCell>
              <TableCell>{p.roleLabels.join(', ')}</TableCell>
              <TableCell>{p.latest ? <Tag label={{ text: p.latest.kindLabel, ...(p.latest.kind === 'NONE' ? { tone: 'ok', icon: 'check' } : { tone: 'danger', icon: 'alert' }) } as Label} />
                : <Tag label={{ text: 'Beyan yok', tone: 'warn', icon: 'clock' }} />}{p.latest && p.latest.count > 1 && <span className="block text-sm text-ink-subtle">{p.latest.count} beyan; sonuncusu geçerli</span>}</TableCell>
              <TableCell className="tabular whitespace-nowrap">{p.latest ? fmtDateTime(p.latest.declaredAt) : '—'}</TableCell>
              <TableCell className="max-w-[44ch]">{p.latest?.statement ?? '—'}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      )}
      {c.me.participant && c.me.canDeclare && (
        <section className="panel" aria-labelledby="coi-me">
          <div className="panel-head"><h2 id="coi-me">{c.me.latest ? 'Beyanınızı yenileyin' : 'Beyanınız'}</h2></div>
          <div className="panel-body grid gap-2">
            {c.me.latest && <p className="text-sm text-ink-muted">Geçerli beyanınız: {c.me.latest.kindLabel} · {fmtDateTime(c.me.latest.declaredAt)}</p>}
            <DeclareForm projectId={projectId} again={!!c.me.latest} onDone={(m) => { setDone(m); void r.reload(); }} />
          </div>
        </section>
      )}
      {c.me.participant && !c.me.canDeclare && <p className="text-sm text-ink-muted">Beyan vermek için Satınalma ya da Departman kullanıcısı rolü gerekir.</p>}
      <div aria-live="polite">{done && <Banner tone="info" icon="check" title={done} />}</div>
    </div>
  );
}

// --- Uyum denetimi (Figma 18) -------------------------------------------------------------------------------------------------

type Result = 'PASS' | 'FAIL' | 'NO_DATA' | 'PENDING' | 'NOT_APPLICABLE';
interface Evidence { type: string; documentVersionId?: string; page?: number; text?: string; title?: string; markedBy?: string; markedAt?: string }
interface RuleResult { ruleId: string; code: string; name: string; description: string | null; checkType: string; checkTypeLabel: string; checkKey: string | null; checkName: string | null;
  weight: number; mandatory: boolean; result: Result; resultLabel: string; method: string | null; methodLabel: string | null; finding: string; evidence: Evidence[] }
export interface AuditSummary { id: string; runNo: number; trigger: string; triggerLabel: string; status: 'DONE' | 'NO_RULESET' | 'FAILED'; statusLabel: string;
  ruleSet: { id: string; versionNo: number; effectiveFrom: string } | null; score: number | null; verdict: 'COMPLIANT' | 'NONCOMPLIANT' | 'NO_RULES' | null; verdictLabel: string;
  aiProvider: string | null; aiProviderIsTest: boolean; providerLabel: string; runBy: string | null; createdAt: string; pdfUrl: string; ruleSetFallback?: boolean; ruleSetNote?: string | null }
interface AuditDetail extends AuditSummary { failedMandatory: { code: string; name: string; result: Result; resultLabel: string }[]; summary: string; summarySource: 'AUTO' | 'AI';
  summarySourceLabel: string; results: RuleResult[] }
interface ComplianceRes {
  project: { id: string; code: string; title: string; status: string; completedOn: string | null; departmentName: string | null };
  latest: AuditDetail | null; runs: AuditSummary[];
  /** BLOCKED/DEAD işte `failed: true` (c272218). */
  pendingJob: { id: string; status: string; statusLabel: string; trigger: string; triggerLabel: string | null; failed?: boolean; errorCode?: string | null } | null;
  marks: { id: string; ruleCode: string; result: 'PASS' | 'FAIL'; resultLabel: string; note: string; documentVersionId: string; markedBy: string; markedAt: string }[];
  markableRules: { code: string; name: string; checkType: string; checkTypeLabel: string; checkKey: string | null }[];
  aiConnected: boolean; notice: string | null; can: { rerun: boolean; mark: boolean };
}
interface EvidenceItem { id: string; checkKey: string; kind: string; kindLabel: string; documentVersionId: string; title: string; filename: string; mimeType: string; sizeBytes: number;
  basicCheckLabel: string | null; uploadedBy: string; createdAt: string; contentUrl: string | null }

const RESULT_TAG: Record<Result, Omit<Label, 'text'>> = {
  PASS: { tone: 'ok', icon: 'check' }, FAIL: { tone: 'danger', icon: 'x' }, NO_DATA: { tone: 'warn', icon: 'help' }, PENDING: { tone: 'info', icon: 'clock' }, NOT_APPLICABLE: { tone: 'neutral', icon: 'minus' },
};
export const verdictTag = (a: Pick<AuditSummary, 'verdict' | 'verdictLabel' | 'status'>): Label =>
  a.verdict === 'COMPLIANT' ? { text: a.verdictLabel, tone: 'ok', icon: 'check' } : a.verdict === 'NONCOMPLIANT' ? { text: a.verdictLabel, tone: 'danger', icon: 'x' }
    : a.status === 'FAILED' ? { text: a.verdictLabel, tone: 'danger', icon: 'alert' } : { text: a.verdictLabel, tone: 'neutral', icon: 'minus' };
export const providerTag = (a: Pick<AuditSummary, 'aiProviderIsTest' | 'providerLabel' | 'aiProvider'>): Label =>
  ({ text: a.providerLabel, tone: a.aiProviderIsTest ? 'warn' : 'neutral', icon: a.aiProviderIsTest ? 'alert' : 'info' });
const EVIDENCE_KINDS = [['RESEARCH', 'Araştırma'], ['TRADE_REGISTRY', 'Ticaret sicili'], ['OTHER', 'Diğer']] as const;
const pdfName = (code: string, runNo: number) => `${code}-uyum-denetimi-kosu-${runNo}.pdf`;

function ScoreRing({ score }: { score: number | null }) {
  const r = 34, c = 2 * Math.PI * r;
  const v = score ?? 0;
  return (
    <div className="relative grid size-[88px] shrink-0 place-items-center" role="img" aria-label={score === null ? 'Puan yok' : `Uyum puanı 100 üzerinden ${score}`}>
      <svg width="88" height="88" viewBox="0 0 88 88" aria-hidden="true">
        <circle cx="44" cy="44" r={r} fill="none" stroke="var(--surface-sunken)" strokeWidth="8" />
        {score !== null && <circle cx="44" cy="44" r={r} fill="none" stroke={v >= 80 ? 'var(--verified)' : v >= 50 ? 'var(--warn)' : 'var(--danger)'}
          strokeWidth="8" strokeDasharray={`${(v / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 44 44)" />}
      </svg>
      <span className="tabular absolute text-xl font-semibold">{score ?? '—'}</span>
    </div>
  );
}

export function ComplianceTab({ projectId, projectCode }: { projectId: string; projectCode: string }) {
  const { me } = useSession();
  const r = useResource<ComplianceRes>(`/api/v1/projects/${projectId}/compliance`);
  const ev = useResource<{ items: EvidenceItem[] }>(r.data && !r.data.notice ? `/api/v1/projects/${projectId}/compliance-evidence` : null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = r.data?.pendingJob;
  const running = !!pending && !pending.failed && ['QUEUED', 'RUNNING'].includes(pending.status);
  // İş sırada ya da sürüyorken rapor kendiliğinden tazelenir (işçi koşuyu yazınca görünür).
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => void r.reload(), 3000);
    return () => clearTimeout(t);
  }, [running, r.data, r.reload]);
  if (r.loading && !r.data) return <Loading rows={6} />;
  if (r.error || !r.data) return <div className="rounded-md border border-border bg-surface"><ErrorState error={r.error} onRetry={r.reload} /></div>;
  const d = r.data;
  if (d.notice) return <div className="rounded-md border border-border bg-surface"><Empty icon="shield" title="Uyum denetimi henüz yok">{d.notice} Proje sözleşme aşamasında Satınalma “Projeyi tamamla” ile tamamlar; denetim o gün yürürlükteki satınalma kuralı setiyle koşar.</Empty></div>;
  const a = d.latest;
  const rerun = async () => {
    setBusy(true); setMsg(null);
    try {
      const x = (await api<{ duplicate: boolean }>(`/api/v1/projects/${projectId}/compliance-audits`, { method: 'POST' })).data;
      setMsg({ tone: 'info', text: x.duplicate ? 'Sırada bekleyen denetim var; o koşu tamamlanınca rapor güncellenir.' : 'Yeniden denetim sıraya alındı.' });
      await r.reload();
    } catch (e) { setMsg({ tone: 'warn', text: (e as ApiError).message }); } finally { setBusy(false); }
  };
  const download = async (s: AuditSummary) => {
    setMsg(null);
    try { const name = await apiDownload(s.pdfUrl, pdfName(projectCode, s.runNo)); setMsg({ tone: 'info', text: `${name} indirildi.` }); }
    catch (e) { setMsg({ tone: 'danger', text: (e as ApiError).message }); }
  };
  const canUpload = hasPermission(me, 'document.upload') && hasRole(me, 'PROCUREMENT', 'DEPARTMENT_USER');
  return (
    <div className="grid gap-5">
      {pending && (running
        ? <Banner tone="info" icon="clock" title={pending.statusLabel}>{pending.triggerLabel ? `${pending.triggerLabel}. ` : ''}Rapor koşu bitince bu sekmede kendiliğinden güncellenir.</Banner>
        : <Banner tone="danger" title="Denetim işi çalıştırılamadı">{pending.statusLabel && pending.statusLabel !== 'Denetim işi çalıştırılamadı' ? `${pending.statusLabel}. ` : ''}Yeniden denetlemeyi deneyin; sürerse sistem yöneticisine bildirin.</Banner>)}
      {!a ? (!pending && <div className="rounded-md border border-border bg-surface"><Empty icon="shield" title="Henüz denetim koşusu yok">Proje {fmtDate(d.project.completedOn)} tarihinde tamamlandı; denetim koşusu kaydı bulunamadı.</Empty></div>) : <>
        <section className="panel" aria-labelledby="uyum-h">
          <div className="panel-head flex-wrap gap-2"><h2 id="uyum-h" className="flex-1">Uyum denetimi · koşu {a.runNo}</h2>
            <Button size="sm" variant="outline" onClick={() => void download(a)}><Icon name="file" />PDF indir</Button>
            {d.can.rerun && <Button size="sm" variant="outline" disabled={busy} onClick={() => void rerun()}><Icon name="refresh" />Yeniden denetle</Button>}</div>
          <div className="panel-body grid gap-4">
            <div className="flex flex-wrap items-center gap-5">
              <ScoreRing score={a.score} />
              <div className="grid min-w-[220px] flex-1 gap-1.5">
                <div className="flex flex-wrap items-center gap-2"><Tag label={verdictTag(a)} /><Tag label={providerTag(a)} /></div>
                <p className="text-sm text-ink-muted">{a.ruleSet ? `Kural seti sürüm ${a.ruleSet.versionNo} (yürürlük ${fmtDate(a.ruleSet.effectiveFrom)})` : 'Kural seti yok'} · Tamamlanma {fmtDate(d.project.completedOn)}</p>
                <p className="text-sm text-ink-subtle">{a.triggerLabel} · {a.runBy ?? 'Sistem'} · {fmtDateTime(a.createdAt)}</p>
              </div>
            </div>
            {a.ruleSetNote && <Banner tone="warn" title={a.ruleSetNote} />}
            {a.status === 'NO_RULESET' && <Banner tone="warn" title="Kural seti yok">Bu kurumda yayımlanmış satınalma kuralı seti olmadığı için proje puanlanamadı. Yönetici, Yönetim &gt; Satınalma kuralları sekmesinden bir set yayımlayınca bu proje kendiliğinden yeniden denetlenir.</Banner>}
            {a.status === 'FAILED' && <Banner tone="danger" title="Denetim yapılamadı">Koşu hata ile bitti; puan ve hüküm yok. “Yeniden denetle” ile tekrar deneyin.</Banner>}
            {a.failedMandatory.length > 0 && <Banner tone="danger" title="Karşılanmayan zorunlu kurallar">{a.failedMandatory.map((f) => `${f.code} ${f.name} (${f.resultLabel})`).join(' · ')}</Banner>}
            {!d.aiConnected && <p className="text-sm text-ink-muted"><Icon name="info" size={14} className="mr-1 inline" />Yapay zekâ bağlı değil: kanıt kuralları belgeye bakılarak elle işaretlenir.</p>}
            {a.summary && <div className="rounded-md border border-border bg-sunken px-3 py-2.5">
              <p className="mb-1 text-sm font-semibold">Özet · {a.summarySourceLabel}</p>
              <p className="whitespace-pre-wrap text-sm">{a.summary}</p></div>}
          </div>
        </section>
        {a.results.length > 0 && <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Kural</TableHead><TableHead>Tür</TableHead><TableHead className="text-right">Ağırlık</TableHead><TableHead>Zorunlu</TableHead>
            <TableHead>Sonuç</TableHead><TableHead>Bulgu / kanıt</TableHead></TableRow></TableHeader>
          <TableBody>{a.results.map((x) => (
            <TableRow key={x.ruleId}>
              <TableCell className="min-w-[200px]"><span className="font-semibold">{x.code} · {x.name}</span>{x.description && <span className="block text-sm text-ink-muted">{x.description}</span>}</TableCell>
              <TableCell className="text-sm">{x.checkTypeLabel}{x.checkName && x.checkName !== x.name && <span className="block text-ink-subtle">{x.checkName}</span>}</TableCell>
              <TableCell className="tabular text-right">{x.weight}</TableCell>
              <TableCell>{x.mandatory ? 'Evet' : 'Hayır'}</TableCell>
              <TableCell><Tag label={{ text: x.resultLabel, ...RESULT_TAG[x.result] }} />{x.methodLabel && <span className="block text-sm text-ink-subtle">{x.methodLabel}</span>}</TableCell>
              <TableCell className="min-w-[240px] max-w-[52ch] text-sm"><span className="whitespace-pre-wrap">{x.finding}</span>
                {x.evidence.filter((e) => e.type === 'quote').map((e, i) => <q key={i} className="mt-1 block text-ink-muted">s. {e.page}: {e.text}</q>)}
                {x.evidence.filter((e) => e.type === 'document').map((e, i) => <span key={i} className="mt-1 block text-ink-subtle">Kanıt belgesi: {e.title}</span>)}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>}
      </>}
      <div aria-live="polite">{msg && <Banner tone={msg.tone} title={msg.text} />}</div>
      {(d.markableRules.length > 0 || (ev.data?.items.length ?? 0) > 0) && (
        <EvidencePanel projectId={projectId} rules={d.markableRules} evidence={ev.data?.items ?? []} evLoading={ev.loading && !ev.data} marks={d.marks}
          canUpload={canUpload} canMark={d.can.mark} onChanged={async () => { await ev.reload(); await r.reload(); }} />
      )}
      {d.runs.length > 1 && (
        <section className="panel" aria-labelledby="runs-h">
          <div className="panel-head"><h2 id="runs-h">Koşu geçmişi</h2></div>
          <ul className="divide-y divide-[#ebe6da]">{d.runs.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <span className="tabular font-semibold">Koşu {s.runNo}</span><Tag label={verdictTag(s)} />
              <span className="tabular text-sm">{s.score ?? '—'} / 100</span>
              <span className="text-sm text-ink-muted">{s.ruleSet ? `sürüm ${s.ruleSet.versionNo}` : 'set yok'} · {s.triggerLabel} · {fmtDateTime(s.createdAt)}</span>
              <span className="text-sm text-ink-subtle">{s.providerLabel}</span>
              <Button size="xs" variant="outline" className="ml-auto" onClick={() => void download(s)} aria-label={`Koşu ${s.runNo} PDF indir`}>PDF</Button>
            </li>))}</ul>
        </section>
      )}
    </div>
  );
}

function EvidencePanel({ projectId, rules, evidence, evLoading, marks, canUpload, canMark, onChanged }: { projectId: string; rules: ComplianceRes['markableRules']; evidence: EvidenceItem[]; evLoading: boolean;
  marks: ComplianceRes['marks']; canUpload: boolean; canMark: boolean; onChanged: () => Promise<void> }) {
  const keyOf = (r: ComplianceRes['markableRules'][number]) => r.checkKey ?? r.code;
  const ruleOf = (checkKey: string) => rules.find((r) => keyOf(r) === checkKey || r.code === checkKey);
  const [up, setUp] = useState<{ checkKey: string; kind: string; title: string; file: File | null }>({ checkKey: rules[0] ? keyOf(rules[0]) : '', kind: 'RESEARCH', title: '', file: null });
  const [mark, setMark] = useState<{ ruleCode: string; result: 'PASS' | 'FAIL'; note: string; documentVersionId: string } | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const upload = async () => {
    if (!up.file) return;
    setBusy(true); setMsg(null);
    const fd = new FormData();
    fd.set('checkKey', up.checkKey); fd.set('kind', up.kind); if (up.title.trim()) fd.set('title', up.title.trim()); fd.set('file', up.file);
    try { await api(`/api/v1/projects/${projectId}/compliance-evidence`, { method: 'POST', body: fd }); setMsg({ tone: 'info', text: `${up.file.name} kanıt olarak yüklendi.` }); setUp({ ...up, title: '', file: null }); setFileKey((k) => k + 1); await onChanged(); }
    catch (e) { setMsg({ tone: 'warn', text: (e as ApiError).message }); } finally { setBusy(false); }
  };
  const sendMark = async () => {
    if (!mark) return;
    setBusy(true); setMsg(null);
    try {
      const x = (await api<{ auditJobId: string | null }>(`/api/v1/projects/${projectId}/compliance-marks`, { method: 'POST', json: { ...mark, note: mark.note.trim() } })).data;
      setMark(null); setMsg({ tone: 'info', text: `Elle işaret kaydedildi${x.auditJobId ? '; rapor yeniden denetimle güncellenecek' : ''}.` }); await onChanged();
    } catch (e) { setMsg({ tone: 'warn', text: (e as ApiError).message }); } finally { setBusy(false); }
  };
  const openDoc = async (e: EvidenceItem) => { try { await apiDownload(e.contentUrl!, e.filename); } catch (x) { setMsg({ tone: 'danger', text: (x as ApiError).message }); } };
  return (
    <section className="panel" aria-labelledby="kanit-h">
      <div className="panel-head"><h2 id="kanit-h">Kanıt ve elle işaret</h2></div>
      <div className="panel-body grid gap-4">
        <p className="text-sm text-ink-muted">Kanıt gerektiren ve elle değerlendirilen kurallar. Elle işaret yalnız o kural için yüklenmiş bir kanıt belgesine ve en az 10 karakterlik nota dayanır; denetim kaydına girer.</p>
        <ul className="grid gap-3">{rules.map((r) => {
          const docs = evidence.filter((e) => e.checkKey === keyOf(r) || e.checkKey === r.code);
          const m = marks.find((x) => x.ruleCode === r.code);
          return (
            <li key={r.code} className="grid gap-1.5 border-b border-border pb-3 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{r.code} · {r.name}</span><span className="text-sm text-ink-subtle">{r.checkTypeLabel}</span>
                {m && <Tag label={{ text: `Elle: ${m.resultLabel}`, ...(m.result === 'PASS' ? { tone: 'ok', icon: 'check' } : { tone: 'danger', icon: 'x' }) } as Label} />}</div>
              {m && <p className="text-sm text-ink-muted">{m.note} <span className="text-ink-subtle">· {m.markedBy}, {fmtDateTime(m.markedAt)}</span></p>}
              {evLoading ? <Loading rows={1} /> : docs.length ? <ul className="grid gap-1 text-sm">{docs.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-2"><Icon name="file" size={14} />
                  {e.contentUrl ? <button type="button" className="font-semibold underline" onClick={() => void openDoc(e)}>{e.title}</button> : <span className="font-semibold">{e.title}</span>}
                  <span className="text-ink-subtle">{e.kindLabel} · {e.uploadedBy} · {fmtDateTime(e.createdAt)}{!e.contentUrl ? ' · karantinada, açılamaz' : ''}</span></li>))}</ul>
                : <p className="text-sm text-ink-subtle">Bu kural için kanıt belgesi yüklenmedi.</p>}
              {canMark && (mark?.ruleCode === r.code ? (
                <form className="grid gap-2 rounded-md border border-border p-3" onSubmit={(e) => { e.preventDefault(); void sendMark(); }}>
                  <fieldset className="flex flex-wrap gap-4 text-sm"><legend className="sr-only">Sonuç</legend>
                    <label className="flex items-center gap-1.5"><input type="radio" name={`res-${r.code}`} checked={mark.result === 'PASS'} onChange={() => setMark({ ...mark, result: 'PASS' })} />Karşılandı</label>
                    <label className="flex items-center gap-1.5"><input type="radio" name={`res-${r.code}`} checked={mark.result === 'FAIL'} onChange={() => setMark({ ...mark, result: 'FAIL' })} />Karşılanmadı</label></fieldset>
                  <Field label="Kanıt belgesi">{(p) => <select className="input" required {...p} value={mark.documentVersionId} onChange={(e) => setMark({ ...mark, documentVersionId: e.target.value })}>
                    <option value="">Seçin</option>{docs.map((e) => <option key={e.id} value={e.documentVersionId}>{e.title}</option>)}</select>}</Field>
                  <Field label="Not" hint="En az 10 karakter: belgenin hangi kısmı kuralı karşılıyor ya da karşılamıyor.">{(p) => <textarea className="input" rows={2} required minLength={10} maxLength={4000} {...p} value={mark.note} onChange={(e) => setMark({ ...mark, note: e.target.value })} />}</Field>
                  <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || mark.note.trim().length < 10 || !mark.documentVersionId}>İşareti kaydet</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setMark(null)}>Vazgeç</Button></div>
                </form>
              ) : <div><Button size="sm" variant="outline" disabled={!docs.length} onClick={() => setMark({ ruleCode: r.code, result: 'PASS', note: '', documentVersionId: docs[0]?.documentVersionId ?? '' })}
                aria-label={`${r.code} elle işaretle`}>Elle işaretle</Button>{!docs.length && <span className="ml-2 text-sm text-ink-subtle">Önce bu kural için kanıt yükleyin.</span>}</div>)}
            </li>
          );
        })}</ul>
        {evidence.filter((e) => !ruleOf(e.checkKey)).length > 0 && <p className="text-sm text-ink-subtle">Kural setinde karşılığı olmayan kanıt: {evidence.filter((e) => !ruleOf(e.checkKey)).map((e) => e.title).join(', ')}</p>}
        {canUpload && rules.length > 0 && (
          <form className={cn('grid grid-cols-2 gap-x-3 border-t border-border pt-3 max-[640px]:grid-cols-1')} onSubmit={(e) => { e.preventDefault(); void upload(); }}>
            <h3 className="col-span-full mb-2 text-base">Kanıt yükle</h3>
            <Field label="Kural">{(p) => <select className="input" {...p} value={up.checkKey} onChange={(e) => setUp({ ...up, checkKey: e.target.value })}>
              {rules.map((r) => <option key={r.code} value={keyOf(r)}>{r.code} · {r.name}</option>)}</select>}</Field>
            <Field label="Belge türü">{(p) => <select className="input" {...p} value={up.kind} onChange={(e) => setUp({ ...up, kind: e.target.value })}>
              {EVIDENCE_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
            <Field label="Başlık (isteğe bağlı)">{(p) => <input className="input" maxLength={200} {...p} value={up.title} onChange={(e) => setUp({ ...up, title: e.target.value })} />}</Field>
            <Field label="Dosya" hint="PDF, PNG ya da JPEG; en çok 25 MB.">{(p) => <input key={fileKey} className="input" type="file" required accept="application/pdf,image/png,image/jpeg" {...p}
              onChange={(e) => setUp({ ...up, file: e.target.files?.[0] ?? null })} />}</Field>
            <div className="col-span-full"><Button type="submit" size="sm" disabled={busy || !up.file || !up.checkKey}><Icon name="upload" />Kanıtı yükle</Button></div>
          </form>
        )}
        <div aria-live="polite">{msg && <Banner tone={msg.tone} title={msg.text} />}</div>
      </div>
    </section>
  );
}
