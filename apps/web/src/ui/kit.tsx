import { useEffect, useId, useReducer, type ReactNode } from 'react';
import { Icon } from './icons.tsx';
import type { Label, Tone } from '../lib/labels.ts';
import { ApiError } from '../lib/api.ts';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Kökene göre mürekkep: insan kararı mor ıstampa, kural yeşil çerçeve, AI kesik gri; diğer durumlar düz zemin. */
export const toneClass: Record<Tone, string> = {
  human: 'border-[1.5px] border-istampa text-istampa bg-istampa-soft font-bold -rotate-[1.5deg]',
  ok: 'border-[1.5px] border-verified text-verified bg-verified-soft',
  ai: 'border-[1.5px] border-dashed border-ai text-ai bg-transparent',
  warn: 'border border-transparent bg-warn-soft text-warn',
  danger: 'border border-transparent bg-danger-soft text-danger',
  info: 'border border-transparent bg-info-soft text-info',
  neutral: 'border border-transparent bg-sunken text-ink-muted',
};

export function Tag({ label, title, className }: { label: Label | undefined; title?: string; className?: string }) {
  if (!label) return null;
  return (
    <span title={title ?? label.hint}
      className={cn('inline-flex items-center gap-1.5 rounded-sm px-2 py-px text-[0.8125rem] leading-5 font-semibold whitespace-nowrap', toneClass[label.tone], className)}>
      <Icon name={label.icon} size={14} />
      {label.text}
    </span>
  );
}

const bannerTone: Record<Exclude<Tone, 'ok' | 'ai' | 'human'>, string> = {
  info: 'bg-info-soft border-[#cfd5e2]',
  warn: 'bg-warn-soft border-[#e8d29c]',
  danger: 'bg-danger-soft border-[#e5b9b0]',
  neutral: 'bg-sunken border-border',
};
const bannerIcon = { danger: 'x', warn: 'alert', info: 'info', neutral: 'info' } as const;

export function Banner({ tone, icon, title, children, action }: { tone: Exclude<Tone, 'ok' | 'ai' | 'human'>; icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('mb-4 flex items-start gap-3 rounded-md border px-4 py-3 text-ink', bannerTone[tone])}>
      <Icon name={icon ?? bannerIcon[tone]} size={18} className={cn('mt-0.5 shrink-0', tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-info')} />
      <div className="min-w-0 flex-1"><strong className="block font-semibold">{title}</strong>{children && <div className="mt-0.5 text-ink-muted">{children}</div>}</div>
      {action}
    </div>
  );
}

export function Loading({ rows = 4, label = 'Yükleniyor' }: { rows?: number; label?: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="grid gap-2.5 p-4">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-3.5 bg-sunken" style={{ width: `${90 - i * 12}%` }} />)}
    </div>
  );
}

export function Empty({ icon = 'inbox', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-2 px-6 py-12 text-center text-ink-muted">
      <Icon name={icon} size={28} className="text-ink-subtle" />
      <h3 className="text-base text-ink">{title}</h3>
      {children && <p className="max-w-[60ch]">{children}</p>}
    </div>
  );
}

/** Hata türüne göre ayrı durum: yetki, bulunamadı, ağ, çatışma, kota, genel. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error instanceof ApiError ? error : new ApiError(0, 'unknown', 'Beklenmeyen bir hata oluştu.');
  const map: Record<number, { icon: string; title: string }> = {
    0: { icon: 'wifiOff', title: 'Bağlantı yok' },
    401: { icon: 'lock', title: 'Oturum gerekli' },
    403: { icon: 'lock', title: 'Bu işlem için yetkiniz yok' },
    404: { icon: 'help', title: 'Kayıt bulunamadı veya erişim yetkiniz yok' },
    409: { icon: 'refresh', title: 'Kayıt siz çalışırken değişti' },
    423: { icon: 'shield', title: 'Belge karantinada' },
    429: { icon: 'clock', title: 'Kota veya hız sınırı doldu' },
  };
  const m = map[e.status] ?? { icon: 'alert', title: 'İşlem tamamlanamadı' };
  return (
    <div role="alert" className="grid justify-items-center gap-2 px-6 py-12 text-center text-ink-muted">
      <Icon name={m.icon} size={28} className="text-ink-subtle" />
      <h3 className="text-base text-ink">{m.title}</h3>
      {/* K2: başlıkla aynı cümle tekrar edilmez; bulunamayan/erişilemeyen kayıtta olası nedenler ve dönüş yolu yazılır. */}
      <p className="max-w-[60ch]">{e.status === 404 && e.message.replace(/\.$/, '') === m.title
        ? 'Kayıt başka bir kuruma ya da departmana ait olabilir veya kaldırılmış olabilir. Listeye dönüp yeniden arayın; erişim gerekiyorsa yöneticinize başvurun.'
        : e.message}</p>
      {e.status === 404 && <a className="text-sm underline" href="/islerim">İşlerim'e dön</a>}
      {onRetry && <Button variant="outline" onClick={onRetry} className="mt-2"><Icon name="refresh" /> Yeniden dene</Button>}
    </div>
  );
}

export function Field({ label, hint, error, children, id }: { label: string; hint?: string; error?: string | null; children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  const hintId = hint ? `${fid}-hint` : undefined;
  const errId = error ? `${fid}-err` : undefined;
  return (
    <div className="field">
      <label htmlFor={fid}>{label}</label>
      {children({ id: fid, 'aria-describedby': [hintId, errId].filter(Boolean).join(' ') || undefined, 'aria-invalid': error ? true : undefined })}
      {hint && <span id={hintId} className="hint">{hint}</span>}
      {error && <span id={errId} className="error"><Icon name="alert" size={14} />{error}</span>}
    </div>
  );
}

/** Kısa inceleme yan paneli (Radix: odak tuzağı, Escape, odağın geri dönüşü). İç içe açılmaz. */
export function Drawer({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full gap-0 border-l border-border bg-surface p-0 sm:max-w-[480px]">
        <SheetHeader className="border-b border-border px-4 py-3.5">
          <SheetTitle className="pr-8 text-lg text-ink">{title}</SheetTitle>
          <SheetDescription className="sr-only">{title}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-auto p-4">{children}</div>
        {footer && <SheetFooter className="flex-row justify-end gap-2 border-t border-border px-4 py-3">{footer}</SheetFooter>}
      </SheetContent>
    </Sheet>
  );
}

/** Dar ve odaklı karar için tek seviyeli diyalog. */
export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="gap-0 bg-surface p-0 sm:max-w-[520px]" showCloseButton={false}>
        <DialogHeader className="border-b border-border px-4 py-3.5"><DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription></DialogHeader>
        <div className="max-h-[60vh] overflow-auto p-4">{children}</div>
        <DialogFooter className="border-t border-border px-4 py-3">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function useOnline() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    window.addEventListener('online', force); window.addEventListener('offline', force);
    return () => { window.removeEventListener('online', force); window.removeEventListener('offline', force); };
  }, []);
  return navigator.onLine;
}

/** Sayfa başlığı: başlık, açıklama ve sağda eylemler. */
export function PageHeader({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-4">
      <div className="min-w-[240px] flex-1">
        <h1>{title}</h1>
        {children && <p className="mt-1 max-w-[75ch] text-ink-muted">{children}</p>}
      </div>
      {actions}
    </div>
  );
}

/** Filtre çipi: basılı durum mürekkep zeminle; sayı tabular. */
export function FilterChip({ pressed, onClick, children, count }: { pressed: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick}
      className={cn('inline-flex min-h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-semibold transition-colors duration-150',
        pressed ? 'border-ink bg-ink text-primary-foreground' : 'border-input bg-surface text-ink hover:bg-sunken')}>
      {children}{count !== undefined && <span className={cn('tabular', pressed ? 'text-[#cfd2db]' : 'text-ink-subtle')}>{count}</span>}
    </button>
  );
}
