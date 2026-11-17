// v2 Faz 2 (D105): Entra dizini alan kuralları. Saf işlevler; veritabanı ve ağ yok.

export type ApproverKind = 'DEPARTMENT_HEAD' | 'PROCUREMENT_LEAD' | 'PROCUREMENT_DIRECTOR';

// Boşluk kümesi açıktır ve SQL sp_normalize_department_name (042) ile birebir aynıdır: \t \n \v \f \r, boşluk, U+00A0, U+2000-U+200B, U+3000, U+FEFF.
const NAME_SPACE = /[\t\n\v\f\r \u00A0\u2000-\u200B\u3000\uFEFF]+/g;

/** Departman adı karşılaştırma anahtarı: boşlukları teke indir, kırp, tr-TR küçült. */
export function normalizeDepartmentName(name: string): string {
  return name.replace(NAME_SPACE, ' ').replace(/^ | $/g, '').toLocaleLowerCase('tr-TR');
}

/** OU_FILTER kapsamı: DN, ouSuffix ile virgül sınırında biter (büyük/küçük harf duyarsız). */
export function inScope(user: { onPremisesDistinguishedName: string | null }, ouSuffix: string): boolean {
  // Virgül çevresindeki boşluk yok sayılır (`OU=Satış, DC=örnek` = `OU=Satış,DC=örnek`); hem DN'de hem yapılandırılan sonekte.
  const norm = (v: string) => v.trim().replace(/\s*,\s*/g, ',').toLowerCase();
  const dn = user.onPremisesDistinguishedName ? norm(user.onPremisesDistinguishedName) : '';
  const suffix = norm(ouSuffix);
  if (!dn || !suffix) return false;
  if (dn === suffix) return true;
  return dn.endsWith(',' + suffix);
}

/** R4: eski dizin departmanı çıkar, yenisi ekle; elle eklenenler ve sıra korunur, yineleme yok. */
export function planMembershipDepartments(current: string[], oldDirectory: string | null, newDirectory: string | null): string[] {
  const out: string[] = [];
  for (const id of current) if ((id !== oldDirectory || id === newDirectory) && !out.includes(id)) out.push(id);
  if (newDirectory && !out.includes(newDirectory)) out.push(newDirectory);
  return out;
}

/** Onaycı ataması doğrulaması; hata iletisi (Türkçe) ya da null. */
export function validateApprover(
  a: { kind: ApproverKind; departmentId: string | null; primaryUserId: string | null; deputyUserId: string | null },
  activeUserIds: Set<string>,
): string | null {
  if (a.kind === 'DEPARTMENT_HEAD' && !a.departmentId) return 'Bölüm sorumlusu için departman seçilmelidir.';
  if (a.kind !== 'DEPARTMENT_HEAD' && a.departmentId) return 'Bu unvan departmana bağlı değildir.';
  if (a.primaryUserId && a.primaryUserId === a.deputyUserId) return 'Asıl onaycı ile vekil aynı kişi olamaz.';
  if (a.primaryUserId && !activeUserIds.has(a.primaryUserId)) return 'Asıl onaycı etkin bir kullanıcı olmalıdır.';
  if (a.deputyUserId && !activeUserIds.has(a.deputyUserId)) return 'Vekil etkin bir kullanıcı olmalıdır.';
  return null;
}
