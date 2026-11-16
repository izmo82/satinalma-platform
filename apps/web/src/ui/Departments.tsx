import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSession } from '../lib/session.tsx';
import { useResource } from '../lib/useApi.ts';
import { Field, FilterChip } from './kit.tsx';

/**
 * v2 Faz 1 (D93): departman seçimi ve süzgeci. Tüm departmanı gören roller (Yönetici, Satınalma, Denetçi) kurumun bütün
 * departmanlarını, departman kullanıcısı yalnız kendi departmanlarını görür (RLS de aynı sınırı uygular).
 */
export type Department = { id: string; name: string };

export function useDepartments(): { items: Department[]; loading: boolean } {
  const { me } = useSession();
  const all = useResource<{ items: Department[] }>(me?.allDepartments ? `/api/v1/departments?t=${me.activeTenantId}` : null);
  if (!me?.allDepartments) return { items: me?.departments ?? [], loading: false };
  return { items: all.data?.items ?? [], loading: all.loading };
}

/** Liste süzgeci URL'de (`?departmentId=`): yeniden yüklemede ve paylaşılan bağlantıda korunur. */
export function useDepartmentParam(): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get('departmentId') ?? '';
  const set = (v: string) => { const p = new URLSearchParams(params); v ? p.set('departmentId', v) : p.delete('departmentId'); setParams(p, { replace: true }); };
  return [value, set];
}

/** API yoluna departman süzgecini ekler (sunucu süzer; sayfalı listede de doğru). */
export const withDepartment = (path: string, departmentId: string) =>
  departmentId ? `${path}${path.includes('?') ? '&' : '?'}departmentId=${encodeURIComponent(departmentId)}` : path;

/** Altı departmana kadar çip satırı, fazlası için seçim kutusu. Tek seçenek varsa süzgeç gösterilmez. */
export function DepartmentFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { items } = useDepartments();
  if (items.length < 2 && !value) return null;
  if (items.length > 6) {
    return (
      <label className="flex items-center gap-2 text-sm">Departman
        <select className="input h-8 w-auto min-w-40" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Tümü</option>{items.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
    );
  }
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Departman süzgeci">
      <FilterChip pressed={!value} onClick={() => onChange('')}>Tüm departmanlar</FilterChip>
      {items.map((d) => <FilterChip key={d.id} pressed={value === d.id} onClick={() => onChange(d.id)}>{d.name}</FilterChip>)}
    </div>
  );
}

/** Tablo hücresi: departman adı; departmansız (eski) kayıt soluk metinle yazılır. */
export function DepartmentName({ name }: { name: string | null | undefined }) {
  return name ? <>{name}</> : <span className="text-ink-subtle">Departmansız</span>;
}

/**
 * Oluşturma formlarında departman seçimi: her rol için zorunlu (API tüm departmanı görenlere boş bırakma izni verse de form
 * istemez). Tek seçenek varsa önceden seçili gelir (çağıran `value` boşken ilk değeri atar).
 */
export function DepartmentSelect({ value, onChange, error, id }: { value: string; onChange: (v: string) => void; error?: string | null; id?: string }) {
  const { items, loading } = useDepartments();
  const only = items.length === 1 ? items[0]!.id : '';
  // Tek seçenek önceden seçilir; seçilmiş değer artık listede yoksa (ör. eski taslak, departman değişti) boşaltılır.
  useEffect(() => {
    if (loading) return;
    if (only && value !== only) onChange(only);
    else if (value && !items.some((d) => d.id === value)) onChange('');
  }, [only, value, items, loading, onChange]);
  return (
    <Field id={id} label="Departman" error={error ?? (!loading && !items.length ? 'Size atanmış departman yok; yöneticinizden departman ataması isteyin.' : null)}
      hint={items.length === 1 ? 'Kayıt departmanınıza açılır.' : 'Kaydı bu departmanın kullanıcıları görür.'}>
      {(p) => <select className="input" required {...p} value={value} onChange={(e) => onChange(e.target.value)}>
        {items.length !== 1 && <option value="">Seçin</option>}
        {items.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>}
    </Field>
  );
}
