import { normalizeRoles, validateApprover } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { unprocessable } from '../errors.ts';

/**
 * v2 Faz 2 (D105, analiz-v2 §2.3, §3.7) Görev 5: onaycı ataması (bölüm sorumlusu + vekil, satınalma sorumlusu + vekil (R2),
 * satınalma direktörü + vekil). Adaylar yalnız bu kiracının etkin, tedarikçi olmayan üyelikleridir (kullanıcı FK'leri kiracıya bağlı değildir).
 */

export type Person = { userId: string; displayName: string; email: string; active: boolean; wrongRole?: boolean };

/** D107 (kullanıcı kararı 17.11.2026): onaycı yalnız Satınalma ya da Departman kullanıcısı rolündeki kişilerden seçilir. */
const APPROVER_ROLES = ['PROCUREMENT', 'DEPARTMENT_USER'];
export type ApproverStatus = 'DEFINED' | 'NO_DEPUTY' | 'UNASSIGNED' | 'INACTIVE';
export type OrgInput = { leadUserId?: string | null; leadDeputyUserId?: string | null; directorUserId?: string | null; directorDeputyUserId?: string | null };
export type DeptInput = { departmentId: string; headUserId: string | null; deputyUserId: string | null };

type Kind = 'DEPARTMENT_HEAD' | 'PROCUREMENT_LEAD' | 'PROCUREMENT_DIRECTOR';
type Row = { kind: Kind; department_id: string | null; primary_user_id: string | null; deputy_user_id: string | null };

/**
 * Kiracıdaki iç (tedarikçi olmayan) üyelikler; tedarikçi rolü taşıyanlar dışarıda. Rolü kalmamış (dizin rolü kaldırınca roles='{}'),
 * askıdaki ya da kaldırılmış üyelikler `active:false` kişi olarak döner: atanmış kişi "Atanmadı" değil "(pasif)" görünür ve kayıt korunur.
 */
async function loadPeople(tx: Tx): Promise<Map<string, Person>> {
  const rows = (await tx.query<{ id: string; display_name: string; email: string; status: string; roles: string[] }>(
    `SELECT u.id, u.display_name, u.email, m.status, m.roles FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.supplier_id IS NULL ORDER BY u.display_name, u.id`)).rows;
  const map = new Map<string, Person>();
  for (const r of rows) {
    const roles = normalizeRoles(r.roles);
    if (roles.includes('SUPPLIER')) continue;
    // Onaycılık için etkin = üyelik etkin ve Satınalma ya da Departman kullanıcısı rolü var (D107); rolü düşen atanmış kişi "(pasif)" görünür.
    map.set(r.id, { userId: r.id, displayName: r.display_name, email: r.email, active: r.status === 'ACTIVE' && roles.some((x) => APPROVER_ROLES.includes(x)),
      wrongRole: r.status === 'ACTIVE' && roles.length > 0 && !roles.some((x) => APPROVER_ROLES.includes(x)) });
  }
  return map;
}

async function loadRows(tx: Tx): Promise<Row[]> {
  return (await tx.query<Row>(`SELECT kind, department_id, primary_user_id, deputy_user_id FROM approver_assignments`)).rows;
}

// Yanıtta iç alan (wrongRole) dönmez.
const pub = (p: Person): Person => ({ userId: p.userId, displayName: p.displayName, email: p.email, active: p.active });
const personOf = (people: Map<string, Person>, id: string | null): Person | null => { const p = id ? people.get(id) : undefined; return p ? pub(p) : null; };
const activeOf = (people: Map<string, Person>, id: string | null): Person | null => {
  const p = personOf(people, id);
  return p && p.active ? p : null;
};

/** Departman başına öneri: o departmanın kapsamdaki etkin dizin kullanıcılarının en sık geçen yöneticisi (etkin üyelikli); eşitlikte ada göre ilk. */
async function suggestions(tx: Tx, people: Map<string, Person>): Promise<Map<string, Person>> {
  const rows = (await tx.query<{ department_id: string; manager_object_id: string }>(
    `SELECT department_id, manager_object_id FROM directory_users
     WHERE in_scope AND account_enabled AND department_id IS NOT NULL AND manager_object_id IS NOT NULL`)).rows;
  const mgr = (await tx.query<{ entra_object_id: string; user_id: string }>(
    `SELECT entra_object_id, user_id FROM directory_users WHERE user_id IS NOT NULL`)).rows;
  const byObject = new Map(mgr.map((m) => [m.entra_object_id, m.user_id]));
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const uid = byObject.get(r.manager_object_id);
    const p = uid ? activeOf(people, uid) : null;
    if (!p) continue;
    const c = counts.get(r.department_id) ?? new Map<string, number>();
    c.set(p.userId, (c.get(p.userId) ?? 0) + 1);
    counts.set(r.department_id, c);
  }
  const out = new Map<string, Person>();
  for (const [dept, c] of counts) {
    const best = [...c.entries()].map(([id, n]) => ({ p: people.get(id)!, n }))
      .sort((a, b) => b.n - a.n || a.p.displayName.localeCompare(b.p.displayName, 'tr-TR') || a.p.userId.localeCompare(b.p.userId))[0];
    if (best) out.set(dept, best.p);
  }
  return out;
}

export async function listApprovers(tx: Tx) {
  const people = await loadPeople(tx);
  const rows = await loadRows(tx);
  const org = (kind: Kind) => rows.find((r) => r.kind === kind) ?? null;
  const lead = org('PROCUREMENT_LEAD');
  const director = org('PROCUREMENT_DIRECTOR');
  const heads = new Map(rows.filter((r) => r.kind === 'DEPARTMENT_HEAD').map((r) => [r.department_id!, r]));
  const depts = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM departments WHERE merged_into IS NULL ORDER BY name, id`)).rows;
  const sugg = await suggestions(tx, people);
  const departments = depts.map((d) => {
    const row = heads.get(d.id);
    const head = personOf(people, row?.primary_user_id ?? null);
    const deputy = personOf(people, row?.deputy_user_id ?? null);
    let status: ApproverStatus;
    if (!row?.primary_user_id) status = 'UNASSIGNED';
    else if (!head || !head.active) status = 'INACTIVE';
    else if (!deputy || !deputy.active) status = 'NO_DEPUTY';
    else status = 'DEFINED';
    return { departmentId: d.id, departmentName: d.name, head, deputy, status, suggestion: sugg.get(d.id) ?? null };
  });
  return {
    organization: {
      lead: personOf(people, lead?.primary_user_id ?? null), leadDeputy: personOf(people, lead?.deputy_user_id ?? null),
      director: personOf(people, director?.primary_user_id ?? null), directorDeputy: personOf(people, director?.deputy_user_id ?? null),
    },
    departments,
    candidates: [...people.values()].filter((p) => p.active).map(pub),
  };
}

/** Faz 3 için: bir departmanın güncel onaycıları; yalnız etkin kişiler (askıdaki kişi null). */
export async function currentApprovers(tx: Tx, departmentId: string) {
  const people = await loadPeople(tx);
  const rows = await loadRows(tx);
  const head = rows.find((r) => r.kind === 'DEPARTMENT_HEAD' && r.department_id === departmentId) ?? null;
  const lead = rows.find((r) => r.kind === 'PROCUREMENT_LEAD') ?? null;
  const director = rows.find((r) => r.kind === 'PROCUREMENT_DIRECTOR') ?? null;
  return {
    head: activeOf(people, head?.primary_user_id ?? null), deputy: activeOf(people, head?.deputy_user_id ?? null),
    lead: activeOf(people, lead?.primary_user_id ?? null), leadDeputy: activeOf(people, lead?.deputy_user_id ?? null),
    director: activeOf(people, director?.primary_user_id ?? null), directorDeputy: activeOf(people, director?.deputy_user_id ?? null),
  };
}

/**
 * Tek işlemde tam değiştirme: gönderilen satırlar yazılır, payload'da olmayan departmanlar değişmez; iki kimliği de boş satır atamayı temizler.
 * `organization` verilirse iki unvan (sorumlu, direktör) tümüyle değişir; eksik alan boş sayılır.
 */
export async function setApprovers(tx: Tx, ctx: TenantContext, b: { organization?: OrgInput; departments?: DeptInput[] }) {
  const people = await loadPeople(tx);
  const candidates = new Set([...people.values()].filter((p) => p.active).map((p) => p.userId));
  const before = await loadRows(tx);
  type Next = { kind: Kind; departmentId: string | null; primaryUserId: string | null; deputyUserId: string | null };
  const next: Next[] = [];
  if (b.organization) {
    const o = b.organization;
    next.push({ kind: 'PROCUREMENT_LEAD', departmentId: null, primaryUserId: o.leadUserId ?? null, deputyUserId: o.leadDeputyUserId ?? null });
    next.push({ kind: 'PROCUREMENT_DIRECTOR', departmentId: null, primaryUserId: o.directorUserId ?? null, deputyUserId: o.directorDeputyUserId ?? null });
  }
  const deptIds = (b.departments ?? []).map((d) => d.departmentId);
  if (new Set(deptIds).size !== deptIds.length) throw unprocessable('department_duplicate', 'Aynı departman birden fazla kez gönderildi.');
  if (deptIds.length) {
    const n = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM departments WHERE id = ANY($1::uuid[]) AND merged_into IS NULL`, [deptIds])).rows[0]!.n;
    if (n !== deptIds.length) throw unprocessable('department_unknown', 'Seçilen departman bu kurumda tanımlı değil.');
  }
  for (const d of b.departments ?? []) next.push({ kind: 'DEPARTMENT_HEAD', departmentId: d.departmentId, primaryUserId: d.headUserId ?? null, deputyUserId: d.deputyUserId ?? null });
  const key = (kind: string, dept: string | null) => `${kind}:${dept ?? ''}`;
  const beforeMap = new Map(before.map((r) => [key(r.kind, r.department_id), { primary: r.primary_user_id, deputy: r.deputy_user_id }]));
  for (const n of next) {
    // "Etkin olmalı" kuralı yalnız yeni atanan ya da değişen kişiye uygulanır: aynı yerde kalan (sonradan askıya alınmış) kişi
    // başka satırların kaydını engellemez; askıdaki birini yeniden ya da yeni yere atamak yine 422.
    const prev = beforeMap.get(key(n.kind, n.departmentId));
    const fresh = [n.primaryUserId !== prev?.primary ? n.primaryUserId : null, n.deputyUserId !== prev?.deputy ? n.deputyUserId : null];
    if (fresh.some((id) => id && people.get(id)?.wrongRole))
      throw unprocessable('approver_role', 'Onaycı yalnız Satınalma ya da Departman kullanıcısı rolündeki kişilerden seçilir.', { kind: n.kind, departmentId: n.departmentId });
    const allowed = new Set(candidates);
    if (prev?.primary && prev.primary === n.primaryUserId) allowed.add(prev.primary);
    if (prev?.deputy && prev.deputy === n.deputyUserId) allowed.add(prev.deputy);
    const err = validateApprover(n, allowed);
    if (err) throw unprocessable('approver_invalid', err, { kind: n.kind, departmentId: n.departmentId });
  }
  // Kilit sırası sabit (kind, departmentId): eşzamanlı iki kayıt aynı satırları farklı sırada kilitleyip kilitlenmez.
  const ordered = [...next].sort((a, b) => a.kind.localeCompare(b.kind) || (a.departmentId ?? '').localeCompare(b.departmentId ?? ''));
  for (const n of ordered) {
    await tx.query(
      `INSERT INTO approver_assignments (tenant_id, kind, department_id, primary_user_id, deputy_user_id, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT ON CONSTRAINT approver_assignments_unique DO UPDATE
       SET primary_user_id = EXCLUDED.primary_user_id, deputy_user_id = EXCLUDED.deputy_user_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ctx.tenantId, n.kind, n.departmentId, n.primaryUserId, n.deputyUserId, ctx.userId]);
  }
  const changes = next.map((n) => ({ kind: n.kind, departmentId: n.departmentId,
    before: beforeMap.get(key(n.kind, n.departmentId)) ?? { primary: null, deputy: null }, after: { primary: n.primaryUserId, deputy: n.deputyUserId } }));
  await audit(tx, ctx, 'approvers.set', 'approver_assignments', ctx.tenantId, { before: changes.map((c) => ({ kind: c.kind, departmentId: c.departmentId, ...c.before })),
    after: changes.map((c) => ({ kind: c.kind, departmentId: c.departmentId, ...c.after })) });
  return listApprovers(tx);
}
