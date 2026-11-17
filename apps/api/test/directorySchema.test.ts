// v2 Faz 2 (D105): 041 SQL katlaması (sp_normalize_department_name) alan işleviyle aynı sonucu verir; email boş olabilir.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { normalizeDepartmentName } from '@sp/domain';
import { makeHarness } from './harness.ts';

let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

const names = ['İnsan  Kaynakları', 'ISIK Birimi', '  BİLGİ   Teknolojileri ', 'Satın alma\t\tBirimi', 'Ar-Ge (sentetik)'];

describe('dizin şeması', () => {
  it('sql_fold_equals_normalizeDepartmentName', async () => {
    for (const n of names) {
      const r = await h.owner.query<{ f: string }>('SELECT sp_normalize_department_name($1) AS f', [n]);
      expect(r.rows[0]!.f, n).toBe(normalizeDepartmentName(n));
    }
  });
  it('backfill_formula_matches_for_inserted_departments', async () => {
    for (const n of names) {
      const name = `${n} ${randomUUID().slice(0, 4)}`;
      const r = await h.owner.query<{ id: string }>('INSERT INTO departments (tenant_id, name) VALUES ($1, $2) RETURNING id', [h.world.tenantA, name]);
      await h.owner.query('UPDATE departments SET normalized_name = sp_normalize_department_name(name) WHERE id = $1', [r.rows[0]!.id]);
      const q = await h.owner.query<{ normalized_name: string }>('SELECT normalized_name FROM departments WHERE id = $1', [r.rows[0]!.id]);
      expect(q.rows[0]!.normalized_name, name).toBe(normalizeDepartmentName(name));
    }
  });
  it('directory_users_email_nullable', async () => {
    const run = await h.owner.query<{ id: string }>(`INSERT INTO directory_sync_runs (tenant_id, provider_kind, trigger) VALUES ($1, 'test', 'MANUAL') RETURNING id`, [h.world.tenantA]);
    await h.owner.query(`INSERT INTO directory_users (tenant_id, entra_object_id, email, display_name, last_run_id) VALUES ($1, $2, NULL, 'Mailsiz (sentetik)', $3)`,
      [h.world.tenantA, randomUUID(), run.rows[0]!.id]);
  });
});
