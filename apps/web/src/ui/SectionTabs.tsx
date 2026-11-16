import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * Adrese bağlı alt çizgili sekmeler (DESIGN.md "Tabs": 40px, yarı kalın, etkin sekmede 2px mürekkep çizgi; hap biçimi yok).
 * Her sekme kendi adresidir: yer imi, geri tuşu ve menüden gelen bağlantı aynı sekmeyi açar. Dar ekranda yatay kayar.
 */
export function SectionTabs({ label, tabs }: { label: string; tabs: { to: string; label: string; end?: boolean }[] }) {
  return (
    <nav aria-label={label} className="shrink-0 bg-surface">
      <ul className="flex gap-6 overflow-x-auto border-b border-border px-8 max-[900px]:px-4">
        {tabs.map((t) => (
          <li key={t.to} className="shrink-0">
            <NavLink to={t.to} end={t.end} className={({ isActive }) => cn(
              '-mb-px flex min-h-10 items-center whitespace-nowrap border-b-2 font-semibold no-underline transition-colors duration-150',
              isActive ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink')}>{t.label}</NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
