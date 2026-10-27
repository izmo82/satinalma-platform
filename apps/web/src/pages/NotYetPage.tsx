import { Empty, PageHeader } from '../ui/kit.tsx';

export function NotYetPage({ title, phase, what }: { title: string; phase?: string; what?: string }) {
  return (
    <div className="page">
      <PageHeader title={title} />
      <div className="rounded-md border border-border bg-surface">
        <Empty icon="folder" title={phase ? `Bu modül henüz uygulanmadı (${phase})` : 'Aradığınız sayfa yok'}>
          {what ? `${what}. Uygulama planı: docs/implementation-status.md.` : 'Sol menüden devam edin.'}
        </Empty>
      </div>
    </div>
  );
}
