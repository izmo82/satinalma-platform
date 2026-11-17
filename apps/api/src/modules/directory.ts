import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { normalizeDepartmentName, normalizeRoles, planMembershipDepartments } from '@sp/domain';
import { withoutTenant, withTenant, type TenantContext, type Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict } from '../errors.ts';
import { DirectoryError, type DirectoryProvider, type DirectoryScope, type DirectoryUser } from '../directory/provider.ts';

/**
 * v2 Faz 2 (D105, analiz-v2 §2.1-2.3) Görev 3: dizin eşitleme işi (`directory.sync`).
 * "Şimdi eşitle" ve gece çalıştırması (R8) aynı işi kuyruğa koyar; işçi `processDirectorySync` ile işler.
 * Güvenlik kuralı (Review Focus 4): sağlayıcı hatası ya da beklenmeyen boş sonuçta hiçbir üyelik değişmez, çalıştırma FAILED olur.
 * Kullanıcı oluşturulmaz (rol ataması Görev 4'te davetli kullanıcı açar); yalnız e-postası eşleşen var olan kullanıcıya bağlanır.
 */

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
const JOB_KIND = 'directory.sync';

const MSG = {
  sync_running: 'Bir dizin eşitlemesi zaten sürüyor; bitmesini bekleyin.',
  not_configured: 'Dizin bağlantısı yapılandırılmamış ya da kapalı; kapsam ayarını kaydedip bağlantıyı açın.',
  provider_error: 'Dizin sağlayıcısından kullanıcılar alınamadı; hiçbir üyelik değiştirilmedi.',
  empty_result: 'Dizin boş sonuç döndürdü. Önceki eşitlemede kapsamda kullanıcı olduğundan hiçbir üyelik değiştirilmedi; kapsam ayarını denetleyin.',
  internal_error: 'Eşitleme sonuçları kaydedilemedi; hiçbir değişiklik uygulanmadı.',
  timeout: 'Eşitleme bir saat içinde tamamlanmadı; yeniden başlatılabilir.',
  job_failed: 'Eşitleme işi tamamlanamadı; yeniden başlatılabilir.',
  last_admin: 'Kurumun son etkin Yönetici üyeliği dizinde kapalı ya da kapsam dışı; kurum yöneticisiz kalmasın diye askıya alınmadı.',
} as const;

/** İşçinin `directory.sync` işi için kiracı bağlamı (worker.ts ile aynı biçim). Gece işinde isteyen yoktur. Sistem işi: departman kapsamı uygulanmaz. */
export function directoryJobContext(tenantId: string, requestedBy: string | null, jobId: string): TenantContext {
  return { tenantId, userId: requestedBy ?? SYSTEM_USER, roles: [], companyIds: [], correlationId: `job-${jobId}`, departmentIds: [], allDepartments: true };
}

/**
 * Eşitleme çalıştırması (QUEUED) ve işini aynı işlemde açar. Yetki denetimi çağıranındır (Görev 4 API).
 * Açık (QUEUED/RUNNING) çalıştırma varsa 409 `sync_running`.
 */
export async function requestSync(tx: Tx, ctx: TenantContext, trigger: 'MANUAL' | 'NIGHTLY', provider: Pick<DirectoryProvider, 'kind'>): Promise<{ runId: string }> {
  const r = await queueSync(tx, ctx, trigger, provider, null);
  return r!;
}

async function queueSync(tx: Tx, ctx: TenantContext, trigger: 'MANUAL' | 'NIGHTLY', provider: Pick<DirectoryProvider, 'kind'>,
  idempotencyKey: string | null): Promise<{ runId: string } | null> {
  if (idempotencyKey) {
    const seen = await tx.query(`SELECT 1 FROM jobs WHERE tenant_id = $1 AND kind = $2 AND idempotency_key = $3`, [ctx.tenantId, JOB_KIND, idempotencyKey]);
    if (seen.rowCount) return null;
  }
  // Hiç işlenmeyen ya da yarıda kalan çalıştırma eşitlemeyi sonsuza dek kilitlemez:
  // (a) işi bitmiş/ölmüş (DEAD, FAILED, BLOCKED, SUCCEEDED) açık çalıştırma, (b) bir saatten eski QUEUED/RUNNING çalıştırma.
  await tx.query(`UPDATE directory_sync_runs r SET status = 'FAILED', error_code = 'job_failed', error_message = $1, finished_at = now()
    WHERE r.status IN ('QUEUED','RUNNING') AND EXISTS (SELECT 1 FROM jobs j WHERE j.kind = $2 AND j.payload->>'runId' = r.id::text
      AND j.status IN ('DEAD','FAILED','BLOCKED','SUCCEEDED'))`, [MSG.job_failed, JOB_KIND]);
  await tx.query(`UPDATE directory_sync_runs SET status = 'FAILED', error_code = 'timeout', error_message = $1, finished_at = now()
    WHERE status IN ('QUEUED','RUNNING') AND coalesce(started_at, created_at) < now() - interval '1 hour'`, [MSG.timeout]);
  const open = await tx.query<{ id: string }>(`SELECT id FROM directory_sync_runs WHERE status IN ('QUEUED','RUNNING') LIMIT 1`);
  if (open.rowCount) throw conflict('sync_running', MSG.sync_running, { runId: open.rows[0]!.id });
  const runId = randomUUID();
  const requestedBy = trigger === 'MANUAL' ? ctx.userId : null;
  const job = await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING RETURNING id`,
    [ctx.tenantId, JOB_KIND, idempotencyKey ?? `${JOB_KIND}:manual:${runId}`, { runId }, requestedBy]);
  if (!job.rowCount) return null;
  try {
    await tx.query(`INSERT INTO directory_sync_runs (id, tenant_id, provider_kind, trigger, requested_by) VALUES ($1, $2, $3, $4, $5)`,
      [runId, ctx.tenantId, provider.kind, trigger, requestedBy]);
  } catch (e) {
    // Eşzamanlı iki istek: kiracı başına tek açık çalıştırma tekil dizini (043).
    if ((e as { code?: string; constraint?: string }).code === '23505') throw conflict('sync_running', MSG.sync_running);
    throw e;
  }
  return { runId };
}

/** İstanbul günü ve saati (Europe/Istanbul). */
function istanbulDay(now: Date): { day: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/**
 * R8: bağlantısı açık her kiracı için İstanbul gününde bir gece eşitlemesi (06:00 sonrası). İdempotency `directory.sync:<tenant>:<YYYY-MM-DD>`.
 * Açık çalıştırması olan kiracı atlanır (sonraki dakikada yeniden denenir). Açılan iş sayısını döndürür.
 */
export async function enqueueNightlySyncs(pool: pg.Pool, now: Date, provider: Pick<DirectoryProvider, 'kind'>): Promise<number> {
  const { day, hour } = istanbulDay(now);
  if (hour < 6) return 0;
  const tenants = await withoutTenant(pool, async (c) => (await c.query<{ tenant_id: string }>(`SELECT tenant_id FROM directory_sync_tenants()`)).rows);
  let n = 0;
  for (const { tenant_id } of tenants) {
    const ctx = directoryJobContext(tenant_id, null, `nightly-${day}`);
    try {
      const r = await withTenant(pool, ctx, (tx) => queueSync(tx, ctx, 'NIGHTLY', provider, `${JOB_KIND}:${tenant_id}:${day}`));
      if (r) n++;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) continue;
      console.error('directory nightly enqueue failed', tenant_id, (e as Error).message);
    }
  }
  return n;
}

interface Connection { scope_type: DirectoryScope['type']; scope_value: string; enabled: boolean }
interface DirRow {
  id: string; entra_object_id: string; email: string | null; display_name: string; user_principal_name: string | null; department_name: string | null;
  department_id: string | null; job_title: string | null; manager_object_id: string | null; account_enabled: boolean; in_scope: boolean; user_id: string | null;
}
interface Counters { fetched: number; created: number; updated: number; suspended: number; reactivated: number; warnings: number }

async function finishFailed(tx: Tx, runId: string, jobId: string, code: string, message: string) {
  // Zaten sonuçlanmış (ör. zaman aşımıyla FAILED) çalıştırmanın kaydı ezilmez.
  await tx.query(`UPDATE directory_sync_runs SET status = 'FAILED', error_code = $2, error_message = $3, finished_at = now()
    WHERE id = $1 AND status IN ('QUEUED','RUNNING')`, [runId, code, message]);
  await tx.query(`UPDATE jobs SET status = 'FAILED', error_code = $2, result = $3, updated_at = now() WHERE id = $1`, [jobId, code, { runId }]);
}

/**
 * `directory.sync` işini işler. Üç adım: (1) çalıştırmayı RUNNING yap, (2) sağlayıcıdan oku (işlem dışında),
 * (3) bütün değişiklikleri TEK işlemde uygula. Adım 2 ya da 3 başarısızsa üyelik değişmez, çalıştırma FAILED olur.
 */
export async function processDirectorySync(pool: pg.Pool, provider: DirectoryProvider, jobId: string, baseCtx: TenantContext): Promise<void> {
  const start = await withTenant(pool, baseCtx, async (tx) => {
    const companyIds = (await tx.query<{ id: string }>(`SELECT id FROM legal_entities ORDER BY id`)).rows.map((r) => r.id);
    const job = (await tx.query<{ payload: { runId?: string } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0];
    const runId = job?.payload?.runId;
    const run = runId ? (await tx.query<{ status: string }>(`SELECT status FROM directory_sync_runs WHERE id = $1 FOR UPDATE`, [runId])).rows[0] : undefined;
    if (!runId || !run || run.status !== 'QUEUED') {
      await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = '{"skipped":true}', updated_at = now() WHERE id = $1`, [jobId]);
      return null;
    }
    const conn = (await tx.query<Connection>(`SELECT scope_type, scope_value, enabled FROM directory_connections`)).rows[0];
    if (!conn || !conn.enabled || !conn.scope_value.trim()) {
      await finishFailed(tx, runId, jobId, 'not_configured', MSG.not_configured);
      return null;
    }
    await tx.query(`UPDATE directory_sync_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`, [runId]);
    return { runId, conn, companyIds };
  });
  if (!start) return;
  const { runId, conn } = start;
  // Görevler şirket kapsamlı (RLS): eşitleme kiracının bütün şirketlerindeki açık görevleri görür.
  const ctx: TenantContext = { ...baseCtx, companyIds: start.companyIds };

  let users: DirectoryUser[];
  try {
    users = await provider.listUsers({ type: conn.scope_type, value: conn.scope_value });
  } catch (e) {
    // DirectoryError iletisi sabit ve sır içermez (Görev 2); diğer hatalar iç ayrıntı taşıyabilir, sabit iletiyle yazılır.
    const [code, message] = e instanceof DirectoryError ? [e.code, e.message] : ['provider_error', MSG.provider_error];
    await withTenant(pool, ctx, (tx) => finishFailed(tx, runId, jobId, code, message));
    return;
  }

  try {
    await withTenant(pool, ctx, (tx) => applySync(tx, ctx, provider, runId, jobId, users));
  } catch (e) {
    console.error('directory sync failed', runId, (e as Error).message);
    await withTenant(pool, ctx, (tx) => finishFailed(tx, runId, jobId, 'internal_error', MSG.internal_error));
  }
}

async function applySync(tx: Tx, ctx: TenantContext, provider: DirectoryProvider, runId: string, jobId: string, fetchedRaw: DirectoryUser[]) {
  // Çalıştırma kilitlenir; RUNNING değilse (ör. zaman aşımıyla FAILED sayıldı, başka eşitleme başladı) hiçbir şey yazılmaz.
  const status = (await tx.query<{ status: string }>(`SELECT status FROM directory_sync_runs WHERE id = $1 FOR UPDATE`, [runId])).rows[0]?.status;
  if (status !== 'RUNNING') {
    await tx.query(`UPDATE jobs SET status = 'FAILED', error_code = 'run_not_running', result = $2, updated_at = now() WHERE id = $1`, [jobId, { runId }]);
    return;
  }
  // Aynı nesne iki kez dönerse sonuncusu geçerli.
  const fetched = [...new Map(fetchedRaw.map((u) => [u.objectId, u])).values()];
  const existing = new Map((await tx.query<DirRow>(`SELECT * FROM directory_users FOR UPDATE`)).rows.map((r) => [r.entra_object_id, r]));
  if (fetched.length === 0 && [...existing.values()].some((r) => r.in_scope)) {
    await finishFailed(tx, runId, jobId, 'empty_result', MSG.empty_result);
    return;
  }
  const c: Counters = { fetched: fetched.length, created: 0, updated: 0, suspended: 0, reactivated: 0, warnings: 0 };
  const deptCache = new Map<string, string | null>();
  const linkedUserIds = new Set([...existing.values()].map((r) => r.user_id).filter((x): x is string => !!x));

  for (const u of fetched) {
    const departmentId = await resolveDepartment(tx, ctx, u.department, deptCache);
    const old = existing.get(u.objectId);
    let userId = old?.user_id ?? null;
    if (!userId && u.email) {
      userId = await findUserByEmail(tx, ctx, u.email);
      if (userId && linkedUserIds.has(userId)) userId = null; // bir uygulama kullanıcısı tek dizin kaydına bağlanır
      if (userId) linkedUserIds.add(userId);
    }
    const next = {
      email: u.email, display_name: u.displayName, user_principal_name: u.userPrincipalName || null, department_name: u.department,
      department_id: departmentId, job_title: u.jobTitle,
      // Sağlayıcı "yönetici yok" ile geçici okuma hatasını ayırmaz; alan yalnız onaycı önerisi besler, önceki değer korunur.
      manager_object_id: u.managerObjectId ?? old?.manager_object_id ?? null,
      account_enabled: u.accountEnabled, in_scope: true, user_id: userId,
    };
    if (old) {
      const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== old[k]);
      await tx.query(`UPDATE directory_users SET email = $2, display_name = $3, user_principal_name = $4, department_name = $5, department_id = $6,
          job_title = $7, manager_object_id = $8, account_enabled = $9, in_scope = true, user_id = $10, last_run_id = $11${changed ? ', updated_at = now()' : ''}
        WHERE id = $1`,
        [old.id, next.email, next.display_name, next.user_principal_name, next.department_name, next.department_id, next.job_title,
          next.manager_object_id, next.account_enabled, next.user_id, runId]);
      if (changed) c.updated++;
    } else {
      await tx.query(`INSERT INTO directory_users (tenant_id, entra_object_id, email, display_name, user_principal_name, department_name, department_id,
          job_title, manager_object_id, account_enabled, in_scope, user_id, last_run_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12)`,
        [ctx.tenantId, u.objectId, next.email, next.display_name, next.user_principal_name, next.department_name, next.department_id, next.job_title,
          next.manager_object_id, next.account_enabled, next.user_id, runId]);
      c.created++;
    }
    if (userId) await applyDirectoryDepartment(tx, ctx, userId, departmentId);
  }

  // Kapsamdan çıkanlar (bu çalıştırmada dönmeyen, önceden kapsamda olan).
  const seen = new Set(fetched.map((u) => u.objectId));
  for (const r of existing.values()) {
    if (seen.has(r.entra_object_id) || !r.in_scope) continue;
    await tx.query(`UPDATE directory_users SET in_scope = false, updated_at = now() WHERE id = $1`, [r.id]);
    c.updated++;
  }

  // R5: kapanan ya da kapsam dışı → askıya al; yeniden etkin → yalnız eşitlemenin askıya aldığını aç.
  const links = (await tx.query<{ user_id: string; active: boolean }>(
    `SELECT user_id, bool_or(account_enabled AND in_scope) AS active FROM directory_users WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY user_id`)).rows;
  for (const l of links) {
    if (l.active) { if (await reactivate(tx, ctx, l.user_id, runId)) c.reactivated++; }
    else {
      const r = await suspend(tx, ctx, l.user_id, runId);
      if (r === 'suspended') c.suspended++;
      else if (r === 'last_admin') c.warnings++;
    }
  }

  const done = await tx.query(`UPDATE directory_sync_runs SET status = 'SUCCEEDED', fetched = $2, created = $3, updated = $4, suspended = $5, reactivated = $6,
      warnings = $7, error_code = NULL, error_message = NULL, finished_at = now() WHERE id = $1 AND status = 'RUNNING'`,
    [runId, c.fetched, c.created, c.updated, c.suspended, c.reactivated, c.warnings]);
  // Başta FOR UPDATE ile kilitlendiğinden olmaz; olursa işlem geri alınır (hiçbir değişiklik kalmaz).
  if (done.rowCount !== 1) throw new Error('directory sync run no longer RUNNING');
  await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, { runId, ...c }]);
  await audit(tx, ctx, 'directory.synced', 'directory_sync_run', runId, { provider: provider.kind, ...c });
}

/** Departman adı → takma ad → (katlanmış adla) var olan departman → yeni ENTRA departmanı + takma ad. Birleştirilmiş departman hedefe çözülür (R6). */
async function resolveDepartment(tx: Tx, ctx: TenantContext, name: string | null, cache: Map<string, string | null>): Promise<string | null> {
  if (!name) return null;
  const key = normalizeDepartmentName(name);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key)!;
  let id: string | undefined = (await tx.query<{ department_id: string }>(`SELECT department_id FROM department_aliases WHERE normalized_name = $1`, [key])).rows[0]?.department_id;
  if (!id) {
    id = (await tx.query<{ id: string }>(`SELECT id FROM departments WHERE sp_normalize_department_name(name) = $1
      ORDER BY (merged_into IS NULL) DESC, created_at, id LIMIT 1`, [key])).rows[0]?.id;
    if (!id) {
      const display = name.replace(/[\t\n\v\f\r \u00A0\u2000-\u200B\u3000\uFEFF]+/g, ' ').replace(/^ | $/g, '').slice(0, 200);
      id = (await tx.query<{ id: string }>(`INSERT INTO departments (tenant_id, name, source, normalized_name) VALUES ($1, $2, 'ENTRA', $3) RETURNING id`,
        [ctx.tenantId, display, key])).rows[0]!.id;
      await audit(tx, ctx, 'department.created', 'department', id, { name: display, source: 'ENTRA' });
    } else {
      // Elle açılmış departman Entra adıyla eşleşti: artık Entra'dan gelir ("Entra dışı departman" etiketi düşer).
      const changed = (await tx.query<{ id: string }>(`UPDATE departments SET source = 'ENTRA' WHERE id = $1 AND source = 'MANUAL' RETURNING id`, [id])).rows[0];
      if (changed) await audit(tx, ctx, 'department.source_changed', 'department', id, { before: 'MANUAL', after: 'ENTRA' });
    }
    await tx.query(`INSERT INTO department_aliases (tenant_id, normalized_name, department_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [ctx.tenantId, key, id]);
  }
  // Birleştirme zinciri (döngüye karşı sınırlı).
  for (let i = 0; i < 10; i++) {
    const m: string | null | undefined = (await tx.query<{ merged_into: string | null }>(`SELECT merged_into FROM departments WHERE id = $1`, [id])).rows[0]?.merged_into;
    if (!m) break;
    id = m;
  }
  cache.set(key, id!);
  return id!;
}

/** E-postayla bu kiracıda üyeliği olan var olan kullanıcı (büyük/küçük harf duyarsız). Kullanıcı oluşturulmaz. */
async function findUserByEmail(tx: Tx, ctx: TenantContext, email: string): Promise<string | null> {
  const r = await tx.query<{ id: string }>(`SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1
    WHERE lower(u.email) = lower($2) ORDER BY (m.supplier_id IS NULL) DESC, u.created_at, u.id LIMIT 1`, [ctx.tenantId, email.trim()]);
  return r.rows[0]?.id ?? null;
}

/** Kurum (tedarikçi olmayan) üyeliği; tedarikçi üyeliğine ve başka kiracının üyeliğine eşitleme dokunmaz. */
const ORG_MEMBERSHIP = `tenant_id = $1 AND user_id = $2 AND supplier_id IS NULL AND NOT ('SUPPLIER' = ANY (roles))`;

/** R4: dizin departmanı üyeliğin departmanlarından biridir; elle eklenenler korunur. */
async function applyDirectoryDepartment(tx: Tx, ctx: TenantContext, userId: string, departmentId: string | null) {
  const m = (await tx.query<{ department_ids: string[]; directory_department_id: string | null }>(
    `SELECT department_ids, directory_department_id FROM memberships WHERE ${ORG_MEMBERSHIP} FOR UPDATE`, [ctx.tenantId, userId])).rows[0];
  if (!m) return;
  const after = planMembershipDepartments(m.department_ids, m.directory_department_id, departmentId);
  const same = after.length === m.department_ids.length && after.every((d, i) => d === m.department_ids[i]);
  if (same && m.directory_department_id === departmentId) return;
  await tx.query(`UPDATE memberships SET department_ids = $3, directory_department_id = $4 WHERE ${ORG_MEMBERSHIP}`, [ctx.tenantId, userId, after, departmentId]);
  if (!same) await audit(tx, ctx, 'membership.departments.set', 'user', userId, { before: m.department_ids, after, source: 'directory' });
}

/** Yönetici rol kodları (039 auth_memberships ile aynı eşleme). */
const ADMIN_ROLES = ['ADMIN', 'TENANT_ADMIN', 'PLATFORM_OPS'];

async function suspend(tx: Tx, ctx: TenantContext, userId: string, runId: string): Promise<'suspended' | 'last_admin' | false> {
  // Kiracı yöneticisiz kalmaz: askıya alma son etkin Yönetici üyeliğini kaldıracaksa atlanır, uyarı sayılır ve denetlenir.
  const admins = (await tx.query<{ user_id: string }>(
    `SELECT user_id FROM memberships WHERE tenant_id = $1 AND status = 'ACTIVE' AND supplier_id IS NULL AND roles && $2::text[] ORDER BY user_id FOR UPDATE`,
    [ctx.tenantId, ADMIN_ROLES])).rows;
  if (admins.length === 1 && admins[0]!.user_id === userId) {
    await audit(tx, ctx, 'directory.suspend_skipped_last_admin', 'user', userId, { runId }, MSG.last_admin);
    return 'last_admin';
  }
  const r = await tx.query(`UPDATE memberships SET status = 'SUSPENDED', suspended_by_directory = true WHERE ${ORG_MEMBERSHIP} AND status = 'ACTIVE'`,
    [ctx.tenantId, userId]);
  if (!r.rowCount) return false;
  await audit(tx, ctx, 'directory.membership_suspended', 'user', userId, { runId });
  await handOffOpenTasks(tx, ctx, userId, 'directory_suspended', { runId });
  return 'suspended';
}

/**
 * R5 devri (eşitlemenin askıya alması, rol kaldırma ve rol düşürme ortak kullanır): kişiye atanmış açık görevler kişinin asıl
 * olduğu atamadaki etkin vekile, vekil yoksa rol kuyruğuna (assignee_user_id NULL) döner; her görev için `task.reassigned`.
 * `keepRoles` verilirse yalnız atandığı rol (assignee_role) bu rollerde olmayan görevler devredilir (rol düşürme).
 * Onaycı atamaları değişmez (Görev 5 etkin olmayan kişiyi gösterir). Devredilen görev sayısını döndürür.
 */
export async function handOffOpenTasks(tx: Tx, ctx: TenantContext, userId: string, reason: string, extra: Record<string, unknown> = {},
  keepRoles: string[] | null = null): Promise<number> {
  const tasks = (await tx.query<{ id: string }>(`SELECT id FROM tasks WHERE status = 'OPEN' AND assignee_user_id = $1
      AND ($2::text[] IS NULL OR NOT (assignee_role = ANY ($2::text[]))) ORDER BY created_at, id FOR UPDATE`, [userId, keepRoles])).rows;
  if (!tasks.length) return 0;
  const deputy = (await tx.query<{ deputy_user_id: string }>(
    `SELECT a.deputy_user_id FROM approver_assignments a
       JOIN memberships m ON m.tenant_id = a.tenant_id AND m.user_id = a.deputy_user_id AND m.status = 'ACTIVE' AND m.supplier_id IS NULL
      WHERE a.primary_user_id = $1 AND a.deputy_user_id IS NOT NULL
      ORDER BY a.kind, a.department_id NULLS FIRST LIMIT 1`, [userId])).rows[0]?.deputy_user_id ?? null;
  for (const t of tasks) {
    await tx.query(`UPDATE tasks SET assignee_user_id = $2 WHERE id = $1`, [t.id, deputy]);
    await audit(tx, ctx, 'task.reassigned', 'task', t.id, { from: userId, to: deputy, reason, ...extra });
  }
  return tasks.length;
}

async function reactivate(tx: Tx, ctx: TenantContext, userId: string, runId: string): Promise<boolean> {
  const r = await tx.query(`UPDATE memberships SET status = 'ACTIVE', suspended_by_directory = false
    WHERE ${ORG_MEMBERSHIP} AND status = 'SUSPENDED' AND suspended_by_directory`, [ctx.tenantId, userId]);
  if (!r.rowCount) return false;
  await audit(tx, ctx, 'directory.membership_reactivated', 'user', userId, { runId });
  return true;
}

// --- Görev 4: Yönetim API'si (bağlantı, çalıştırmalar, eşitlenen kullanıcılar, rol ataması) --------------------------------

const ADMIN_MSG = {
  invalid_scope: 'Kapsam değeri boş olamaz; grup, yönetim birimi ya da OU yolunu girin.',
  not_configured_provider: 'Dizin sağlayıcısı yapılandırılmamış (DIRECTORY_PROVIDER); bağlantı denenemez ve eşitleme başlatılamaz.',
  test_failed: 'Dizin bağlantısı denenemedi; yapılandırmayı denetleyin.',
  role_not_allowed: 'Bu ekrandan yalnız Yönetici, Satınalma, Departman kullanıcısı ve Denetçi rolleri verilir.',
  email_missing: 'Dizin kaydında e-posta yok; bu kullanıcıya rol verilemez. Entra\'da posta alanını doldurup yeniden eşitleyin.',
  directory_user_inactive: 'Kullanıcı dizinde kapalı ya da kapsam dışında; rol verilemez.',
  user_linked_elsewhere: 'Bu e-postadaki kullanıcı başka bir dizin kaydına bağlı; rol verilemez.',
  user_in_other_tenant: 'Bu e-posta başka bir kurumda kayıtlı; erişimi operatör tanımlar.',
  supplier_membership: 'Bu e-postadaki kullanıcı bu kurumda tedarikçi portalı kullanıcısı; kurum rolü verilemez.',
  self_demotion: 'Kendi Yönetici rolünüzü kaldıramazsınız; başka bir Yönetici kaldırabilir.',
  last_admin: 'Kurumun son etkin Yönetici\'sinin rolü kaldırılamaz; önce başka bir kullanıcıya Yönetici rolü verin.',
} as const;

/** Rol ataması ekranından verilebilen roller (R3; tedarikçi rolü verilmez). */
export const ASSIGNABLE_ROLES = ['ADMIN', 'PROCUREMENT', 'DEPARTMENT_USER', 'AUDITOR'] as const;
/** Eşitlenen kullanıcılar listesinin üst sınırı; aşılırsa yanıtta `truncated: true`. */
export const DIRECTORY_USERS_LIMIT = 500;

export interface RunView {
  id: string; status: string; trigger: string; providerKind: string; fetched: number; created: number; updated: number; suspended: number;
  reactivated: number; warnings: number; errorCode: string | null; errorMessage: string | null; requestedBy: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}
const RUN_COLUMNS = `id, status, trigger, provider_kind AS "providerKind", fetched, created, updated, suspended, reactivated, warnings,
  error_code AS "errorCode", error_message AS "errorMessage", requested_by AS "requestedBy", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"`;

/** Sağlayıcının yanıtta gösterilebilen alanları. Sır (istemci sırrı) sağlayıcı nesnesinde de tutulmaz; burada yalnız etiketler döner. */
function providerView(p: DirectoryProvider | null) {
  return p ? { kind: p.kind, label: p.label, tenantLabel: p.tenantLabel, configured: true } : null;
}

export async function getConnection(tx: Tx, provider: DirectoryProvider | null) {
  const conn = (await tx.query<Connection>(`SELECT scope_type, scope_value, enabled FROM directory_connections`)).rows[0];
  const lastRun = (await tx.query<RunView>(`SELECT ${RUN_COLUMNS} FROM directory_sync_runs ORDER BY created_at DESC, id LIMIT 1`)).rows[0] ?? null;
  return {
    provider: providerView(provider),
    scope: conn && conn.scope_value ? { type: conn.scope_type, value: conn.scope_value } : null,
    enabled: conn?.enabled ?? false,
    lastRun,
  };
}

export async function setConnection(tx: Tx, ctx: TenantContext, provider: DirectoryProvider | null,
  b: { scopeType: DirectoryScope['type']; scopeValue: string; enabled: boolean }) {
  const value = b.scopeValue.trim();
  if (!value) throw new ApiError(422, 'invalid_scope', ADMIN_MSG.invalid_scope);
  const before = (await tx.query<Connection>(`SELECT scope_type, scope_value, enabled FROM directory_connections FOR UPDATE`)).rows[0] ?? null;
  await tx.query(`INSERT INTO directory_connections (tenant_id, scope_type, scope_value, enabled, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (tenant_id) DO UPDATE SET scope_type = EXCLUDED.scope_type, scope_value = EXCLUDED.scope_value, enabled = EXCLUDED.enabled,
      updated_by = EXCLUDED.updated_by, updated_at = now()`, [ctx.tenantId, b.scopeType, value, b.enabled, ctx.userId]);
  await audit(tx, ctx, 'directory.connection.updated', 'directory_connection', ctx.tenantId, {
    before: before && { scopeType: before.scope_type, scopeValue: before.scope_value, enabled: before.enabled },
    after: { scopeType: b.scopeType, scopeValue: value, enabled: b.enabled },
  });
  return getConnection(tx, provider);
}

export function notConfigured(): ApiError {
  return conflict('not_configured', ADMIN_MSG.not_configured_provider);
}

/** Sağlayıcının bağlantı denemesi. Beklenmeyen hata iç ayrıntı (sır dahil) taşıyabileceğinden sabit iletiyle döner. */
export async function testConnection(provider: DirectoryProvider) {
  let result: { ok: true } | { ok: false; code: string; message: string };
  try {
    result = await provider.testConnection();
  } catch (e) {
    result = e instanceof DirectoryError ? { ok: false, code: e.code, message: e.message } : { ok: false, code: 'provider_error', message: ADMIN_MSG.test_failed };
  }
  return { ...result, provider: { kind: provider.kind, label: provider.label } };
}

/** "Şimdi eşitle": bağlantı açık ve kapsam dolu olmalı; açık çalıştırma varsa 409 `sync_running` (requestSync). */
export async function startManualSync(tx: Tx, ctx: TenantContext, provider: DirectoryProvider) {
  const conn = (await tx.query<Connection>(`SELECT scope_type, scope_value, enabled FROM directory_connections`)).rows[0];
  if (!conn || !conn.enabled || !conn.scope_value.trim()) throw conflict('not_configured', MSG.not_configured);
  return requestSync(tx, ctx, 'MANUAL', provider);
}

export async function listRuns(tx: Tx): Promise<RunView[]> {
  return (await tx.query<RunView>(`SELECT ${RUN_COLUMNS} FROM directory_sync_runs ORDER BY created_at DESC, id LIMIT 50`)).rows;
}

export type DirectoryUserStatus = 'ACTIVE' | 'SUSPENDED' | 'NO_MEMBERSHIP' | 'DISABLED';
export interface DirectoryUserView {
  id: string; displayName: string; email: string | null; departmentName: string | null; departmentId: string | null;
  roles: string[] | null; status: DirectoryUserStatus; jobTitle: string | null;
}
interface DirUserListRow {
  id: string; display_name: string; email: string | null; department_name: string | null; department_id: string | null; job_title: string | null;
  account_enabled: boolean; in_scope: boolean; m_status: string | null; m_roles: string[] | null;
}

function toView(r: DirUserListRow): DirectoryUserView {
  const member = r.m_status !== null && r.m_status !== 'REVOKED';
  const status: DirectoryUserStatus = !r.account_enabled || !r.in_scope ? 'DISABLED'
    : !member ? 'NO_MEMBERSHIP' : r.m_status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';
  return {
    id: r.id, displayName: r.display_name, email: r.email, departmentName: r.department_name, departmentId: r.department_id,
    roles: member ? normalizeRoles(r.m_roles ?? []) : null, status, jobTitle: r.job_title,
  };
}

const DIR_USER_SELECT = `SELECT du.id, du.display_name, du.email, coalesce(d.name, du.department_name) AS department_name, du.department_id, du.job_title,
    du.account_enabled, du.in_scope, m.status AS m_status, m.roles AS m_roles
  FROM directory_users du
  LEFT JOIN departments d ON d.id = du.department_id
  LEFT JOIN memberships m ON m.tenant_id = du.tenant_id AND m.user_id = du.user_id AND m.supplier_id IS NULL`;

export async function listDirectoryUsers(tx: Tx, f: { q?: string; departmentId?: string }) {
  const q = f.q?.trim() ? `%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = (await tx.query<DirUserListRow>(`${DIR_USER_SELECT}
    WHERE ($1::text IS NULL OR du.display_name ILIKE $1 OR du.email ILIKE $1) AND ($2::uuid IS NULL OR du.department_id = $2)
    ORDER BY du.display_name, du.id LIMIT $3`, [q, f.departmentId ?? null, DIRECTORY_USERS_LIMIT + 1])).rows;
  const truncated = rows.length > DIRECTORY_USERS_LIMIT;
  return { items: rows.slice(0, DIRECTORY_USERS_LIMIT).map(toView), truncated, limit: DIRECTORY_USERS_LIMIT };
}

/**
 * R3: dizin kullanıcısına rol verir. Kullanıcı yoksa davetli kullanıcı açılır (ilk girişte `auth_link_invited_user` bağlar). 046 kuralları
 * (büyük/küçük harf duyarsız e-posta): bu kiracıda (herhangi durumda) üyeliği olan kullanıcı ya da hiçbir kurumda üyeliği olmayan
 * `invite|` kullanıcısı yeniden kullanılır; e-postayı başka kurumdaki ya da bu kiracıda üyeliği olmayan bir kullanıcı (OIDC dahil)
 * taşıyorsa hiçbir şey açılmaz ya da bağlanmaz, 409 `user_in_other_tenant` döner.
 * Yeni üyelik: kiracının bütün şirketleri, departman Entra'dan. Boş dizi = üyelik REVOKED.
 * Review Focus 3: kiracının etkin Yönetici üyelikleri eşitlemeyle aynı sırada (user_id) FOR UPDATE kilitlenir; son Yönetici ve
 * kendi Yönetici rolünü düşürme reddedilir. Kilit sırası eşitlemeyle aynı: önce dizin kaydı, sonra üyelikler.
 */
export async function setDirectoryUserRoles(tx: Tx, ctx: TenantContext, directoryUserId: string, b: { roles: string[] }): Promise<DirectoryUserView> {
  const roles = [...new Set(b.roles)];
  const bad = roles.filter((r) => !(ASSIGNABLE_ROLES as readonly string[]).includes(r));
  if (bad.length) throw new ApiError(422, 'role_not_allowed', ADMIN_MSG.role_not_allowed, { roles: bad });
  const du = (await tx.query<DirRow>(`SELECT * FROM directory_users WHERE id = $1 FOR UPDATE`, [directoryUserId])).rows[0];
  if (!du) throw new ApiError(404, 'not_found', 'Kayıt bulunamadı veya erişim yetkiniz yok.');
  const granting = roles.length > 0;
  if (granting && (!du.account_enabled || !du.in_scope)) throw conflict('directory_user_inactive', ADMIN_MSG.directory_user_inactive);
  if (granting && !du.email) throw new ApiError(422, 'email_missing', ADMIN_MSG.email_missing);

  // Kullanıcı: bağlı olan → bu kiracıda e-postası eşleşen üye → (yalnız rol verilirken) başka kiracıdaki ya da yeni davetli kullanıcı.
  let userId = du.user_id;
  if (!userId && du.email) userId = await findUserByEmail(tx, ctx, du.email);
  if (!userId && granting) {
    // 046: yalnız bu kiracıda üyesi olan ya da hiçbir kurumda üyeliği olmayan davetli kullanıcı yeniden kullanılır; başka kurumdaki
    // kullanıcı için NULL döner (kimlik ya da ad sızmaz, hiçbir şey oluşturulmaz ya da bağlanmaz).
    userId = (await tx.query<{ id: string | null }>(`SELECT directory_invite_user($1, $2) AS id`, [du.email, du.display_name])).rows[0]!.id;
    if (!userId) throw conflict('user_in_other_tenant', ADMIN_MSG.user_in_other_tenant);
  }
  if (!userId) return toView(await dirUserRow(tx, directoryUserId)); // üyeliği olmayan kullanıcıdan rol kaldırmak: değişiklik yok
  if (!du.user_id) {
    const other = await tx.query(`SELECT 1 FROM directory_users WHERE user_id = $1 AND id <> $2`, [userId, du.id]);
    if (other.rowCount) throw conflict('user_linked_elsewhere', ADMIN_MSG.user_linked_elsewhere);
  }

  const admins = (await tx.query<{ user_id: string }>(
    `SELECT user_id FROM memberships WHERE tenant_id = $1 AND status = 'ACTIVE' AND supplier_id IS NULL AND roles && $2::text[] ORDER BY user_id FOR UPDATE`,
    [ctx.tenantId, ADMIN_ROLES])).rows.map((r) => r.user_id);
  const m = (await tx.query<{ roles: string[]; status: string; supplier_id: string | null; department_ids: string[]; directory_department_id: string | null }>(
    `SELECT roles, status, supplier_id, department_ids, directory_department_id FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
    [ctx.tenantId, userId])).rows[0];
  if (m && (m.supplier_id || m.roles.includes('SUPPLIER'))) throw conflict('supplier_membership', ADMIN_MSG.supplier_membership);

  const wasAdmin = !!m && m.status === 'ACTIVE' && m.roles.some((r) => ADMIN_ROLES.includes(r));
  const willAdmin = roles.includes('ADMIN');
  if (wasAdmin && !willAdmin) {
    if (userId === ctx.userId) throw conflict('self_demotion', ADMIN_MSG.self_demotion);
    if (!admins.some((a) => a !== userId)) throw conflict('last_admin', ADMIN_MSG.last_admin);
  }

  const before = m ? { roles: m.roles, status: m.status } : null;
  let after: { roles: string[]; status: string } | null;
  let handedOff = 0;
  if (!granting) {
    if (!m || m.status === 'REVOKED') after = before;
    else {
      await tx.query(`UPDATE memberships SET roles = '{}', status = 'REVOKED', suspended_by_directory = false WHERE tenant_id = $1 AND user_id = $2`,
        [ctx.tenantId, userId]);
      after = { roles: [], status: 'REVOKED' };
      handedOff = await handOffOpenTasks(tx, ctx, userId, 'membership_revoked', { directoryUserId: du.id });
    }
  } else if (!m) {
    const companyIds = (await tx.query<{ id: string }>(`SELECT id FROM legal_entities ORDER BY id`)).rows.map((r) => r.id);
    await tx.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, department_ids, directory_department_id, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')`,
      [ctx.tenantId, userId, roles, companyIds, du.department_id ? [du.department_id] : [], du.department_id]);
    after = { roles, status: 'ACTIVE' };
  } else {
    // El ile yapılan atama eşitlemenin askı bayrağını temizler (yeniden etkinleşmede eşitleme bu üyeliği askıya almışsa).
    const depts = planMembershipDepartments(m.department_ids, m.directory_department_id, du.department_id);
    await tx.query(`UPDATE memberships SET roles = $3, status = 'ACTIVE', suspended_by_directory = false, department_ids = $4, directory_department_id = $5
      WHERE tenant_id = $1 AND user_id = $2`, [ctx.tenantId, userId, roles, depts, du.department_id]);
    after = { roles, status: 'ACTIVE' };
    // Rol düşürme: yeni rollerde olmayan rolle atanmış açık görevler devredilir (Yönetici rolü kalırsa görev kendisinde kalabilir).
    if (m.status === 'ACTIVE') {
      handedOff = await handOffOpenTasks(tx, ctx, userId, 'membership_roles_changed', { directoryUserId: du.id }, normalizeRoles(roles));
    }
  }
  if (du.user_id !== userId) await tx.query(`UPDATE directory_users SET user_id = $2, updated_at = now() WHERE id = $1`, [du.id, userId]);
  await audit(tx, ctx, 'membership.roles.set', 'user', userId, { before, after, directoryUserId: du.id, source: 'directory', tasksHandedOff: handedOff });
  return toView(await dirUserRow(tx, directoryUserId));
}

async function dirUserRow(tx: Tx, id: string): Promise<DirUserListRow> {
  return (await tx.query<DirUserListRow>(`${DIR_USER_SELECT} WHERE du.id = $1`, [id])).rows[0]!;
}
