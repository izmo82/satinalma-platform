import { randomUUID } from 'node:crypto';
import { can } from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { nextCode } from '../codes.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';
import { inspectUpload } from '../files.ts';
import { scanStatus, type AvScanner, type AvScanStatus } from '../av/index.ts';
import { listInfo } from './contractIntake.ts';
import { roleOf } from './contractChain.ts';

/**
 * v2 Faz 7 (D112) Görev 4: proje tamamlama (R5), çıkar çatışması beyanı (R9) ve uyum kanıtı yükleme (R8 kanıt kuralları için).
 * Denetim motoru Görev 6'dadır: tamamlama yalnız `compliance.audit` işini kuyruğa koyar (idempotent `audit:{proje}:completed`).
 */

export const AUDIT_JOB = 'compliance.audit';
/** R5: yalnız onaylı ya da eski kayıt sözleşme tamamlamaya yeter. Süresi dolmuş onaylı/eski kayıt (EXPIRED) da onaylı sayılır. */
const COMPLETING_STATUSES = new Set(['APPROVED', 'LEGACY', 'EXPIRED']);

interface ProjectFacts { id: string; code: string; title: string; status: string; company_id: string; owner_user_id: string; department_id: string | null;
  completed_on: string | null; completed_by: string | null }

async function projectFacts(tx: Tx, id: string, lock = false): Promise<ProjectFacts> {
  const p = (await tx.query<ProjectFacts>(`SELECT id, code, title, status, company_id, owner_user_id, department_id, completed_on::text AS completed_on, completed_by
    FROM projects WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!p) throw notFound();
  return p;
}

// ---------- R5: tamamlama ----------

/** Projeye bağlı (görülen) sözleşmelerin Faz 3 durumu; tamamlamaya yetenler ayrı. */
async function linkedContracts(tx: Tx, projectId: string) {
  const ids = (await tx.query<{ id: string }>(`SELECT id FROM contract_families WHERE project_id = $1`, [projectId])).rows.map((r) => r.id);
  const info = await listInfo(tx, ids);
  return ids.map((id) => ({ familyId: id, code: info.get(id)?.code ?? null, status: info.get(id)?.status ?? null }));
}

export const NOT_CONTRACTING_MESSAGE = 'Proje yalnız sözleşme aşamasındayken (kazanan kararı onaylandıktan sonra) tamamlanabilir.';
export const NO_CONTRACT_MESSAGE = 'Projeyi tamamlamak için projeye bağlı en az bir onaylı ya da eski kayıt sözleşme gerekli.';

/** Proje detayı için: tamamlanabilir mi, değilse neden (Türkçe). Yetki ayrıca `project.complete` ile denetlenir. */
export async function completionState(tx: Tx, p: { id: string; status: string }) {
  if (p.status === 'COMPLETED') return { ready: false, blockedReason: 'Proje tamamlandı.' };
  if (p.status !== 'CONTRACTING') return { ready: false, blockedReason: NOT_CONTRACTING_MESSAGE };
  const contracts = await linkedContracts(tx, p.id);
  if (!contracts.some((c) => c.status && COMPLETING_STATUSES.has(c.status))) return { ready: false, blockedReason: NO_CONTRACT_MESSAGE };
  return { ready: true, blockedReason: null };
}

export async function completeProject(tx: Tx, ctx: TenantContext, projectId: string) {
  const p = await projectFacts(tx, projectId, true);
  if (p.status === 'COMPLETED') throw conflict('invalid_state', 'Proje zaten tamamlandı.');
  if (p.status !== 'CONTRACTING') throw conflict('invalid_state', NOT_CONTRACTING_MESSAGE, { status: p.status });
  const contracts = await linkedContracts(tx, projectId);
  const qualifying = contracts.filter((c) => c.status && COMPLETING_STATUSES.has(c.status));
  if (!qualifying.length) throw conflict('no_approved_contract', NO_CONTRACT_MESSAGE, { contracts });
  // Tamamlanma günü Europe/Istanbul takvimine göre (R5, R6: kural seti bu güne göre seçilir).
  const done = (await tx.query<{ completed_on: string }>(`UPDATE projects SET status = 'COMPLETED', completed_on = (now() AT TIME ZONE 'Europe/Istanbul')::date,
      completed_by = $2, row_version = row_version + 1, updated_at = now() WHERE id = $1 RETURNING completed_on::text AS completed_on`, [projectId, ctx.userId])).rows[0]!;
  const auditJobId = await enqueueAudit(tx, ctx, p.company_id, projectId, 'COMPLETED');
  await audit(tx, ctx, 'project.completed', 'project', projectId,
    { completedOn: done.completed_on, contracts: qualifying.map((c) => ({ familyId: c.familyId, status: c.status })), auditJobId });
  return { status: 'COMPLETED' as const, completedOn: done.completed_on, auditJobId };
}

/**
 * Denetim işi (Görev 6 işler). Tamamlamada tekil anahtar `audit:{proje}:completed`: aynı tamamlama ikinci iş açmaz.
 * İş, isteyen kullanıcının güncel üyeliğiyle çalışır (worker deseni).
 */
export async function enqueueAudit(tx: Tx, ctx: TenantContext, companyId: string, projectId: string, trigger: 'COMPLETED' | 'RERUN', key = `audit:${projectId}:completed`) {
  const ins = await tx.query<{ id: string }>(`INSERT INTO jobs (tenant_id, company_id, kind, idempotency_key, payload, requested_by) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING RETURNING id`, [ctx.tenantId, companyId, AUDIT_JOB, key, { projectId, trigger }, ctx.userId]);
  if (ins.rows[0]) return ins.rows[0].id;
  return (await tx.query<{ id: string }>(`SELECT id FROM jobs WHERE tenant_id = $1 AND kind = $2 AND idempotency_key = $3`, [ctx.tenantId, AUDIT_JOB, key])).rows[0]!.id;
}

// ---------- R9: çıkar çatışması beyanı ----------

export const COI_TASK = 'coi_declaration';
export const coiTaskKey = (projectId: string, userId: string) => `coi:${projectId}:${userId}`;
type CoiRole = 'OWNER' | 'SCORER' | 'PROPOSER' | 'DECIDER';
const COI_ROLE_LABEL: Record<CoiRole, string> = { OWNER: 'Proje sahibi', SCORER: 'Puan veren', PROPOSER: 'Kazananı öneren', DECIDER: 'Kazanan kararını veren' };
export const COI_KIND_LABEL: Record<'NONE' | 'DECLARED', string> = { NONE: 'Çıkar çatışmam yok', DECLARED: 'Çıkar çatışması beyan edildi' };
const ROLE_ORDER: CoiRole[] = ['OWNER', 'SCORER', 'PROPOSER', 'DECIDER'];

/** Katılımcılar (R9): puan veren (`bid_scores.scored_by`), kazananı öneren/karar veren (`awards.proposed_by/decided_by`), proje sahibi. */
async function participants(tx: Tx, projectId: string, ownerId: string): Promise<Map<string, Set<CoiRole>>> {
  const rows = (await tx.query<{ user_id: string; role: CoiRole }>(
    `SELECT DISTINCT scored_by AS user_id, 'SCORER' AS role FROM bid_scores WHERE project_id = $1
     UNION SELECT DISTINCT proposed_by, 'PROPOSER' FROM awards WHERE project_id = $1
     UNION SELECT DISTINCT decided_by, 'DECIDER' FROM awards WHERE project_id = $1 AND decided_by IS NOT NULL`, [projectId])).rows;
  const out = new Map<string, Set<CoiRole>>([[ownerId, new Set<CoiRole>(['OWNER'])]]);
  for (const r of rows) out.set(r.user_id, (out.get(r.user_id) ?? new Set<CoiRole>()).add(r.role));
  return out;
}

async function latestDeclarations(tx: Tx, projectId: string) {
  return new Map((await tx.query<{ user_id: string; id: string; kind: 'NONE' | 'DECLARED'; statement: string | null; declared_at: Date; n: number }>(
    `SELECT DISTINCT ON (user_id) user_id, id, kind, statement, declared_at, count(*) OVER (PARTITION BY user_id)::int AS n
     FROM coi_declarations WHERE project_id = $1 ORDER BY user_id, declared_at DESC, id DESC`, [projectId])).rows.map((r) => [r.user_id, r]));
}

/**
 * Katılımcı olunca (ilk puan, öneri, karar) kişiye İşlerim görevi `coi_declaration` açılır. Daha önce beyan vermişse açılmaz
 * (beyan proje × kullanıcı başınadır; yeni katılım rolü yeni beyan istemez). Aynı açık görev ikinci kez oluşmaz.
 */
export async function ensureCoiTask(tx: Tx, ctx: TenantContext, projectId: string, userId: string): Promise<void> {
  if ((await tx.query(`SELECT 1 FROM coi_declarations WHERE project_id = $1 AND user_id = $2 LIMIT 1`, [projectId, userId])).rowCount) return;
  const p = (await tx.query<{ code: string; title: string; company_id: string }>(`SELECT code, title, company_id FROM projects WHERE id = $1`, [projectId])).rows[0];
  if (!p) return;
  await openTask(tx, ctx, {
    companyId: p.company_id, kind: COI_TASK, entityType: 'project', entityId: projectId,
    title: `Çıkar çatışması beyanı: ${p.code} ${p.title}`,
    reason: 'Bu projenin değerlendirme ya da karar sürecinde yer aldınız; çıkar çatışması beyanınız bekleniyor.',
    nextAction: '"Çıkar çatışmam yok" ya da "Çıkar çatışmam var" (açıklamayla) beyanını verin.',
    assigneeRole: await roleOf(tx, userId), assigneeUserId: userId, dedupeKey: coiTaskKey(projectId, userId),
  });
}

/** Proje katılımcısı olan işlemin yapanı ve proje sahibi için beyan görevi (puan, öneri, karar noktaları). */
export async function ensureCoiTasksFor(tx: Tx, ctx: TenantContext, projectId: string, actorId: string): Promise<void> {
  const owner = (await tx.query<{ owner_user_id: string }>(`SELECT owner_user_id FROM projects WHERE id = $1`, [projectId])).rows[0]?.owner_user_id;
  for (const u of new Set([actorId, owner].filter((x): x is string => !!x))) await ensureCoiTask(tx, ctx, projectId, u);
}

export async function coiSummary(tx: Tx, ctx: TenantContext, projectId: string) {
  const p = await projectFacts(tx, projectId);
  const parts = await participants(tx, projectId, p.owner_user_id);
  const latest = await latestDeclarations(tx, projectId);
  const names = new Map((await tx.query<{ id: string; display_name: string }>(`SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`,
    [[...parts.keys()]])).rows.map((u) => [u.id, u.display_name]));
  const items = [...parts.entries()].map(([userId, roles]) => {
    const d = latest.get(userId);
    const rs = ROLE_ORDER.filter((r) => roles.has(r));
    return { userId, name: names.get(userId) ?? null, isMe: userId === ctx.userId, roles: rs, roleLabels: rs.map((r) => COI_ROLE_LABEL[r]),
      latest: d ? { id: d.id, kind: d.kind, kindLabel: COI_KIND_LABEL[d.kind], statement: d.statement, declaredAt: d.declared_at, count: d.n } : null };
  }).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'tr'));
  const missing = items.filter((i) => !i.latest).map((i) => ({ userId: i.userId, name: i.name }));
  const conflicts = items.filter((i) => i.latest?.kind === 'DECLARED').map((i) => ({ userId: i.userId, name: i.name, statement: i.latest!.statement }));
  const mine = items.find((i) => i.isMe);
  return {
    participants: items, missing, conflicts,
    complete: missing.length === 0, hasConflict: conflicts.length > 0,
    status: missing.length ? 'MISSING' : conflicts.length ? 'DECLARED' : 'COMPLETE',
    statusLabel: missing.length ? `Eksik beyan: ${missing.length}` : conflicts.length ? 'Çıkar çatışması beyan edildi' : 'Tüm katılımcılar beyan verdi',
    me: { participant: !!mine, latest: mine?.latest ?? null, canDeclare: !!mine && can(ctx.roles, 'coi.declare') },
  };
}

export async function declareCoi(tx: Tx, ctx: TenantContext, projectId: string, body: { kind: 'NONE' | 'DECLARED'; statement?: string | null }) {
  const p = await projectFacts(tx, projectId);
  const parts = await participants(tx, projectId, p.owner_user_id);
  if (!parts.has(ctx.userId)) throw new ApiError(403, 'not_participant', 'Bu projenin katılımcısı (puan veren, kazananı öneren ya da karar veren, proje sahibi) değilsiniz; beyan veremezsiniz.');
  if (body.kind !== 'NONE' && body.kind !== 'DECLARED') throw unprocessable('invalid_kind', 'Beyan türü geçersiz.');
  const statement = (body.statement ?? '').trim();
  if (body.kind === 'DECLARED' && statement.length < 10) throw unprocessable('statement_required', 'Çıkar çatışmasını en az 10 karakterle açıklayın.');
  if (statement.length > 4000) throw unprocessable('statement_too_long', 'Açıklama en fazla 4000 karakter olabilir.');
  // Beyan değişmez; yenisi eklenir ve sonuncu geçerlidir (R9).
  const d = (await tx.query<{ id: string; declared_at: Date }>(`INSERT INTO coi_declarations (tenant_id, company_id, project_id, user_id, kind, statement)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, declared_at`, [ctx.tenantId, p.company_id, projectId, ctx.userId, body.kind, body.kind === 'DECLARED' ? statement : (statement || null)])).rows[0]!;
  await closeTasks(tx, coiTaskKey(projectId, ctx.userId));
  await audit(tx, ctx, 'coi.declared', 'project', projectId, { declarationId: d.id, kind: body.kind });
  return { id: d.id, kind: body.kind, kindLabel: COI_KIND_LABEL[body.kind], declaredAt: d.declared_at, coi: await coiSummary(tx, ctx, projectId) };
}

// ---------- Uyum kanıtı yükleme ----------

export const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;
export const EVIDENCE_KINDS = ['RESEARCH', 'TRADE_REGISTRY', 'OTHER'] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = { RESEARCH: 'Firma araştırması', TRADE_REGISTRY: 'Ticaret sicil gazetesi', OTHER: 'Diğer kanıt' };
const CHECK_KEY = /^[A-Za-z0-9_.-]{1,60}$/;
/** document_versions.av_scan_status sözlüğü (001): yapılandırılmamış tarayıcı `NOT_AVAILABLE`. */
const DV_AV: Record<AvScanStatus, string> = { NOT_CONFIGURED: 'NOT_AVAILABLE', CLEAN: 'CLEAN', INFECTED: 'INFECTED', ERROR: 'ERROR' };

export interface EvidenceUpload { filename: string; mimetype: string; body: Buffer; fields: Record<string, string> }
export type PreparedEvidence = Awaited<ReturnType<typeof prepareEvidenceUpload>>;

/** Dosya ve alan denetimi, tür koklama ve virüs taraması nesne deposuna yazmadan ve işlemden önce; anahtar rastgele (temizlik güvenli). */
export async function prepareEvidenceUpload(u: EvidenceUpload, tenantId: string, scanner: AvScanner | null) {
  const checkKey = (u.fields.checkKey ?? '').trim();
  if (!CHECK_KEY.test(checkKey)) throw unprocessable('invalid_check_key', 'Kontrol anahtarı geçersiz (harf, rakam, _ . - ; en fazla 60).', { field: 'checkKey' });
  const kind = (u.fields.kind ?? '').trim() as EvidenceKind;
  if (!EVIDENCE_KINDS.includes(kind)) throw unprocessable('invalid_kind', 'Kanıt türü geçersiz (Firma araştırması, Ticaret sicil gazetesi, Diğer).', { field: 'kind' });
  if (u.body.length > EVIDENCE_MAX_BYTES) throw unprocessable('file_too_large', 'Dosya 25 MB sınırını aşıyor.');
  const filename = (u.filename || 'kanit').slice(0, 255);
  const ins = inspectUpload(filename, u.mimetype, u.body);
  if ('rejected' in ins) throw new ApiError(415, 'unsupported_file', ins.rejected, { file: filename });
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(ins.mimeType)) throw new ApiError(415, 'unsupported_file', 'Desteklenmeyen dosya türü. PDF, PNG veya JPEG yükleyin.', { file: filename });
  const av = await scanStatus(scanner, u.body);
  if (av === 'INFECTED') throw unprocessable('file_infected', 'Dosyada virüs bulundu; belge kaydedilmedi.', { file: filename });
  const quarantined = av === 'ERROR' || ins.status === 'QUARANTINED';
  return { checkKey, kind, title: (u.fields.title ?? '').trim().slice(0, 200) || filename, filename, mimeType: ins.mimeType, sizeBytes: ins.sizeBytes,
    sha256: ins.sha256, pageCount: ins.pageCount, storageKey: `t/${tenantId}/compliance-evidence/${randomUUID()}`,
    basicCheckStatus: quarantined ? 'QUARANTINED' as const : 'PASSED' as const,
    basicCheckReason: av === 'ERROR' ? 'Virüs taraması yapılamadı; dosya karantinada.' : ins.reason, avScanStatus: DV_AV[av] };
}

const EVIDENCE_SELECT = `SELECT x.id, x.check_key AS "checkKey", x.kind, x.document_version_id AS "documentVersionId", d.id AS "documentId", d.code AS "documentCode",
    d.title, dv.original_filename AS filename, dv.mime_type AS "mimeType", dv.size_bytes::int AS "sizeBytes", dv.page_count AS "pageCount",
    dv.basic_check_status AS "basicCheckStatus", dv.basic_check_reason AS "basicCheckReason", dv.av_scan_status AS "avScanStatus",
    x.uploaded_by AS "uploadedById", u.display_name AS "uploadedBy", x.created_at AS "createdAt"
  FROM compliance_evidence x JOIN document_versions dv ON dv.id = x.document_version_id JOIN documents d ON d.id = dv.document_id
  JOIN users u ON u.id = x.uploaded_by`;
const evidenceView = (r: any) => ({ ...r, kindLabel: EVIDENCE_KIND_LABEL[r.kind as EvidenceKind] ?? r.kind,
  basicCheckLabel: r.basicCheckStatus === 'PASSED' ? 'Temel kontrol geçti' : 'Karantinada',
  contentUrl: r.basicCheckStatus === 'PASSED' ? `/api/v1/document-versions/${r.documentVersionId}/content` : null });

/**
 * Kanıt kaydı: mevcut belge deposu (`documents.kind = 'OTHER'`, `document_versions`; karantina kuralları ve görevi aynen).
 * Proje çağıranın RLS'iyle görünür olmalı (Departman kullanıcısı yalnız kendi departmanının projesi; 055 politikası da denetler).
 */
export async function addEvidence(tx: Tx, ctx: TenantContext, projectId: string, f: PreparedEvidence) {
  const p = await projectFacts(tx, projectId);
  if (!ctx.companyIds.includes(p.company_id)) throw notFound();
  const documentId = (await tx.query<{ id: string }>(`INSERT INTO documents (tenant_id, company_id, kind, title, created_by, code) VALUES ($1,$2,'OTHER',$3,$4,$5) RETURNING id`,
    [ctx.tenantId, p.company_id, f.title, ctx.userId, await nextCode(tx, ctx, 'document', 'BLG')])).rows[0]!.id;
  const dvId = (await tx.query<{ id: string }>(`INSERT INTO document_versions (tenant_id, company_id, document_id, version_no, sha256, mime_type, size_bytes, storage_key,
      original_filename, basic_check_status, basic_check_reason, av_scan_status, page_count, created_by)
    VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [ctx.tenantId, p.company_id, documentId, f.sha256, f.mimeType, f.sizeBytes, f.storageKey, f.filename, f.basicCheckStatus, f.basicCheckReason,
      f.avScanStatus, f.pageCount, ctx.userId])).rows[0]!.id;
  const id = (await tx.query<{ id: string }>(`INSERT INTO compliance_evidence (tenant_id, company_id, project_id, check_key, document_version_id, kind, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.tenantId, p.company_id, projectId, f.checkKey, dvId, f.kind, ctx.userId])).rows[0]!.id;
  await audit(tx, ctx, 'document.version.created', 'document_version', dvId,
    { documentId, versionNo: 1, sha256: f.sha256, sizeBytes: f.sizeBytes, basicCheck: f.basicCheckStatus });
  if (f.basicCheckStatus === 'QUARANTINED') {
    await openTask(tx, ctx, {
      companyId: p.company_id, kind: 'DOCUMENT_QUARANTINED', entityType: 'document_version', entityId: dvId,
      title: 'Belge karantinada', reason: f.basicCheckReason ?? 'Güvenlik kontrolü geçmedi.',
      nextAction: 'Göndericiden temiz/şifresiz belge isteyin.', assigneeRole: 'PROCUREMENT', severity: 'HIGH', dedupeKey: `doc:${dvId}:quarantine`,
    });
  }
  await audit(tx, ctx, 'compliance.evidence_uploaded', 'project', projectId, { evidenceId: id, checkKey: f.checkKey, kind: f.kind, documentVersionId: dvId,
    basicCheck: f.basicCheckStatus, avScanStatus: f.avScanStatus });
  return evidenceView((await tx.query(`${EVIDENCE_SELECT} WHERE x.id = $1`, [id])).rows[0]);
}

/** Yükleme öncesi: proje çağıranın RLS'iyle görünür ve şirket kapsamında (görünmüyorsa 404; gövde okunmaz). */
export async function assertProjectVisible(tx: Tx, ctx: TenantContext, projectId: string) {
  const p = await projectFacts(tx, projectId);
  if (!ctx.companyIds.includes(p.company_id)) throw notFound();
}

export async function listEvidence(tx: Tx, projectId: string, checkKey?: string) {
  await projectFacts(tx, projectId);
  const rows = (await tx.query(`${EVIDENCE_SELECT} WHERE x.project_id = $1 AND ($2::text IS NULL OR x.check_key = $2) ORDER BY x.created_at DESC, x.id`,
    [projectId, checkKey ?? null])).rows;
  return { items: rows.map(evidenceView) };
}
