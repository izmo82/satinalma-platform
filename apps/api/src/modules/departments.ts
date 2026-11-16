import { normalizeRoles } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, notFound, unprocessable } from '../errors.ts';
import { rederiveTaskDepartments } from '../tasks.ts';
import { inheritDepartment } from './invoices.ts';

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
export async function assertKnown(tx: Tx, ids: string[]) {
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

// --- Departmansız kayıtlara departman atama (düzeltme dalgası C1, D96) -----------------------------------------------------

export type AssignableEntity = 'project' | 'contract_family' | 'supplier_assessment';
const ASSIGN_TABLE: Record<AssignableEntity, string> = { project: 'projects', contract_family: 'contract_families', supplier_assessment: 'supplier_assessments' };

/**
 * Proje, sözleşme ailesi veya tedarikçi değerlendirmesine departman atar (tekli ya da toplu; Yönetici ve Satınalma). Kayıtlar
 * çağıranın görebildiği (RLS) kayıtlar olmalı; biri görünmüyorsa hiçbiri değişmez (404). Her kayıt için `department.assigned`
 * denetim olayı. Aynı işlemde bağlı görevlerin departmanı yeniden türetilir; sözleşme ailesinde ona tahsisli faturalar
 * departmanı yeniden devralır (fatura → sözleşme kuralı, invoices.ts) ve onların görevleri de izler.
 */
export async function assignDepartment(tx: Tx, ctx: TenantContext, b: { entityType: AssignableEntity; ids: string[]; departmentId: string }) {
  const table = ASSIGN_TABLE[b.entityType];
  if (!table) throw unprocessable('invalid_entity_type', 'Departman yalnız proje, sözleşme veya değerlendirmeye atanır.');
  const ids = [...new Set(b.ids)];
  if (!ids.length) throw unprocessable('ids_required', 'En az bir kayıt seçilmeli.');
  await assertKnown(tx, [b.departmentId]);
  const rows = (await tx.query<{ id: string; department_id: string | null }>(
    `SELECT id, department_id FROM ${table} WHERE id = ANY($1::uuid[]) FOR UPDATE`, [ids])).rows;
  if (rows.length !== ids.length) throw notFound();
  await tx.query(`UPDATE ${table} SET department_id = $2 WHERE id = ANY($1::uuid[])`, [ids, b.departmentId]);
  for (const r of rows) {
    await audit(tx, ctx, 'department.assigned', b.entityType, r.id, { entityType: b.entityType, before: r.department_id, after: b.departmentId });
  }
  let tasks = 0;
  if (b.entityType === 'project') {
    tasks += await rederiveTaskDepartments(tx, `(t.entity_type = 'project' AND t.entity_id = ANY($1::uuid[]))
      OR (t.entity_type = 'rfq_round' AND t.entity_id IN (SELECT id FROM rfq_rounds WHERE project_id = ANY($1::uuid[])))
      OR (t.entity_type = 'award' AND t.entity_id IN (SELECT id FROM awards WHERE project_id = ANY($1::uuid[])))
      OR (t.entity_type = 'evaluation' AND t.entity_id IN (SELECT id FROM evaluations WHERE project_id = ANY($1::uuid[])))
      OR (t.entity_type = 'sourcing_exception' AND t.entity_id IN (SELECT id FROM sourcing_exceptions WHERE project_id = ANY($1::uuid[])))`, [ids]);
  } else if (b.entityType === 'contract_family') {
    const invoices = (await tx.query<{ id: string }>(`SELECT DISTINCT a.invoice_id AS id FROM invoice_allocations a
        LEFT JOIN po_lines pl ON pl.id = a.po_line_id LEFT JOIN purchase_orders po ON po.id = pl.po_id
        JOIN contract_versions cv ON cv.id = coalesce(a.contract_version_id, po.contract_version_id)
      WHERE cv.family_id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.id);
    for (const inv of invoices) await inheritDepartment(tx, inv);
    tasks += await rederiveTaskDepartments(tx, `(t.entity_type = 'contract_family' AND t.entity_id = ANY($1::uuid[]))
      OR (t.entity_type = 'contract_version' AND t.entity_id IN (SELECT id FROM contract_versions WHERE family_id = ANY($1::uuid[])))
      OR (t.entity_type = 'incident' AND t.entity_id IN (SELECT i.id FROM supplier_incidents i JOIN contract_versions cv ON cv.id = i.contract_version_id WHERE cv.family_id = ANY($1::uuid[])))
      OR (t.entity_type = 'invoice' AND t.entity_id = ANY($2::uuid[]))`, [ids, invoices]);
  } else {
    tasks += await rederiveTaskDepartments(tx, `t.entity_type = 'supplier_assessment' AND t.entity_id = ANY($1::uuid[])`, [ids]);
    // Kritik engel görevleri tedarikçiye bağlıdır; departmanı değerlendirmeden gelir (tekil anahtar assessment-blocker:<id>:<rol>).
    tasks += (await tx.query(`UPDATE tasks t SET department_id = $2 WHERE t.kind = 'assessment_blocker' AND split_part(t.dedupe_key, ':', 2) = ANY($1::text[])
      AND t.department_id IS DISTINCT FROM $2`, [ids, b.departmentId])).rowCount ?? 0;
  }
  return { updated: rows.length, tasksUpdated: tasks };
}

/**
 * Departmanı atanmamış kayıtlar (Yönetim > Kullanıcılar ve Entra > Departmansız kayıtlar). RLS: çağıranın şirket kapsamı.
 * Yönetici'nin şirket kapsamı yoksa proje ve sözleşmeler boş döner (`companyScopeEmpty`); kapsam kullanıcı kararıdır, değiştirilmez.
 */
export async function listUnassigned(tx: Tx, ctx: TenantContext) {
  const projects = (await tx.query(`SELECT p.id, p.code, p.title, p.status, le.name AS "companyName", p.created_at AS "createdAt"
    FROM projects p LEFT JOIN legal_entities le ON le.id = p.company_id WHERE p.department_id IS NULL ORDER BY p.created_at DESC, p.id LIMIT 500`)).rows;
  const contracts = (await tx.query(`SELECT f.id, f.code, f.title, le.name AS "companyName", s.legal_name AS "supplierName", f.created_at AS "createdAt"
    FROM contract_families f LEFT JOIN legal_entities le ON le.id = f.company_id LEFT JOIN suppliers s ON s.id = f.supplier_id
    WHERE f.department_id IS NULL ORDER BY f.created_at DESC, f.id LIMIT 500`)).rows;
  const assessments = (await tx.query(`SELECT a.id, s.legal_name AS "supplierName", t.name AS "templateName", a.scope, a.status, a.created_at AS "createdAt"
    FROM supplier_assessments a JOIN suppliers s ON s.id = a.supplier_id JOIN questionnaire_templates t ON t.id = a.template_id
    WHERE a.department_id IS NULL ORDER BY a.created_at DESC, a.id LIMIT 500`)).rows;
  return { projects, contracts, assessments, companyScopeEmpty: ctx.companyIds.length === 0 };
}
