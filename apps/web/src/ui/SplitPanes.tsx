import { useEffect, useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const NARROW = '(max-width: 900px)';

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(NARROW).matches);
  useEffect(() => {
    const m = window.matchMedia(NARROW);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

/**
 * Belge + yan panel çalışma alanı. Geniş ekranda yan yana; dar ekranda (≤900px) "Belge / <yan panel>" sekmeleri — belge ve alanlar
 * alt alta uzun kaydırma yerine tek dokunuşla değişir. `docSignal` değiştiğinde (ör. "kaynağa git") belge sekmesi açılır.
 */
export function SplitPanes({ doc, side, docLabel, sideLabel, docSignal, initial = 'side' }: {
  doc: ReactNode; side: ReactNode; docLabel: string; sideLabel: string; docSignal?: unknown; initial?: 'doc' | 'side';
}) {
  const narrow = useNarrow();
  const [tab, setTab] = useState<'doc' | 'side'>(initial);
  const id = useId();
  useEffect(() => { if (docSignal !== undefined && docSignal !== null) setTab('doc'); }, [docSignal]);
  if (!narrow) {
    return (
      <div className="workspace">
        <section aria-label={docLabel} style={{ borderRight: '1px solid var(--border)' }}>{doc}</section>
        <aside aria-label={sideLabel} style={{ background: 'var(--surface)' }}>{side}</aside>
      </div>
    );
  }
  const tabs = [['doc', docLabel], ['side', sideLabel]] as const;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Görünüm" className="flex shrink-0 gap-6 border-b border-border bg-surface px-4">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" id={`${id}-${k}`} aria-controls={`${id}-${k}-panel`} aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn('-mb-px min-h-11 whitespace-nowrap border-b-2 font-semibold transition-colors duration-150', tab === k ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink')}>{l}</button>
        ))}
      </div>
      {/* İki panel de bağlı kalır (belge görüntüleyici yeniden yüklenmez, form durumu kaybolmaz); yalnız biri görünür. */}
      <section role="tabpanel" id={`${id}-doc-panel`} aria-labelledby={`${id}-doc`} hidden={tab !== 'doc'} className="min-h-0 flex-1 [&>.viewer]:h-[calc(100dvh-10rem)]">{doc}</section>
      <section role="tabpanel" id={`${id}-side-panel`} aria-labelledby={`${id}-side`} hidden={tab !== 'side'} className="min-h-0 flex-1 overflow-auto bg-surface">{side}</section>
    </div>
  );
}
