import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../lib/useApi.ts';
import { Empty, ErrorState, Loading, PageHeader } from '../ui/kit.tsx';

interface Hit { type: string; id: string; title: string; ref: string | null; matched: string; status: string | null }
const TYPE: Record<string, { label: string; href: (id: string) => string }> = {
  project: { label: 'Projeler', href: (id) => `/projeler/${id}` }, supplier: { label: 'Tedarikçiler', href: (id) => `/tedarikciler/${id}` },
  contract: { label: 'Sözleşmeler', href: (id) => `/sozlesmeler/${id}` },
  invoice: { label: 'Faturalar', href: (id) => `/faturalar/${id}` }, document: { label: 'Belgeler', href: (id) => `/belgeler/${id}` },
  incident: { label: 'Olaylar', href: (id) => `/tedarikciler/olaylar/${id}` },
};

/** Arama sonuçları: yalnız okuma izniniz olan türler ve şirket kapsamınızdaki kayıtlar; her sonuç neyle eşleştiğini gösterir. */
export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const r = useResource<{ query: string; groups: { type: string; items: Hit[] }[]; limitPerType: number }>(q.trim().length >= 2 ? `/api/v1/search?q=${encodeURIComponent(q)}` : null);
  // v2 (D93): siparişler kaldırma listesinde; tanınmayan (kaldırılan) türün sonuç grubu gösterilmez, ölü bağlantı kalmaz.
  const groups = (r.data?.groups ?? []).filter((g) => TYPE[g.type]);
  return (
    <div className="page">
      <PageHeader title={`“${q}” için sonuçlar`}>Yalnız erişiminiz olan kayıt türleri ve şirketler aranır. Tür başına en yeni {r.data?.limitPerType ?? 6} sonuç; daha fazlası için ilgili listede süzün.</PageHeader>
      {q.trim().length < 2 ? <Empty icon="info" title="Aramak için en az 2 karakter yazın" />
        : r.loading && !r.data ? <Loading rows={4} /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} />
        : !groups.length ? <Empty icon="info" title="Sonuç yok">Proje/sözleşme/fatura/belge/olay numarası, başlık, tedarikçi ünvanı veya tam vergi kimliğiyle arayın.</Empty>
        : groups.map((g) => (
          <section key={g.type} className="panel mb-4">
            <div className="panel-head"><h2>{TYPE[g.type]?.label ?? g.type}</h2></div>
            <ul className="divide-y divide-border">
              {g.items.map((x) => (
                <li key={x.id} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2.5">
                  <Link to={TYPE[g.type]!.href(x.id)} className="font-semibold">{x.ref ? <span className="tabular mr-2">{x.ref}</span> : null}{x.title}</Link>
                  <span className="text-sm text-ink-subtle">eşleşme: {x.matched}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
