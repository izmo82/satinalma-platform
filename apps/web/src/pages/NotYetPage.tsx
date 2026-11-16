import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Empty, PageHeader } from '../ui/kit.tsx';
import { Button } from '@/components/ui/button';

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

/**
 * v2 (D93): onaylı kaldırma listesindeki ekranın eski adresi (yer imi, bildirim, görev bağlantısı). "Sayfa bulunamadı" yerine
 * işlevin kaldırıldığı ve verinin durduğu söylenir; taşınan bir parçası varsa yeni yeri gösterilir.
 */
export function RemovedPage({ moved }: { moved?: ReactNode }) {
  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <PageHeader title="Bu işlev kaldırıldı">
        Bu işlev v2 sadeleştirmesinde kaldırıldı. Kayıtlar silinmedi; geçmiş veriler denetim izinde ve dışa aktarımda durur.
      </PageHeader>
      {moved && <p className="mb-4 max-w-[75ch]">{moved}</p>}
      <Button variant="outline" asChild><Link to="/islerim">İşlerim'e dön</Link></Button>
    </div>
  );
}
