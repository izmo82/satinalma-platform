import { OFFBOARDING_ITEMS, offboardingComplete, supplierStage } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { listInfo } from './contractIntake.ts';
import { offboardingItems } from './supplierCard.ts';

/**
 * v2 Faz 5 (D110) Görev 5, R13: pasife alma, ayrılış kontrol listesi ve yeniden açma. Veri hiçbir durumda silinmez.
 * - Pasife alma (`ACTIVE/CONDITIONAL/CANDIDATE` → `SUSPENDED`): gerekçe ≥10; aynı işlemde portal üyelikleri `SUSPENDED`, 6 maddelik
 *   kontrol listesi ve Satınalma görevi açılır. Aktif sözleşme ve açık tur uyarıdır, engel değildir. Yeni davet `requestPublish`'te engellenir.
 * - Yeniden pasife almada `reactivated_*` aynı UPDATE'te boşaltılır (052 görev ayrılığı CHECK'i ikinci döngüyü engellemesin).
 * - Yeniden açma (`SUSPENDED` → pasife almadan önceki onaylı/aday durum): pasife alan kişi yapamaz (403 `segregation_of_duties`;
 *   DB CHECK de reddeder). `ARCHIVED` bu fazda yeniden açılmaz. Pasife almayla askıya alınan portal kullanıcıları yeniden açılır.
 */

const DEACTIVATABLE = new Set(['ACTIVE', 'CONDITIONAL', 'CANDIDATE']);
const taskKey = (offboardingId: string) => `offboarding:${offboardingId}`;

async function lock(tx: Tx, id: string, expectedRowVersion: number) {
  const s = (await tx.query<{ id: string; status: string; legal_name: string; row_version: number; deactivated_by: string | null; activated_at: Date | null }>(
    `SELECT id, status, legal_name, row_version, deactivated_by, activated_at FROM suppliers WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!s) throw notFound();
  if (s.row_version !== expectedRowVersion) {
    throw conflict('version_conflict', 'Kayıt siz incelerken değişti. Güncel bilgileri gözden geçirin.', { currentRowVersion: s.row_version });
  }
  return s;
}
const reasonOf = (r: string) => {
  const t = (r ?? '').trim();
  if (t.length < 10) throw unprocessable('reason_required', 'Gerekçe en az 10 karakter olmalı.');
  return t;
};

/** Uyarılar (engel değil): yürürlükteki sözleşmeler ve açık (onayda/açık) teklif turları. */
export async function deactivationWarnings(tx: Tx, supplierId: string) {
  const fams = (await tx.query<{ id: string; title: string }>(`SELECT id, title FROM contract_families WHERE supplier_id = $1`, [supplierId])).rows;
  const info = await listInfo(tx, fams.map((f) => f.id));
  const activeContracts = fams.filter((f) => { const s = info.get(f.id)?.status; return s === 'APPROVED' || s === 'LEGACY'; })
    .map((f) => ({ id: f.id, code: info.get(f.id)?.code ?? null, title: f.title, endDate: info.get(f.id)?.endDate ?? null }));
  const openRounds = (await tx.query<{ round_id: string; round_no: number; status: string; project_id: string; code: string; title: string; closes_at: Date }>(
    `SELECT r.id AS round_id, r.round_no, r.status, p.id AS project_id, p.code, p.title, r.closes_at FROM rfq_invitations i
       JOIN rfq_rounds r ON r.id = i.round_id JOIN projects p ON p.id = r.project_id
     WHERE i.supplier_id = $1 AND r.status IN ('PENDING_APPROVAL','OPEN') ORDER BY r.closes_at`, [supplierId])).rows
    .map((r) => ({ roundId: r.round_id, roundNo: r.round_no, status: r.status, projectId: r.project_id, projectCode: r.code, projectTitle: r.title, closesAt: r.closes_at }));
  const warnings = [
    ...activeContracts.map((c) => ({ code: 'ACTIVE_CONTRACT', message: `Yürürlükte sözleşme: ${c.code ?? ''} ${c.title}`.trim() })),
    ...openRounds.map((r) => ({ code: 'OPEN_ROUND', message: `Açık teklif turu: ${r.projectCode} ${r.projectTitle} (${r.roundNo}. tur)` })),
  ];
  return { activeContracts, openRounds, warnings };
}

export async function deactivateSupplier(tx: Tx, ctx: TenantContext, id: string, b: { reason: string; expectedRowVersion: number }) {
  const s = await lock(tx, id, b.expectedRowVersion);
  if (!DEACTIVATABLE.has(s.status)) throw conflict('invalid_state', 'Yalnız onaylı ya da aday tedarikçi pasife alınabilir.', { status: s.status });
  const reason = reasonOf(b.reason);
  const w = await deactivationWarnings(tx, id);
  // Yeniden pasife almada önceki yeniden açma izi aynı UPDATE'te boşalır (052 suppliers_reactivation_sod).
  const rv = (await tx.query<{ row_version: number }>(`UPDATE suppliers SET status = 'SUSPENDED', deactivated_at = now(), deactivated_by = $2, deactivation_reason = $3,
      reactivated_by = NULL, reactivated_at = NULL, reactivation_reason = NULL, row_version = row_version + 1 WHERE id = $1 RETURNING row_version`,
    [id, ctx.userId, reason])).rows[0]!.row_version;
  const suspended = (await tx.query<{ user_id: string }>(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND supplier_id = $2 AND status = 'ACTIVE' RETURNING user_id`,
    [ctx.tenantId, id])).rows.map((r) => r.user_id);
  const ob = (await tx.query<{ id: string }>(`INSERT INTO supplier_offboardings (tenant_id, supplier_id, reason, started_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.tenantId, id, reason, ctx.userId])).rows[0]!.id;
  for (const item of OFFBOARDING_ITEMS) {
    await tx.query(`INSERT INTO supplier_offboarding_items (tenant_id, offboarding_id, code, label) VALUES ($1,$2,$3,$4)`, [ctx.tenantId, ob, item.code, item.label]);
  }
  const task = await openTask(tx, ctx, { companyId: null, departmentId: null, kind: 'supplier_offboarding', entityType: 'supplier', entityId: id,
    title: `Tedarikçi ayrılış kontrol listesi: ${s.legal_name}`.slice(0, 300), reason: `${s.legal_name} pasife alındı: ${reason}`,
    nextAction: 'Kontrol listesindeki maddeleri "Yapıldı" ya da "Uygulanmaz" olarak kapatın.', assigneeRole: 'PROCUREMENT', dedupeKey: taskKey(ob) });
  // Aday onay görevi pasif kartta anlamsızdır (veri değişmez; görev kapanır).
  if (s.status === 'CANDIDATE') await closeTasks(tx, `supplier:${id}:activation`);
  await audit(tx, ctx, 'supplier.deactivated', 'supplier', id, { before: s.status, after: 'SUSPENDED', offboardingId: ob, suspendedPortalUsers: suspended,
    warnings: w.warnings.map((x) => x.code) }, reason);
  const st = supplierStage('SUSPENDED');
  return { status: 'SUSPENDED', stage: st.code, stageLabel: st.label, rowVersion: rv, suspendedPortalUsers: suspended.length, offboardingId: ob, taskId: task.id,
    warnings: w.warnings, activeContracts: w.activeContracts, openRounds: w.openRounds, items: await offboardingItems(tx, ob) };
}

export async function decideOffboardingItem(tx: Tx, ctx: TenantContext, itemId: string, b: { done?: boolean; notApplicable?: boolean; note?: string | null }) {
  const it = (await tx.query<{ id: string; offboarding_id: string; code: string; done_at: Date | null }>(
    `SELECT id, offboarding_id, code, done_at FROM supplier_offboarding_items WHERE id = $1 FOR UPDATE`, [itemId])).rows[0];
  if (!it) throw notFound();
  if (!!b.done === !!b.notApplicable) throw unprocessable('invalid_field', '"Yapıldı" ya da "Uygulanmaz" seçeneklerinden yalnız biri seçilmeli.');
  if (it.done_at) throw conflict('already_decided', 'Bu madde zaten kapatıldı; karar değiştirilemez.');
  const note = (b.note ?? '').trim() || null;
  if (note && note.length > 2000) throw unprocessable('invalid_field', 'Not en çok 2000 karakter olabilir.', { field: 'note' });
  if (b.notApplicable && (!note || note.length < 3)) throw unprocessable('note_required', '"Uygulanmaz" için gerekçe yazın.');
  await tx.query(`UPDATE supplier_offboarding_items SET done_by = $2, done_at = now(), not_applicable = $3, note = $4 WHERE id = $1`,
    [itemId, ctx.userId, !!b.notApplicable, note]);
  const ob = (await tx.query<{ id: string; supplier_id: string; completed_at: Date | null }>(
    `SELECT id, supplier_id, completed_at FROM supplier_offboardings WHERE id = $1 FOR UPDATE`, [it.offboarding_id])).rows[0]!;
  const items = await offboardingItems(tx, ob.id);
  const complete = offboardingComplete(items.map((i) => ({ code: i.code, doneAt: i.doneAt ? String(i.doneAt) : null, notApplicable: i.notApplicable })));
  let completedAt = ob.completed_at;
  if (complete && !completedAt) {
    completedAt = (await tx.query<{ completed_at: Date }>(`UPDATE supplier_offboardings SET completed_at = now() WHERE id = $1 RETURNING completed_at`, [ob.id])).rows[0]!.completed_at;
    await closeTasks(tx, taskKey(ob.id));
    await audit(tx, ctx, 'supplier.offboarding.completed', 'supplier', ob.supplier_id, { offboardingId: ob.id });
  }
  await audit(tx, ctx, 'supplier.offboarding_item.decided', 'supplier', ob.supplier_id, { offboardingId: ob.id, itemId, code: it.code,
    decision: b.notApplicable ? 'NOT_APPLICABLE' : 'DONE' }, note ?? undefined);
  return { item: items.find((i) => i.id === itemId)!, offboarding: { id: ob.id, completed: !!completedAt, completedAt, items } };
}

export async function reactivateSupplier(tx: Tx, ctx: TenantContext, id: string, b: { reason: string; expectedRowVersion: number }) {
  const s = await lock(tx, id, b.expectedRowVersion);
  if (s.status === 'ARCHIVED') throw conflict('invalid_state', 'Arşivlenmiş tedarikçi bu aşamada yeniden açılamaz.');
  if (s.status !== 'SUSPENDED') throw conflict('invalid_state', 'Yalnız pasif (askıdaki) tedarikçi yeniden açılabilir.', { status: s.status });
  if (s.deactivated_by && s.deactivated_by === ctx.userId) {
    throw new ApiError(403, 'segregation_of_duties', 'Görev ayrılığı: tedarikçiyi pasife alan kişi yeniden açamaz.');
  }
  const reason = reasonOf(b.reason);
  // Pasife almadan önceki durum denetim kaydından; yoksa (eski SUSPENDED kayıt) aktivasyon izinden: aktifleştirilmişse ACTIVE, değilse aday.
  const last = (await tx.query<{ data: { before?: string; suspendedPortalUsers?: string[] } }>(
    `SELECT data FROM audit_events WHERE entity_type = 'supplier' AND entity_id = $1 AND action = 'supplier.deactivated' ORDER BY at DESC, id DESC LIMIT 1`, [id])).rows[0]?.data;
  const target = last?.before && DEACTIVATABLE.has(last.before) ? last.before : s.activated_at ? 'ACTIVE' : 'CANDIDATE';
  const rv = (await tx.query<{ row_version: number }>(`UPDATE suppliers SET status = $2, reactivated_by = $3, reactivated_at = now(), reactivation_reason = $4,
      row_version = row_version + 1 WHERE id = $1 RETURNING row_version`, [id, target, ctx.userId, reason])).rows[0]!.row_version;
  const restore = last?.suspendedPortalUsers ?? [];
  const restored = restore.length ? (await tx.query<{ user_id: string }>(`UPDATE memberships SET status = 'ACTIVE' WHERE tenant_id = $1 AND supplier_id = $2
      AND status = 'SUSPENDED' AND user_id = ANY($3::uuid[]) RETURNING user_id`, [ctx.tenantId, id, restore])).rows.map((r) => r.user_id) : [];
  if (target === 'CANDIDATE') {
    await openTask(tx, ctx, { companyId: null, kind: 'SUPPLIER_CANDIDATE_APPROVAL', entityType: 'supplier', entityId: id, title: `Aday tedarikçi onay bekliyor: ${s.legal_name}`.slice(0, 300),
      reason: 'Pasif aday kart yeniden açıldı; kayıt onayı gerekiyor.', nextAction: 'Kimlik ve kanıtı inceleyip kayıt onayı verin.', assigneeRole: 'PROCUREMENT',
      dedupeKey: `supplier:${id}:activation` });
  }
  await audit(tx, ctx, 'supplier.reactivated', 'supplier', id, { before: 'SUSPENDED', after: target, restoredPortalUsers: restored }, reason);
  const st = supplierStage(target as 'ACTIVE');
  return { status: target, stage: st.code, stageLabel: st.label, rowVersion: rv, restoredPortalUsers: restored.length };
}
