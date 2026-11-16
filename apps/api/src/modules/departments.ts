import { normalizeRoles } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, notFound, unprocessable } from '../errors.ts';

/**
 * v2 Faz 1 (D93, analiz-v2 §2.3): departmanlar. Kayıt (proje, sözleşme, değerlendirme) departman taşır; bölüm kullanıcısı yalnız
 * kendi departmanlarının kaydını görür (RLS). Fatura departmanını eşleştiği sözleşmeden devralır (invoices.ts).
 */

export interface Department { id: string; name: string }

export async function listDepartments(tx: Tx): Promise<Department[]> {
  return (await tx.query<Department>(`SELECT id, name FROM departments ORDER BY name, id`)).rows;
}

export async function createDepartment(tx: Tx, ctx: TenantContext, b: { name: string }): Promise<Department> {
  const name = b.name.trim();
  if (!name) throw unprocessable('invalid_name', 'Departman adı gerekli.');
  // Aynı ad: benzersizlik kısıtı 409 duplicate döner.
  const d = (await tx.query<Department>(`INSERT INTO departments (tenant_id, name) VALUES ($1, $2) RETURNING id, name`, [ctx.tenantId, name])).rows[0]!;
  await audit(tx, ctx, 'department.created', 'department', d.id, { name });
  return d;
}

/** Kiracıdaki departmanlar; listede kiracı dışı ya da olmayan kimlik varsa 422 (RLS başka kiracının departmanını göstermez). */
async function assertKnown(tx: Tx, ids: string[]) {
  if (!ids.length) return;
  const n = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM departments WHERE id = ANY($1::uuid[])`, [ids])).rows[0]!.n;
  if (n !== ids.length) throw unprocessable('department_unknown', 'Seçilen departman bu kurumda tanımlı değil.');
}

/** Üyeliğin departmanları (yalnız Yönetici). Yalnız çağıranın kiracısındaki üyelik değişir; yalnız department_ids sütunu. */
export async function setMembershipDepartments(tx: Tx, ctx: TenantContext, userId: string, b: { departmentIds: string[] }) {
  const ids = [...new Set(b.departmentIds)];
  await assertKnown(tx, ids);
  const before = (await tx.query<{ department_ids: string[] }>(
    `SELECT department_ids FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [ctx.tenantId, userId])).rows[0];
  if (!before) throw notFound();
  await tx.query(`UPDATE memberships SET department_ids = $3 WHERE tenant_id = $1 AND user_id = $2`, [ctx.tenantId, userId, ids]);
  await audit(tx, ctx, 'membership.departments.set', 'user', userId, { before: before.department_ids, after: ids });
  return { userId, departmentIds: ids };
}

/**
 * Oluşturmada departman: bölüm kullanıcısı (tüm departmanları görmeyen) için zorunlu ve kendi departmanlarından biri; tüm
 * departmanı görenler için isteğe bağlı (boş = departmansız; yalnız tüm departmanı görenlere görünür). Verilirse kiracıda olmalı.
 */
export async function resolveDepartment(tx: Tx, ctx: TenantContext, departmentId: string | null | undefined): Promise<string | null> {
  if (!departmentId) {
    if (ctx.allDepartments) return null;
    throw unprocessable('department_required', 'Departman seçilmeli.');
  }
  if (!ctx.allDepartments && !ctx.departmentIds.includes(departmentId)) {
    throw new ApiError(403, 'department_forbidden', 'Yalnız kendi departmanınız için kayıt açabilirsiniz.');
  }
  await assertKnown(tx, [departmentId]);
  return departmentId;
}

export interface MemberRow { userId: string; displayName: string; email: string; roles: string[]; departmentIds: string[] }

/**
 * Kiracının iç kullanıcıları ve departmanları (yalnız Yönetici; Yönetim > Kullanıcılar ve Entra). Tedarikçi portalı üyelikleri
 * listelenmez (departmanları yoktur, atama sunulmaz). Roller v2'ye normalize edilir. RLS: memberships kiracıya, users aynı kiracıya.
 */
export async function listMemberships(tx: Tx, ctx: TenantContext): Promise<MemberRow[]> {
  const r = await tx.query<{ userId: string; displayName: string; email: string; roles: string[]; departmentIds: string[] }>(
    `SELECT m.user_id AS "userId", u.display_name AS "displayName", u.email, m.roles, m.department_ids AS "departmentIds"
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND m.supplier_id IS NULL ORDER BY u.display_name, u.id`, [ctx.tenantId]);
  return r.rows.map((x) => ({ ...x, roles: normalizeRoles(x.roles) })).filter((x) => x.roles.length > 0 && !x.roles.includes('SUPPLIER'));
}

/** Aktif üyeliğin departmanları (/me). */
export async function departmentsOf(tx: Tx, ids: string[]): Promise<Department[]> {
  if (!ids.length) return [];
  return (await tx.query<Department>(`SELECT id, name FROM departments WHERE id = ANY($1::uuid[]) ORDER BY name, id`, [ids])).rows;
}
