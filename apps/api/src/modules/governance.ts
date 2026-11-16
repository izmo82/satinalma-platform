import { createHash } from 'node:crypto';
import type pg from 'pg';
import { retentionVerdict, type LegalHold, type RetentionPolicy } from '@sp/domain';
import { withTenant, type TenantContext, type Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { ObjectStore } from '../storage.ts';
import { ZipStreamWriter } from '../zip.ts';

/**
 * Faz 7 / T48: saklama politikası, hukuki saklama, iki kişi onaylı imha ve kiracı dışa aktarımı.
 * - Politika yoksa belge süresiz saklanır. Hukuki saklama imhayı her koşulda durdurur.
 * - İmha: belge ve sürüm satırları, hash ve denetim izi kalır; yalnız baytlar silinir ve belge "imha edildi" olarak işaretlenir.
 * - Dışa aktarım RLS'li kiracı bağlamında okunur: başka kiracının verisi teknik olarak pakete giremez.
 */

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date()); // diğer modüllerle aynı iş günü
const KINDS = ['INVOICE', 'CONTRACT', 'QUOTE', 'OTHER'] as const;
// Paket bellekte üretilir (en çok ~2× boyut): sınır, normal boyutlu bir worker'ı taşırmayacak şekilde tutulur. Akışlı üretim sonraki iş.
/** Paket üst sınırı (akışlı üretim; bellek değil, işlem süresi ve indirme için). Üstü kurum yedeğinden geri yükleme yoludur. */
export const MAX_EXPORT_BYTES = 50 * 1024 ** 3;
const EXPORT_FETCH_ROWS = 2000;
const EXPORT_TTL_DAYS = 7;

// --- Saklama politikası ---------------------------------------------------------------------------

export async function retentionOverview(tx: Tx) {
  const policies = (await tx.query(`SELECT document_kind AS "documentKind", retention_months AS "retentionMonths", legal_basis AS "legalBasis",
      u.display_name AS "updatedBy", p.updated_at AS "updatedAt" FROM retention_policies p JOIN users u ON u.id = p.updated_by ORDER BY 1`)).rows;
  const holds = (await tx.query(`SELECT h.id, h.scope, h.company_id AS "companyId", le.name AS "companyName", h.document_id AS "documentId",
      d.title AS "documentTitle", d.code AS "documentCode", h.matter_ref AS "matterRef", h.reason, cu.display_name AS "createdBy", h.created_at AS "createdAt",
      ru.display_name AS "releasedBy", h.released_at AS "releasedAt", h.release_reason AS "releaseReason"
    FROM legal_holds h JOIN users cu ON cu.id = h.created_by LEFT JOIN users ru ON ru.id = h.released_by
    LEFT JOIN legal_entities le ON le.id = h.company_id LEFT JOIN documents d ON d.id = h.document_id
    ORDER BY h.released_at DESC NULLS FIRST, h.created_at DESC`)).rows;
  const batches = (await tx.query(`SELECT b.id, b.status, b.reason, pu.display_name AS "proposedBy", b.proposed_by AS "proposedById", b.proposed_at AS "proposedAt",
      du.display_name AS "decidedBy", b.decided_at AS "decidedAt", b.decision_note AS "decisionNote", b.executed_at AS "executedAt", b.result,
      (SELECT count(*)::int FROM disposal_items i WHERE i.batch_id = b.id) AS "itemCount"
    FROM disposal_batches b JOIN users pu ON pu.id = b.proposed_by LEFT JOIN users du ON du.id = b.decided_by ORDER BY b.proposed_at DESC LIMIT 50`)).rows;
  return { policies, holds, batches, kinds: KINDS };
}

export async function setPolicy(tx: Tx, ctx: TenantContext, kind: string, b: { retentionMonths: number; legalBasis: string }) {
  if (!(KINDS as readonly string[]).includes(kind)) throw unprocessable('invalid_kind', 'Geçersiz belge türü.');
  if (!Number.isInteger(b.retentionMonths) || b.retentionMonths < 1 || b.retentionMonths > 1200) throw unprocessable('invalid_period', 'Süre 1–1200 ay arasında tam sayı olmalı.');
  if (b.legalBasis.trim().length < 5) throw unprocessable('basis_required', 'Sürenin dayanağı (mevzuat maddesi veya kurum politikası) zorunlu.');
  const prev = (await tx.query<{ retention_months: number }>(`SELECT retention_months FROM retention_policies WHERE document_kind = $1`, [kind])).rows[0];
  await tx.query(`INSERT INTO retention_policies (tenant_id, document_kind, retention_months, legal_basis, updated_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (tenant_id, document_kind) DO UPDATE SET retention_months = EXCLUDED.retention_months, legal_basis = EXCLUDED.legal_basis,
      updated_by = EXCLUDED.updated_by, updated_at = now()`, [ctx.tenantId, kind, b.retentionMonths, b.legalBasis.trim(), ctx.userId]);
  await audit(tx, ctx, 'retention.policy.set', 'retention_policy', null, { kind, retentionMonths: b.retentionMonths, previousMonths: prev?.retention_months ?? null });
  return { documentKind: kind, retentionMonths: b.retentionMonths };
}

export async function deletePolicy(tx: Tx, ctx: TenantContext, kind: string) {
  const r = await tx.query(`DELETE FROM retention_policies WHERE document_kind = $1`, [kind]);
  if (!r.rowCount) throw notFound();
  await audit(tx, ctx, 'retention.policy.removed', 'retention_policy', null, { kind });
  return { ok: true };
}

// --- Hukuki saklama -------------------------------------------------------------------------------

/** Hukuki saklama, yeni sürüm ve imha onayı aynı kilitle sıralanır: onay sürerken gelen saklama/sürüm görülmeden imha yapılmaz. */
export const retentionLock = (tx: Tx, tenantId: string) => tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`retention:${tenantId}`]);

export async function createHold(tx: Tx, ctx: TenantContext, b: { scope: 'TENANT' | 'COMPANY' | 'DOCUMENT'; companyId?: string | null; documentId?: string | null; matterRef: string; reason: string }) {
  await retentionLock(tx, ctx.tenantId);
  let companyId: string | null = null; let documentId: string | null = null;
  if (b.scope === 'COMPANY') {
    if (!b.companyId || !(await tx.query(`SELECT 1 FROM legal_entities WHERE id = $1`, [b.companyId])).rowCount) throw unprocessable('invalid_reference', 'Şirket bulunamadı.');
    companyId = b.companyId;
  } else if (b.scope === 'DOCUMENT') {
    // Belge, hukuki saklamayı koyan kişinin erişebildiği bir belge olmalı (RLS şirket kapsamı).
    const d = (await tx.query<{ company_id: string }>(`SELECT company_id FROM documents WHERE id = $1`, [b.documentId ?? null])).rows[0];
    if (!d) throw unprocessable('invalid_reference', 'Belge bulunamadı veya erişiminiz yok.');
    documentId = b.documentId!; companyId = d.company_id;
  }
  const h = (await tx.query<{ id: string }>(`INSERT INTO legal_holds (tenant_id, scope, company_id, document_id, matter_ref, reason, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.tenantId, b.scope, companyId, documentId, b.matterRef.trim(), b.reason.trim(), ctx.userId])).rows[0]!;
  await audit(tx, ctx, 'legal_hold.created', 'legal_hold', h.id, { scope: b.scope, companyId, documentId, matterRef: b.matterRef.trim() });
  return { id: h.id };
}

export async function releaseHold(tx: Tx, ctx: TenantContext, id: string, reason: string) {
  const r = await tx.query(`UPDATE legal_holds SET released_by = $2, released_at = now(), release_reason = $3 WHERE id = $1 AND released_at IS NULL`, [id, ctx.userId, reason.trim()]);
  if (!r.rowCount) {
    if ((await tx.query(`SELECT 1 FROM legal_holds WHERE id = $1`, [id])).rowCount) throw conflict('already_released', 'Hukuki saklama zaten kaldırılmış.');
    throw notFound();
  }
  await audit(tx, ctx, 'legal_hold.released', 'legal_hold', id, {}, reason.trim());
  return { ok: true };
}

// --- İmha adayları ve partiler ----------------------------------------------------------------------

interface DocRow { id: string; code: string | null; title: string; kind: string; company_id: string; company_name: string; last_version_at: string; disposed: boolean; versions: number }

async function loadRetentionInputs(tx: Tx, documentIds: string[] | null) {
  const policies: RetentionPolicy[] = (await tx.query(`SELECT document_kind AS "documentKind", retention_months AS "retentionMonths" FROM retention_policies`)).rows;
  const holds: LegalHold[] = (await tx.query(`SELECT scope, company_id AS "companyId", document_id AS "documentId", released_at AS "releasedAt" FROM legal_holds WHERE released_at IS NULL`)).rows;
  const docs = (await tx.query<DocRow>(`SELECT d.id, d.code, d.title, d.kind, d.company_id, le.name AS company_name,
      to_char(max(dv.created_at) AT TIME ZONE 'Europe/Istanbul', 'YYYY-MM-DD') AS last_version_at, count(dv.id)::int AS versions,
      EXISTS (SELECT 1 FROM document_disposals x WHERE x.document_id = d.id) AS disposed
    FROM documents d JOIN legal_entities le ON le.id = d.company_id JOIN document_versions dv ON dv.document_id = d.id
    WHERE ($1::uuid[] IS NULL OR d.id = ANY($1::uuid[]))
    GROUP BY d.id, le.name`, [documentIds])).rows;
  return { policies, holds, docs };
}

/** Çağıranın erişebildiği belgeler arasında süresi dolmuş ve hukuki saklamada olmayanlar. Açık bir imha partisindekiler ayrıca işaretlenir. */
export async function retentionCandidates(tx: Tx) {
  const { policies, holds, docs } = await loadRetentionInputs(tx, null);
  const inBatch = new Set((await tx.query<{ document_id: string }>(`SELECT i.document_id FROM disposal_items i JOIN disposal_batches b ON b.id = i.batch_id WHERE b.status = 'PROPOSED'`)).rows.map((r) => r.document_id));
  const t = today();
  const summary = { NO_POLICY: 0, NOT_DUE: 0, LEGAL_HOLD: 0, ALREADY_DISPOSED: 0, ELIGIBLE: 0 };
  const candidates: { id: string; code: string | null; title: string; kind: string; companyName: string; dueOn: string; versions: number; inOpenBatch: boolean }[] = [];
  for (const d of docs) {
    const v = retentionVerdict({ id: d.id, companyId: d.company_id, kind: d.kind, lastVersionAt: d.last_version_at, disposed: d.disposed }, policies, holds, t);
    if (v.eligible) {
      summary.ELIGIBLE++;
      candidates.push({ id: d.id, code: d.code, title: d.title, kind: d.kind, companyName: d.company_name, dueOn: v.dueOn, versions: d.versions, inOpenBatch: inBatch.has(d.id) });
    } else summary[v.reason]++;
  }
  candidates.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  return { asOf: t, summary, candidates };
}

export async function proposeDisposal(tx: Tx, ctx: TenantContext, b: { documentIds: string[]; reason: string }) {
  const ids = [...new Set(b.documentIds)];
  if (!ids.length) throw unprocessable('empty_batch', 'En az bir belge seçin.');
  const { policies, holds, docs } = await loadRetentionInputs(tx, ids);
  if (docs.length !== ids.length) throw unprocessable('invalid_reference', 'Seçilen belgelerden bazıları bulunamadı veya erişiminiz yok.');
  const t = today();
  const blocked: { id: string; reason: string }[] = [];
  const items: { id: string; companyId: string; dueOn: string }[] = [];
  for (const d of docs) {
    const v = retentionVerdict({ id: d.id, companyId: d.company_id, kind: d.kind, lastVersionAt: d.last_version_at, disposed: d.disposed }, policies, holds, t);
    if (v.eligible) items.push({ id: d.id, companyId: d.company_id, dueOn: v.dueOn }); else blocked.push({ id: d.id, reason: v.reason });
  }
  if (blocked.length) throw unprocessable('not_eligible', 'Seçimde imha için uygun olmayan belge var.', { blocked });
  const open = (await tx.query<{ document_id: string }>(`SELECT i.document_id FROM disposal_items i JOIN disposal_batches b ON b.id = i.batch_id
    WHERE b.status = 'PROPOSED' AND i.document_id = ANY($1::uuid[])`, [ids])).rows;
  if (open.length) throw conflict('in_open_batch', 'Seçilen belgelerden bazıları zaten onay bekleyen bir imha partisinde.', { documentIds: open.map((r) => r.document_id) });
  const batch = (await tx.query<{ id: string }>(`INSERT INTO disposal_batches (tenant_id, reason, proposed_by) VALUES ($1,$2,$3) RETURNING id`, [ctx.tenantId, b.reason.trim(), ctx.userId])).rows[0]!;
  for (const i of items) {
    await tx.query(`INSERT INTO disposal_items (tenant_id, batch_id, document_id, company_id, due_on) VALUES ($1,$2,$3,$4,$5)`, [ctx.tenantId, batch.id, i.id, i.companyId, i.dueOn]);
  }
  await openTask(tx, ctx, { companyId: null, kind: 'disposal.approval', entityType: 'disposal_batch', entityId: batch.id,
    title: `İmha onayı: ${items.length} belge`, reason: 'Saklama süresi dolan belgeler için imha önerildi. Öneren kişi onaylayamaz.',
    nextAction: 'Listeyi ve hukuki saklama durumunu inceleyip onaylayın veya reddedin.', assigneeRole: 'LEGAL', dedupeKey: `disposal:${batch.id}` });
  await audit(tx, ctx, 'disposal.proposed', 'disposal_batch', batch.id, { documentIds: items.map((i) => i.id) }, b.reason.trim());
  return { id: batch.id, itemCount: items.length };
}

export async function getBatch(tx: Tx, id: string) {
  const b = (await tx.query(`SELECT b.id, b.status, b.reason, b.proposed_by AS "proposedById", pu.display_name AS "proposedBy", b.proposed_at AS "proposedAt",
      du.display_name AS "decidedBy", b.decided_at AS "decidedAt", b.decision_note AS "decisionNote", b.executed_at AS "executedAt", b.result
    FROM disposal_batches b JOIN users pu ON pu.id = b.proposed_by LEFT JOIN users du ON du.id = b.decided_by WHERE b.id = $1`, [id])).rows[0];
  if (!b) throw notFound();
  const items = (await tx.query(`SELECT i.document_id AS "documentId", d.code, d.title, d.kind, le.name AS "companyName", i.due_on::text AS "dueOn",
      (SELECT dv.id FROM document_versions dv WHERE dv.document_id = i.document_id ORDER BY dv.version_no DESC LIMIT 1) AS "versionId",
      EXISTS (SELECT 1 FROM document_disposals x WHERE x.document_id = i.document_id) AS disposed
    FROM disposal_items i JOIN documents d ON d.id = i.document_id JOIN legal_entities le ON le.id = i.company_id WHERE i.batch_id = $1 ORDER BY i.due_on`, [id])).rows;
  const total = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM disposal_items WHERE batch_id = $1`, [id])).rows[0]!.n;
  // RLS şirket kapsamı nedeniyle bazı kalemler görünmüyorsa karar verilemez (bkz. decideDisposal).
  return { ...b, items, hiddenItems: total - items.length };
}

/**
 * İkinci kişinin kararı. Onayda her belge YENİDEN kontrol edilir (bu arada hukuki saklama veya yeni sürüm gelmiş olabilir);
 * uygun olmayanlar atlanır ve sonuçta gerekçesiyle görünür. Baytların silinmesi commit sonrası iş ile yapılır.
 */
export async function decideDisposal(tx: Tx, ctx: TenantContext, id: string, b: { decision: 'APPROVE' | 'REJECT'; note: string }) {
  await retentionLock(tx, ctx.tenantId);
  const batch = (await tx.query<{ status: string; proposed_by: string }>(`SELECT status, proposed_by FROM disposal_batches WHERE id = $1`, [id])).rows[0];
  if (!batch) throw notFound();
  if (batch.status !== 'PROPOSED') throw conflict('already_decided', 'Bu imha partisi için karar verilmiş.');
  if (batch.proposed_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'İmhayı öneren kişi onaylayamaz.');
  const items = (await tx.query<{ document_id: string }>(`SELECT document_id FROM disposal_items WHERE batch_id = $1`, [id])).rows.map((r) => r.document_id);
  const { policies, holds, docs } = await loadRetentionInputs(tx, items);
  if (docs.length !== items.length) throw new ApiError(403, 'scope_incomplete', 'Partide erişim kapsamınız dışında belge var; tüm şirketlere erişimi olan bir hukuk yetkilisi karar vermeli.');
  if (b.decision === 'REJECT') {
    await tx.query(`UPDATE disposal_batches SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [id, ctx.userId, b.note.trim()]);
    await closeTasks(tx, `disposal:${id}`);
    await audit(tx, ctx, 'disposal.rejected', 'disposal_batch', id, {}, b.note.trim());
    return { status: 'REJECTED' };
  }
  const t = today();
  const disposed: string[] = [];
  const skipped: { documentId: string; reason: string }[] = [];
  for (const d of docs) {
    const v = retentionVerdict({ id: d.id, companyId: d.company_id, kind: d.kind, lastVersionAt: d.last_version_at, disposed: d.disposed }, policies, holds, t);
    if (!v.eligible) { skipped.push({ documentId: d.id, reason: v.reason }); continue; }
    await tx.query(`INSERT INTO document_disposals (document_id, tenant_id, company_id, batch_id, disposed_by) VALUES ($1,$2,$3,$4,$5)`, [d.id, ctx.tenantId, d.company_id, id, ctx.userId]);
    disposed.push(d.id);
  }
  const keys = disposed.length ? (await tx.query<{ storage_key: string }>(`SELECT DISTINCT storage_key FROM document_versions WHERE document_id = ANY($1::uuid[])`, [disposed])).rows.map((r) => r.storage_key) : [];
  const result = { disposed: disposed.length, skipped, objectKeys: keys.length };
  await tx.query(`UPDATE disposal_batches SET status = 'EXECUTED', decided_by = $2, decided_at = now(), decision_note = $3, executed_at = now(), result = $4 WHERE id = $1`,
    [id, ctx.userId, b.note.trim(), result]);
  if (keys.length) {
    await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by) VALUES ($1,'retention.purge',$2,$3,$4) ON CONFLICT DO NOTHING`,
      [ctx.tenantId, `purge:${id}`, { batchId: id, keys }, ctx.userId]);
  }
  await closeTasks(tx, `disposal:${id}`);
  await audit(tx, ctx, 'disposal.executed', 'disposal_batch', id, { disposedDocumentIds: disposed, skipped }, b.note.trim());
  return { status: 'EXECUTED', ...result };
}

/** Commit sonrası: kiracıda başka canlı kayıt kullanmıyorsa nesne silinir. Tekrar çalıştırılabilir (silinmiş nesneyi silmek zararsızdır). */
export async function processPurge(tx: Tx, store: ObjectStore, jobId: string) {
  const j = (await tx.query<{ payload: { batchId: string; keys: string[] } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0]!;
  let deleted = 0; let kept = 0;
  for (const key of j.payload.keys) {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`obj:${key}`]);
    if ((await tx.query<{ used: boolean }>(`SELECT storage_key_in_use($1) AS used`, [key])).rows[0]!.used) { kept++; continue; }
    await store.delete(key);
    deleted++;
  }
  await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, { deleted, kept }]);
  // Baytların gerçekten silindiği partide görünür; silme işi bitmeden ekran "baytlar silindi" demez.
  await tx.query(`UPDATE disposal_batches SET result = result || jsonb_build_object('purge', $2::jsonb) WHERE id = $1`,
    [j.payload.batchId, JSON.stringify({ deleted, kept, at: new Date().toISOString() })]);
}

// --- Kiracı dışa aktarımı -----------------------------------------------------------------------------

/**
 * Onaylı ama işi artık yaşamayan (başarısız, engellenmiş, ölü veya 2 saattir ilerlemeyen) dışa aktarımlar "Hata" olur;
 * aksi halde tek açık talep kuralı kiracının yeni dışa aktarım istemesini kalıcı olarak engellerdi.
 */
async function failStaleExports(tx: Tx) {
  await tx.query(`UPDATE tenant_exports e SET status = 'FAILED', error = 'Paket hazırlanamadı (iş durdu veya talep eden yetkisini kaybetti); yeni dışa aktarım isteyin.'
    WHERE e.status = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'tenant.export' AND j.idempotency_key = 'export:' || e.id
      AND (j.status = 'QUEUED' OR (j.status = 'RUNNING' AND j.updated_at > now() - interval '2 hours')))`);
}

export async function listExports(tx: Tx) {
  await failStaleExports(tx);
  return (await tx.query(`SELECT e.id, e.status, e.reason, ru.display_name AS "requestedBy", e.requested_by AS "requestedById", e.requested_at AS "requestedAt",
      du.display_name AS "decidedBy", e.decided_at AS "decidedAt", e.decision_note AS "decisionNote", e.size_bytes::text AS "sizeBytes", e.sha256,
      e.manifest -> 'counts' AS counts, e.error, e.ready_at AS "readyAt", e.expires_at AS "expiresAt", (e.expires_at < now()) AS expired
    FROM tenant_exports e JOIN users ru ON ru.id = e.requested_by LEFT JOIN users du ON du.id = e.decided_by ORDER BY e.requested_at DESC LIMIT 20`)).rows;
}

export async function requestExport(tx: Tx, ctx: TenantContext, reason: string) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`tenant-export:${ctx.tenantId}`]);
  await failStaleExports(tx);
  if ((await tx.query(`SELECT 1 FROM tenant_exports WHERE status IN ('REQUESTED','APPROVED')`)).rowCount) throw conflict('export_in_progress', 'Bekleyen veya hazırlanan bir dışa aktarım var.');
  const e = (await tx.query<{ id: string }>(`INSERT INTO tenant_exports (tenant_id, reason, requested_by) VALUES ($1,$2,$3) RETURNING id`, [ctx.tenantId, reason.trim(), ctx.userId])).rows[0]!;
  await openTask(tx, ctx, { companyId: null, kind: 'tenant_export.approval', entityType: 'tenant_export', entityId: e.id,
    title: 'Kiracı verisinin tamamı için dışa aktarım onayı', reason: 'Dışa aktarım tüm şirketlerin belgelerini ve denetim izini içerir; ikinci kişi onayı gerekir.',
    nextAction: 'Gerekçeyi inceleyip onaylayın veya reddedin.', assigneeRole: 'LEGAL', severity: 'HIGH', dedupeKey: `tenant-export:${e.id}` });
  await audit(tx, ctx, 'tenant.export.requested', 'tenant_export', e.id, {}, reason.trim());
  return { id: e.id, status: 'REQUESTED' };
}

export async function decideExport(tx: Tx, ctx: TenantContext, id: string, b: { decision: 'APPROVE' | 'REJECT'; note: string }) {
  const e = (await tx.query<{ status: string; requested_by: string }>(`SELECT status, requested_by FROM tenant_exports WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!e) throw notFound();
  if (e.status !== 'REQUESTED') throw conflict('already_decided', 'Bu dışa aktarım için karar verilmiş.');
  if (e.requested_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Talep eden kişi onaylayamaz.');
  const status = b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await tx.query(`UPDATE tenant_exports SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [id, status, ctx.userId, b.note.trim()]);
  if (status === 'APPROVED') {
    // İş, talep edenin adına çalışır; çalıştığı anda kiracı yöneticisi rolü yeniden doğrulanır.
    await tx.query(`INSERT INTO jobs (tenant_id, kind, idempotency_key, payload, requested_by, max_attempts) VALUES ($1,'tenant.export',$2,$3,$4,2) ON CONFLICT DO NOTHING`,
      [ctx.tenantId, `export:${id}`, { exportId: id }, e.requested_by]);
  }
  await closeTasks(tx, `tenant-export:${id}`);
  await audit(tx, ctx, status === 'APPROVED' ? 'tenant.export.approved' : 'tenant.export.rejected', 'tenant_export', id, {}, b.note.trim());
  return { status };
}

const README = `Kiracı dışa aktarım paketi (sp-tenant-export/1)

manifest.json   Paket bilgisi: kiracı, talep/onay, tablo satır sayıları ve her dosyanın SHA-256 değeri.
data/*.jsonl    Her tablo için satır başına bir JSON kaydı. Para ve miktar ondalık metindir (yuvarlama yok).
files/<sha256>  Belgelerin özgün baytları; dosya adı içerik özetidir, manifest.json içindeki "files" listesi kaydı bağlar.

Yalnız bu kiracının verisi vardır (veritabanı satır güvenliği ile okunmuştur). Politika gereği görünmeyen kayıtlar
(ör. süresi dolmamış kapalı teklif zarfları) ve imha edilmiş belgelerin baytları pakette yoktur; imha kayıtları data/ altında görünür.
Paketi doğrulamak için: her dosyanın SHA-256 değerini manifest.json ile karşılaştırın.
`;

/** Worker: onaylı dışa aktarımı tek tutarlı anlık görüntüden üretir, nesne deposuna yazar. */
export async function processTenantExport(pool: pg.Pool, ctx: TenantContext, store: ObjectStore, jobId: string) {
  const job = await withTenant(pool, ctx, async (tx) => (await tx.query<{ payload: { exportId: string } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0]!);
  const exportId = job.payload.exportId;
  const fail = (code: string, msg: string) => withTenant(pool, ctx, async (tx) => {
    await tx.query(`UPDATE tenant_exports SET status = 'FAILED', error = $2 WHERE id = $1`, [exportId, msg]);
    await tx.query(`UPDATE jobs SET status = 'FAILED', error_code = $2, updated_at = now() WHERE id = $1`, [jobId, code]);
    await audit(tx, ctx, 'tenant.export.failed', 'tenant_export', exportId, { code });
  });
  const row = await withTenant(pool, ctx, async (tx) => (await tx.query<{ status: string; requested_by: string; decided_by: string; reason: string }>(
    `SELECT status, requested_by, decided_by, reason FROM tenant_exports WHERE id = $1`, [exportId])).rows[0]);
  if (!row || row.status !== 'APPROVED') return withTenant(pool, ctx, (tx) => tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = '{"skipped":true}', updated_at = now() WHERE id = $1`, [jobId]));
  if (!ctx.roles.includes('ADMIN')) return fail('REQUESTER_NOT_AUTHORIZED', 'Talep eden kişinin kiracı yöneticisi rolü kalmamış.');

  // Kapsam: kiracının tüm şirketleri (iki kişi onayıyla). Kiracı sınırı yine RLS'tedir.
  const companyIds = await withTenant(pool, ctx, async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM legal_entities`)).rows.map((r) => r.id));
  const scope: TenantContext = { ...ctx, companyIds };
  const generatedAt = new Date();
  // Ayrı üst önek: bucket yaşam döngüsü kuralı (`exports/`) yalnız dışa aktarım paketlerini siler, belgelere dokunmaz.
  const key = `exports/${ctx.tenantId}/${exportId}.zip`;
  // Akışlı üretim: satırlar imleçle parça parça okunur, paket nesne deposuna parçalı yüklenir; bellekte en çok bir parça.
  const upload = await store.putStream(key, 'application/zip');
  const zipHash = createHash('sha256');
  const tooLarge = () => new ApiError(413, 'export_too_large', `Dışa aktarım ${Math.round(MAX_EXPORT_BYTES / 1024 ** 3)} GB sınırını aşıyor; kurum yedeğinden geri yükleme yolunu kullanın.`);
  const zip = new ZipStreamWriter({ write: async (b) => {
    zipHash.update(b);
    await upload.write(b);
  } }, generatedAt);
  // Uzun süren paket "durdu" sayılmasın: iş kaydı ayrı bağlantıdan dakikada bir güncellenir.
  const beat = setInterval(() => { void withTenant(pool, ctx, (tx) => tx.query(`UPDATE jobs SET updated_at = now() WHERE id = $1`, [jobId])).catch(() => undefined); }, 60_000);
  try {
    const { counts, tableHashes, objs, tenantName } = await withTenant(pool, scope, async (tx) => {
      // Uygulama rolünün okuyabildiği, kiracı sütunu olan bütün tablolar; yalnız okuma izni olan sütunlar.
      const cols = (await tx.query<{ table_name: string; column_name: string }>(`
        SELECT c.table_name, c.column_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND has_column_privilege(current_user, format('public.%I', c.table_name), c.column_name, 'SELECT')
          AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.table_name AND k.column_name = 'tenant_id')
        ORDER BY c.table_name, c.ordinal_position`)).rows;
      const byTable = new Map<string, string[]>();
      for (const c of cols) byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
      const counts: Record<string, number> = {};
      const tableHashes: Record<string, string> = {};
      const addTable = async (name: string, sql: string) => {
        const entry = await zip.entry(`data/${name}.jsonl`);
        const hash = createHash('sha256');
        let n = 0;
        await tx.query(`DECLARE export_rows NO SCROLL CURSOR FOR ${sql}`);
        for (;;) {
          const rows = (await tx.query(`FETCH ${EXPORT_FETCH_ROWS} FROM export_rows`)).rows;
          if (!rows.length) break;
          const body = Buffer.from(rows.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8');
          hash.update(body); n += rows.length;
          await entry.write(body);
          if (zip.size > MAX_EXPORT_BYTES) throw tooLarge();
        }
        await tx.query(`CLOSE export_rows`);
        await entry.close();
        counts[name] = n; tableHashes[name] = hash.digest('hex');
      };
      const tenantName = (await tx.query<{ name: string }>(`SELECT name FROM tenants`)).rows[0]!.name;
      await addTable('tenants', `SELECT id, name, data_region, created_at FROM tenants`);
      await addTable('users', `SELECT u.id, u.email, u.display_name FROM users u WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id) ORDER BY u.email`);
      for (const [t, cs] of byTable) {
        const order = cs.includes('id') ? 'id' : cs[0]!;
        await addTable(t, `SELECT ${cs.map((c) => `"${c}"`).join(', ')} FROM "${t}" ORDER BY "${order}"`);
      }
      // Dosya listesi anlık görüntüden; baytlar görüntü kapandıktan sonra çekilir (uzun transaction temizliği bekletmesin).
      const objs = (await tx.query<{ storage_key: string; sha256: string; document_id: string | null }>(`
        SELECT DISTINCT ON (storage_key) storage_key, sha256, document_id FROM (
          SELECT dv.storage_key, dv.sha256, dv.document_id FROM document_versions dv WHERE NOT EXISTS (SELECT 1 FROM document_disposals x WHERE x.document_id = dv.document_id)
          UNION ALL SELECT b.storage_key, b.sha256, NULL FROM bid_files b) f ORDER BY storage_key`)).rows;
      return { counts, tableHashes, objs, tenantName };
    }, { snapshot: true });
    // Görüntüden sonra imha edilen belgenin baytı pakete girmez.
    const disposedNow = new Set(await withTenant(pool, scope, async (tx) => (await tx.query<{ document_id: string }>(
      `SELECT document_id FROM document_disposals WHERE document_id = ANY($1::uuid[])`, [objs.map((o) => o.document_id).filter(Boolean)])).rows.map((r) => r.document_id)));
    const files: { path: string; sha256: string; sizeBytes: number }[] = [];
    const missingFiles: string[] = [];
    for (const o of objs) {
      if (o.document_id && disposedNow.has(o.document_id)) continue;
      // Tek dosya yükleme sınırıyla (25 MB) sınırlıdır; özet doğrulanmadan pakete girmez.
      let bytes: Buffer;
      try { bytes = await store.get(o.storage_key); } catch { missingFiles.push(o.sha256); continue; }
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== o.sha256) { missingFiles.push(o.sha256); continue; } // bozulmuş nesne pakete "sağlam" diye girmez
      await zip.addFile(`files/${o.sha256}`, bytes);
      files.push({ path: `files/${o.sha256}`, sha256: o.sha256, sizeBytes: bytes.length });
      if (zip.size > MAX_EXPORT_BYTES) throw tooLarge();
    }
    const manifest = {
      format: 'sp-tenant-export/1', tenantId: ctx.tenantId, tenantName, generatedAt: generatedAt.toISOString(), exportId,
      requestedBy: row.requested_by, approvedBy: row.decided_by, reason: row.reason,
      tables: Object.fromEntries(Object.keys(counts).map((k) => [k, { rows: counts[k], sha256: tableHashes[k] }])), files, missingFiles,
    };
    for (const [name, body] of [['manifest.json', JSON.stringify(manifest, null, 2)], ['README.txt', README]] as const) {
      const e = await zip.entry(name);
      await e.write(Buffer.from(body));
      await e.close();
    }
    const sizeBytes = await zip.finish();
    await upload.finish();
    const sha256 = zipHash.digest('hex');
    await withTenant(pool, ctx, async (tx) => {
      await tx.query(`UPDATE tenant_exports SET status = 'READY', storage_key = $2, size_bytes = $3, sha256 = $4, manifest = $5, ready_at = now(),
        expires_at = now() + make_interval(days => $6) WHERE id = $1`,
        [exportId, key, sizeBytes, sha256, { counts, files: files.length, missingFiles: missingFiles.length }, EXPORT_TTL_DAYS]);
      await tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, { sizeBytes }]);
      await audit(tx, ctx, 'tenant.export.ready', 'tenant_export', exportId, { sizeBytes, sha256, files: files.length, missingFiles: missingFiles.length });
    });
  } catch (err) {
    await upload.abort();
    if (err instanceof ApiError) return fail(err.code, err.message);
    throw err;
  } finally {
    clearInterval(beat);
  }
}

/** Yalnız talep eden, hazır ve süresi dolmamış paketi indirir; her indirme bağlantısı denetime yazılır. */
export async function exportDownload(tx: Tx, ctx: TenantContext, store: ObjectStore, id: string, ttlSeconds: number) {
  const e = (await tx.query<{ status: string; requested_by: string; storage_key: string | null; expires_at: Date | null; sha256: string; size_bytes: string }>(
    `SELECT status, requested_by, storage_key, expires_at, sha256, size_bytes::text FROM tenant_exports WHERE id = $1`, [id])).rows[0];
  if (!e) throw notFound();
  if (e.requested_by !== ctx.userId) throw forbidden('tenant.export.download');
  if (e.status !== 'READY' || !e.storage_key) throw conflict('not_ready', 'Dışa aktarım henüz hazır değil.');
  if (e.expires_at && e.expires_at < new Date()) throw new ApiError(410, 'expired', 'İndirme süresi doldu; yeni dışa aktarım isteyin.');
  await audit(tx, ctx, 'tenant.export.download', 'tenant_export', id, { sha256: e.sha256 });
  const url = await store.signedGetUrl(e.storage_key, ttlSeconds, `kiraci-disa-aktarim-${id.slice(0, 8)}.zip`);
  return { url, expiresInSeconds: ttlSeconds, sha256: e.sha256, sizeBytes: e.size_bytes };
}
