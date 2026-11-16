import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import type pg from 'pg';
import { can, dec as decimal, supplierOptionLabels, taxIdTail, type Permission } from '@sp/domain';
import type { Config } from './config.ts';
import { withTenant, type TenantContext, type Tx } from './db.ts';
import { DevAuthProvider, identityFor, resolveIdentity, tenantContext, type AuthProvider } from './auth.ts';
import { DEFAULT_SESSION, WebSessions } from './webSession.ts';
import { ApiError, forbidden, notFound, unprocessable } from './errors.ts';
import type { ObjectStore } from './storage.ts';
import { MAX_UPLOAD_BYTES } from './files.ts';
import { submitSellerIdentity, uploadDocument } from './modules/documents.ts';
import { activateSupplier, recordApproval, resolveIdentity as resolveSupplierIdentity } from './modules/suppliers.ts';
import * as tcmb from './modules/tcmb.ts';
import * as contracts from './modules/contracts.ts';
import * as sourcing from './modules/sourcing.ts';
import * as lifecycle from './modules/contractTerms.ts';
import * as invoices from './modules/invoices.ts';
import * as evals from './modules/supplierEval.ts';
import * as ai from './modules/ai.ts';
import * as kpi from './modules/kpi.ts';
import * as gov from './modules/governance.ts';
import * as integration from './modules/integration.ts';
import * as commercial from './modules/commercial.ts';
import * as approvals from './modules/approvals.ts';
import * as search from './modules/search.ts';
import * as recovery from './modules/recovery.ts';
import { decisionSummaryPdf, evaluationWorkbook } from './reports.ts';
import { RateLimiter, rateLimited } from './rateLimit.ts';

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  auth: AuthProvider;
  store: ObjectStore;
}

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const sigMethod = { type: 'string', enum: ['WET_IMAGE_REVIEW', 'QUALIFIED_ELECTRONIC', 'ELECTRONIC_OTHER', 'HYBRID', 'NOT_REQUIRED', 'PENDING_CLASSIFICATION'] } as const;
const stage = { type: 'string', enum: ['DRAFT', 'EXECUTION', 'ARCHIVE_IMPORT'] } as const;
const text = (max = 2000) => ({ type: 'string', minLength: 1, maxLength: max }) as const;

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: deps.config.env === 'test' ? false : {
      // Belge içeriği, token ve kimlik verisi loglanmaz.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: { req: (r) => ({ method: r.method, url: r.url.split('?')[0], id: r.id }) },
    },
    bodyLimit: 1024 * 1024,
    trustProxy: deps.config.trustProxy ?? false,
    ajv: { customOptions: { removeAdditional: false, allErrors: true } },
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Satınalma ve Sözleşme Platformu API', version: '0.1.0',
        description: 'Kiracı bağlamı doğrulanmış üyelikten türetilir; X-Tenant-Id yalnız seçim bildirir.' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
  });
  await app.register(cors, {
    origin: [deps.config.webOrigin, ...(deps.config.extraWebOrigins ?? [])], credentials: false,
    exposedHeaders: ['ETag', 'X-Correlation-Id', 'Retry-After', 'X-SP-User'], allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'X-Tenant-Id', 'X-Correlation-Id', 'X-SP-CSRF', 'X-SP-Expect-User'],
  });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } });

  const sessions = new WebSessions(deps.pool, deps.config.session ?? DEFAULT_SESSION, deps.config.webOrigin, deps.config.oidc, deps.auth, deps.config.extraWebOrigins);
  const limiter = deps.config.rateLimit?.enabled ? new RateLimiter(deps.config.rateLimit) : null;
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError) {
      // Kimlik doğrulaması başarısız: adres başına sınırlı (geçerli token buraya hiç gelmez).
      const wait = err.status === 401 && limiter ? limiter.authFailure(req.ip) : null;
      if (wait) return reply.header('Retry-After', String(wait)).status(429).send(rateLimited(wait));
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.validation) {
      return reply.status(400).send({ error: { code: 'validation_failed', message: 'İstek doğrulanamadı.',
        details: err.validation.map((v: any) => ({ field: v.instancePath || v.params?.missingProperty, message: v.message })) } });
    }
    if (err.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') return reply.status(415).send({ error: { code: 'multipart_required', message: 'Dosya çok parçalı form (multipart/form-data) ile gönderilmeli.' } });
    // Metinde NUL baytı veya geçersiz UTF-8: veritabanına gitmeden önce yakalanmayan girdi; istemci hatasıdır.
    if (err.code === '22021' || err.code === '22P05') return reply.status(400).send({ error: { code: 'validation_failed', message: 'Girdide geçersiz karakter var.' } });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: { code: 'file_too_large', message: 'Dosya 25 MB sınırını aşıyor.' } });
    // PostgreSQL kısıtları: iş kuralı ihlali olarak döner, ayrıntı sızdırmaz.
    if (err.code === '23505') return reply.status(409).send({ error: { code: 'duplicate', message: 'Bu kayıt zaten mevcut.' } });
    if (err.code === '23514') return reply.status(422).send({ error: { code: 'rule_violation', message: 'İş kuralı ihlali.', details: { constraint: err.constraint } } });
    if (err.code === 'P0001') return reply.status(409).send({ error: { code: 'immutable_record', message: 'Tamamlanmış kayıt değiştirilemez; ters işlem kullanın.' } });
    if (err.code === '42501') return reply.status(404).send({ error: { code: 'not_found', message: 'Kayıt bulunamadı veya erişim yetkiniz yok.' } });
    if (err.code === '22P02') return reply.status(400).send({ error: { code: 'validation_failed', message: 'Geçersiz kimlik biçimi.' } });
    // Çerçevenin istemci hataları (boş veya bozuk JSON gövdesi vb.): 500 değil, kendi 4xx kodu.
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      const message = err.statusCode === 413 ? 'İstek gövdesi çok büyük.' : err.statusCode === 415 ? 'İstek içerik türü desteklenmiyor.' : 'İstek okunamadı: gövde boş veya geçersiz.';
      return reply.status(err.statusCode).send({ error: { code: 'bad_request', message } });
    }
    req.log.error({ err: { message: err.message, code: err.code } }, 'unhandled');
    return reply.status(500).send({ error: { code: 'internal', message: 'Beklenmeyen bir hata oluştu. İşlem kaydedilmedi.' } });
  });

  if (limiter) app.addHook('onRequest', limiter.onRequest((req) => sessions.rateKey(req)));

  // API doğrudan erişildiğinde de (ters vekil olmadan) içerik türü tahmin edilmez.
  // X-SP-User: yanıtı üreten oturumun kullanıcısı. Web oturumu sekmeler arasında ortak çerezdir; başka sekmede kullanıcı
  // değişirse istemci bunu görür ve eski kullanıcının ekranında yeni kullanıcı adına işlem yapılmaz.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    const uid = (req as FastifyRequest & { spUserId?: string }).spUserId;
    if (uid) reply.header('X-SP-User', uid);
  });

  /**
   * Yanıtı üreten kullanıcıyı işaretler; istemci beklediği kullanıcıyı bildirdiyse (`X-SP-Expect-User`) ve oturum başka
   * kullanıcıya geçmişse (ortak çerez, başka sekmede giriş) istek yürütülmeden 409 döner: eski kullanıcının ekranından yeni
   * kullanıcı adına karar verilemez.
   */
  function bindUser(req: FastifyRequest, userId: string) {
    (req as FastifyRequest & { spUserId?: string }).spUserId = userId;
    const expect = req.headers['x-sp-expect-user'];
    if (typeof expect === 'string' && expect !== userId) {
      throw new ApiError(409, 'identity_changed', 'Bu tarayıcıda oturum başka bir kullanıcıya geçti; sayfa yeniden yükleniyor. İşlem yapılmadı.');
    }
  }
  /** Kimlik → üyelik → kiracı bağlamı → izin → RLS'li transaction. */
  async function scoped<T>(req: FastifyRequest, perm: Permission | null, fn: (tx: Tx, ctx: TenantContext) => Promise<T>): Promise<T> {
    const identity = await resolveIdentity(deps.pool, deps.auth, req, sessions);
    bindUser(req, identity.userId);
    const ctx = tenantContext(identity, req);
    if (perm && !can(ctx.roles, perm)) throw forbidden(perm);
    return withTenant(deps.pool, ctx, (tx) => fn(tx, ctx));
  }
  const ifMatch = (req: FastifyRequest) => (typeof req.headers['if-match'] === 'string' ? req.headers['if-match'] : undefined);
  /** İstemci tekrar anahtarı (zayıf bağlantıda yanıtı kaybolan isteği tekrar göndermek güvenli olsun). */
  const idemKey = (req: FastifyRequest) => {
    const k = req.headers['idempotency-key'];
    return typeof k === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(k) ? k : undefined;
  };

  app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));
  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // --- Oturum yapılandırması (herkese açık; sır içermez) -------------------------
  // Web aynı imajla her ortamda çalışsın diye IdP bilgisi derleme anında değil çalışma anında okunur. Web artık token görmez
  // (BFF, D78); uç noktalar iOS istemcisi (Bearer + PKCE) içindir.
  app.get('/api/v1/auth/config', { schema: { tags: ['auth'] } }, async () => {
    const oidc = deps.config.oidc;
    if (!oidc) return { mode: 'dev' as const };
    const d = await sessions.discoveryDoc();
    return {
      mode: 'oidc' as const, issuer: oidc.issuer, clientId: oidc.clientId, nativeClientId: oidc.nativeClientId ?? null, scope: oidc.scope, resource: oidc.resource,
      authorizationEndpoint: d.authorization_endpoint, tokenEndpoint: d.token_endpoint,
      endSessionEndpoint: d.end_session_endpoint ?? null, revocationEndpoint: d.revocation_endpoint ?? null,
    };
  });

  // --- Web oturumu (BFF): token sunucuda, tarayıcıda yalnız HttpOnly çerez -----------------------------------------
  app.get('/api/v1/auth/login', { schema: { tags: ['auth'], querystring: { type: 'object', properties: { returnTo: { type: 'string', maxLength: 2000 } } } } },
    async (req, reply) => reply.redirect(await sessions.beginLogin(reply, (req.query as { returnTo?: string }).returnTo ?? '/'), 302));
  app.post('/api/v1/auth/session', { schema: { tags: ['auth'], body: { type: 'object', required: ['code', 'state'], additionalProperties: false,
    properties: { code: { type: 'string', minLength: 1, maxLength: 4000 }, state: { type: 'string', minLength: 1, maxLength: 200 } } } } }, async (req, reply) => {
    const b = req.body as { code: string; state: string };
    const r = await sessions.completeLogin(req, reply, b.code, b.state);
    // Davetsiz hesap için oturum açılmaz (identityFor 403 not_invited verir); ilk girişte davet burada bağlanır.
    await identityFor(deps.pool, r.subject);
    await sessions.create(reply, r.subject.subject, 'oidc', r.tokens, req);
    return { returnTo: r.returnTo };
  });
  app.post('/api/v1/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => ({ endSessionUrl: await sessions.logout(req, reply) }));

  // --- Yalnız development: sentetik kullanıcı oturumu ---------------------------
  if (deps.auth instanceof DevAuthProvider && deps.config.env !== 'production') {
    const devAuth = deps.auth;
    app.post('/api/v1/dev/token', {
      schema: { tags: ['dev'], body: { type: 'object', required: ['email'], properties: { email: { type: 'string', maxLength: 200 } } } },
    }, async (req) => {
      const { email } = req.body as { email: string };
      const subject = `dev|${email.toLowerCase()}`;
      const r = await deps.pool.query('SELECT id FROM auth_user_by_subject($1)', [subject]);
      if (!r.rowCount) throw new ApiError(404, 'unknown_dev_user', 'Sentetik kullanıcı bulunamadı.');
      return { token: await devAuth.issue(subject), synthetic: true };
    });
    // Web geliştirme girişi de çerezli oturumla (üretimdeki BFF ile aynı yol); token tarayıcıya verilmez.
    app.post('/api/v1/dev/session', {
      schema: { tags: ['dev'], body: { type: 'object', required: ['email'], properties: { email: { type: 'string', maxLength: 200 } } } },
    }, async (req, reply) => {
      if (req.headers['x-sp-csrf'] !== '1') throw new ApiError(403, 'csrf', 'İstek doğrulanamadı.');
      const subject = `dev|${(req.body as { email: string }).email.toLowerCase()}`;
      const r = await deps.pool.query('SELECT id FROM auth_user_by_subject($1)', [subject]);
      if (!r.rowCount) throw new ApiError(404, 'unknown_dev_user', 'Sentetik kullanıcı bulunamadı.');
      await sessions.create(reply, subject, 'dev', null, req);
      return { synthetic: true };
    });
  }

  app.get('/api/v1/me', async (req) => {
    const identity = await resolveIdentity(deps.pool, deps.auth, req, sessions);
    bindUser(req, identity.userId);
    let active: TenantContext | null = null;
    try { active = tenantContext(identity, req); } catch { active = null; }
    const companies = active ? await withTenant(deps.pool, active, async (tx) =>
      (await tx.query(`SELECT id, name, country, default_currency FROM legal_entities WHERE id = ANY($1::uuid[]) ORDER BY name`, [active!.companyIds])).rows) : [];
    return {
      user: { id: identity.userId, email: identity.email, displayName: identity.displayName },
      memberships: identity.memberships.map((m) => ({ tenantId: m.tenantId, tenantName: m.tenantName, roles: m.roles })),
      activeTenantId: active?.tenantId ?? null,
      roles: active?.roles ?? [],
      supplierPortal: !!active?.supplierId,
      companies,
    };
  });

  /** Tedarikçi portalı kullanıcısı iç ekranların yardımcı uçlarını (kullanıcı listesi, tatiller, görünümler) kullanamaz. */
  const internalOnly = (ctx: TenantContext) => { if (ctx.supplierId) throw forbidden('internal'); };
  app.get('/api/v1/members', async (req) => scoped(req, null, async (tx, ctx) => {
    internalOnly(ctx);
    return (await tx.query(`SELECT u.id, u.display_name AS "displayName" FROM users u JOIN memberships m ON m.user_id = u.id ORDER BY u.display_name`)).rows;
  }));

  // --- İşlerim (UX01) -----------------------------------------------------------
  // --- Üst çubuk: arama, bildirim, kayıtlı görünümler (izin türe göre modül içinde) ---
  app.get('/api/v1/search', { schema: { tags: ['search'], querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 100 } } } } }, async (req) =>
    scoped(req, null, (tx, ctx) => search.search(tx, ctx, (req.query as any).q)));
  app.get('/api/v1/notifications', { schema: { tags: ['search'] } }, async (req) => scoped(req, 'task.read', (tx, ctx) => search.notifications(tx, ctx)));
  app.post('/api/v1/notifications/seen', { schema: { tags: ['search'] } }, async (req) => scoped(req, 'task.read', (tx, ctx) => search.markSeen(tx, ctx)));
  const viewPage = { type: 'string', enum: ['projects', 'invoices', 'purchase_orders', 'tasks', 'suppliers', 'contracts'] } as const;
  // Görünüm, ait olduğu listeyi okuma izni gerektirir: listeyi göremeyen (ör. tedarikçi) onun görünümünü de okuyamaz/kaydedemez.
  const viewPerm = { projects: 'project.read', invoices: 'invoice.read', purchase_orders: 'po.read', tasks: 'task.read', suppliers: 'supplier.read', contracts: 'contract.read' } as const satisfies Record<(typeof viewPage.enum)[number], Permission>;
  app.get('/api/v1/saved-views', { schema: { tags: ['search'], querystring: { type: 'object', required: ['page'], properties: { page: viewPage } } } }, async (req) =>
    scoped(req, viewPerm[(req.query as { page: keyof typeof viewPerm }).page], async (tx) => ({ items: await search.listViews(tx, (req.query as any).page) })));
  app.post('/api/v1/saved-views', { schema: { tags: ['search'], body: { type: 'object', additionalProperties: false, required: ['page', 'name', 'params'],
    properties: { page: viewPage, name: text(60), params: { type: 'object' } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, viewPerm[(req.body as { page: keyof typeof viewPerm }).page], (tx, ctx) => search.saveView(tx, ctx, req.body as any))));
  app.delete('/api/v1/saved-views/:id', { schema: { tags: ['search'], params: idParams } }, async (req) => scoped(req, null, (tx, ctx) => {
    internalOnly(ctx);
    return search.deleteView(tx, (req.params as any).id);
  }));

  app.get('/api/v1/tasks', {
    schema: { tags: ['tasks'], querystring: { type: 'object', properties: { view: { type: 'string', enum: ['mine', 'overdue', 'all'] } } } },
  }, async (req) => scoped(req, 'task.read', async (tx, ctx) => {
    const view = (req.query as { view?: string }).view ?? 'mine';
    // Kullanıcının rolüne atanmamış işler sayılmaz bile (yetkisiz iş sayısı sızdırılmaz).
    // Kayıt no: görevin bağlı olduğu kaydın kiracı içi numarası. Varlığa erişim yoksa (RLS) boş kalır, uydurulmaz.
    const r = await tx.query(
      `SELECT t.id, t.kind, t.entity_type AS "entityType", t.entity_id AS "entityId", t.title, t.reason, t.next_action AS "nextAction",
              t.assignee_role AS "assigneeRole", t.severity, t.due_at AS "dueAt", t.created_at AS "createdAt", t.company_id AS "companyId",
              CASE t.entity_type
                WHEN 'project' THEN (SELECT p.code FROM projects p WHERE p.id = t.entity_id)
                WHEN 'contract_version' THEN (SELECT f.code FROM contract_versions cv JOIN contract_families f ON f.id = cv.family_id WHERE cv.id = t.entity_id)
                WHEN 'document_version' THEN (SELECT d.code FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = t.entity_id)
                WHEN 'supplier' THEN (SELECT s.tax_id_type || ' ' || s.tax_id FROM suppliers s WHERE s.id = t.entity_id)
                WHEN 'invoice' THEN (SELECT i.invoice_no FROM invoices i WHERE i.id = t.entity_id)
                WHEN 'incident' THEN (SELECT x.code FROM supplier_incidents x WHERE x.id = t.entity_id)
                WHEN 'recovery_case' THEN (SELECT x.code FROM recovery_cases x WHERE x.id = t.entity_id)
              END AS "refNo"
       FROM tasks t WHERE t.status = 'OPEN' AND t.assignee_role = ANY($1::text[])
         AND ($2 <> 'overdue' OR (t.due_at IS NOT NULL AND t.due_at < now()))
         AND ($2 <> 'mine' OR t.assignee_user_id IS NULL OR t.assignee_user_id = $3)
       ORDER BY CASE t.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END, t.due_at NULLS LAST, t.created_at
       LIMIT 200`, [ctx.roles, view, ctx.userId]);
    // Sekme sayıları aynı yetki sınırıyla: yalnız kullanıcının rolüne atanmış işler.
    const c = (await tx.query<{ mine: number; overdue: number; all: number }>(
      `SELECT count(*) FILTER (WHERE assignee_user_id IS NULL OR assignee_user_id = $2)::int AS mine,
              count(*) FILTER (WHERE due_at IS NOT NULL AND due_at < now())::int AS overdue, count(*)::int AS "all"
       FROM tasks WHERE status = 'OPEN' AND assignee_role = ANY($1::text[])`, [ctx.roles, ctx.userId])).rows[0];
    return { items: r.rows, counts: c };
  }));

  // --- Belgeler -----------------------------------------------------------------
  app.post('/api/v1/documents', { schema: { tags: ['documents'], consumes: ['multipart/form-data'] } }, async (req, reply) => {
    const file = await req.file();
    if (!file) throw new ApiError(400, 'file_required', 'Dosya gerekli.');
    const f = file.fields as Record<string, { value?: string } | undefined>;
    const companyId = f.companyId?.value ?? '';
    const kind = f.kind?.value as 'INVOICE' | 'CONTRACT' | 'QUOTE' | 'OTHER';
    if (!/^[0-9a-f-]{36}$/.test(companyId) || !['INVOICE', 'CONTRACT', 'QUOTE', 'OTHER'].includes(kind)) {
      throw new ApiError(400, 'validation_failed', 'companyId ve kind gerekli.');
    }
    const documentId = f.documentId?.value && /^[0-9a-f-]{36}$/.test(f.documentId.value) ? f.documentId.value : null;
    const body = await file.toBuffer();
    const result = await scoped(req, 'document.upload', (tx, ctx) => uploadDocument(tx, ctx, deps.store, {
      companyId, kind, documentId, title: (f.title?.value || file.filename).slice(0, 200), filename: file.filename, mimeType: file.mimetype, body,
    }));
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.get('/api/v1/document-versions/:id', { schema: { tags: ['documents'], params: idParams } }, async (req) =>
    scoped(req, 'document.read', async (tx) => {
      const { id } = req.params as { id: string };
      const v = await tx.query(
        `SELECT dv.id, dv.document_id AS "documentId", dv.version_no AS "versionNo", dv.sha256, dv.mime_type AS "mimeType",
                dv.size_bytes AS "sizeBytes", dv.original_filename AS "filename", dv.basic_check_status AS "basicCheckStatus",
                dv.basic_check_reason AS "basicCheckReason", dv.av_scan_status AS "avScanStatus", dv.page_count AS "pageCount",
                dv.company_id AS "companyId", d.kind, d.title, dv.created_at AS "createdAt",
                (SELECT x.disposed_at FROM document_disposals x WHERE x.document_id = dv.document_id) AS "disposedAt"
         FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = $1`, [id]);
      if (!v.rows[0]) throw notFound();
      const fields = await tx.query(
        `SELECT id, field, value, origin, source_ref AS "sourceRef", confidence, review_state AS "reviewState", created_at AS "createdAt"
         FROM extracted_fields WHERE document_version_id = $1 ORDER BY created_at`, [id]);
      const links = await tx.query(
        `SELECT l.supplier_id AS "supplierId", s.legal_name AS "legalName", s.status, l.name_mismatch AS "nameMismatch", l.extracted_name AS "extractedName"
         FROM supplier_document_links l JOIN suppliers s ON s.id = l.supplier_id WHERE l.document_version_id = $1`, [id]);
      const ubl = await tx.query(
        `SELECT rule_set AS "ruleSet", error_count AS errors, warning_count AS warnings, findings, profile_id AS "profileId", type_code AS "typeCode",
                bill_refs AS "billingReferences", checked_at AS "checkedAt" FROM einvoice_checks WHERE document_version_id = $1`, [id]);
      return { ...v.rows[0], fields: fields.rows, suppliers: links.rows, ublCheck: ubl.rows[0] ?? null };
    }));

  // Orijinal baytlar yetki kontrolünden sonra API üzerinden akıtılır (kısa ömürlü, önbelleklenmez).
  app.get('/api/v1/document-versions/:id/content', { schema: { tags: ['documents'], params: idParams } }, async (req, reply) => {
    const meta = await scoped(req, 'document.read', async (tx, ctx) => {
      const { id } = req.params as { id: string };
      const r = await tx.query<{ storage_key: string; mime_type: string; basic_check_status: string; original_filename: string; disposed: boolean }>(
        `SELECT storage_key, mime_type, basic_check_status, original_filename,
                EXISTS (SELECT 1 FROM document_disposals x WHERE x.document_id = dv.document_id) AS disposed
         FROM document_versions dv WHERE id = $1`, [id]);
      if (!r.rows[0]) throw notFound();
      if (r.rows[0].disposed) throw new ApiError(410, 'disposed', 'Belge saklama süresi sonunda imha edildi; baytlar artık yok. Üst veri ve hash kaydı korunur.');
      if (r.rows[0].basic_check_status !== 'PASSED') throw new ApiError(423, 'quarantined', 'Belge karantinada; görüntülenemez.');
      await tx.query(`INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, correlation_id)
        VALUES ($1,$2,'document.content.read','document_version',$3,$4)`, [ctx.tenantId, ctx.userId, id, ctx.correlationId]);
      return r.rows[0];
    });
    const bytes = await deps.store.get(meta.storage_key);
    return reply
      .header('Content-Type', meta.mime_type)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', 'inline')
      .send(bytes);
  });

  app.post('/api/v1/document-versions/:id/seller-identity', {
    schema: { tags: ['documents'], params: idParams, body: {
      type: 'object', required: ['taxIdType', 'taxId', 'name', 'country'], additionalProperties: false,
      properties: { taxIdType: { type: 'string', enum: ['VKN', 'TCKN', 'FOREIGN'] }, taxId: text(40), name: text(300),
        country: { type: 'string', pattern: '^[A-Z]{2}$' }, iban: { type: ['string', 'null'], maxLength: 40 }, page: { type: ['integer', 'null'], minimum: 1 } } } },
  }, async (req) => scoped(req, 'document.upload', (tx, ctx) =>
    submitSellerIdentity(tx, ctx, (req.params as { id: string }).id, req.body as any)));

  // --- Tedarikçiler (UX07/UX08) ----------------------------------------------------
  app.get('/api/v1/suppliers', {
    schema: { tags: ['suppliers'], querystring: { type: 'object', properties: { status: { type: 'string' }, q: { type: 'string', maxLength: 100 } } } },
  }, async (req) => scoped(req, 'supplier.read', async (tx) => {
    const { status, q } = req.query as { status?: string; q?: string };
    const r = await tx.query(
      `SELECT s.id, s.status, s.country, s.tax_id_type AS "taxIdType", s.tax_id AS "taxId", s.legal_name AS "legalName",
              s.identity_review_required AS "identityReviewRequired", s.created_at AS "createdAt", s.row_version AS "rowVersion",
              (SELECT count(*)::int FROM supplier_document_links l WHERE l.supplier_id = s.id) AS "documentCount",
              (SELECT count(*)::int FROM bank_change_requests b WHERE b.supplier_id = s.id AND b.status = 'PENDING_VERIFICATION') AS "pendingBankChanges"
       FROM suppliers s
       WHERE ($1::text IS NULL OR s.status = $1) AND s.status <> 'MERGED'
         AND ($2::text IS NULL OR s.legal_name ILIKE '%' || $2 || '%' OR s.tax_id = $2)
       ORDER BY s.created_at DESC LIMIT 200`, [status ?? null, q ?? null]);
    return { items: r.rows };
  }));

  app.get('/api/v1/suppliers/:id', { schema: { tags: ['suppliers'], params: idParams } }, async (req) =>
    scoped(req, 'supplier.read', async (tx, ctx) => {
      const { id } = req.params as { id: string };
      const s = await tx.query(
        `SELECT s.id, s.status, s.country, s.tax_id_type AS "taxIdType", s.tax_id AS "taxId", s.legal_name AS "legalName",
                s.identity_review_required AS "identityReviewRequired", s.created_by AS "createdBy", cu.display_name AS "createdByName",
                s.activated_at AS "activatedAt", s.row_version AS "rowVersion", s.rejection_reason AS "rejectionReason",
                s.merged_into_id AS "mergedIntoId", s.created_at AS "createdAt"
         FROM suppliers s LEFT JOIN users cu ON cu.id = s.created_by WHERE s.id = $1`, [id]);
      if (!s.rows[0]) throw notFound();
      const docs = await tx.query(
        `SELECT l.document_version_id AS "documentVersionId", d.title, d.kind, l.extracted_name AS "extractedName",
                l.name_mismatch AS "nameMismatch", l.created_at AS "linkedAt"
         FROM supplier_document_links l JOIN document_versions dv ON dv.id = l.document_version_id JOIN documents d ON d.id = dv.document_id
         WHERE l.supplier_id = $1 ORDER BY l.created_at`, [id]);
      const approvals = await tx.query(
        `SELECT a.approval_kind AS kind, a.decision, a.rationale, a.at, u.display_name AS "approverName", a.supplier_row_version AS "rowVersion"
         FROM supplier_approvals a JOIN users u ON u.id = a.approver_id WHERE a.supplier_id = $1 ORDER BY a.at`, [id]);
      const banks = await tx.query(`SELECT id, iban, currency, status FROM supplier_bank_accounts WHERE supplier_id = $1`, [id]);
      const bankChanges = await tx.query(
        `SELECT id, proposed_iban AS "proposedIban", source, status, created_at AS "createdAt" FROM bank_change_requests WHERE supplier_id = $1 ORDER BY created_at DESC`, [id]);
      return { ...s.rows[0], isCreator: s.rows[0].createdBy === ctx.userId, documents: docs.rows, approvals: approvals.rows,
        bankAccounts: banks.rows, bankChangeRequests: bankChanges.rows };
    }));

  app.post('/api/v1/suppliers/:id/approvals', {
    schema: { tags: ['suppliers'], params: idParams, body: { type: 'object', required: ['kind', 'decision', 'rationale', 'expectedRowVersion'], additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['MASTER_DATA', 'SECURITY', 'FINANCE'] }, decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
        rationale: text(), expectedRowVersion: { type: 'integer' } } } },
  }, async (req, reply) => {
    const body = req.body as any;
    await scoped(req, 'supplier.approve', async (tx, ctx) => {
      // Onay türü rolüyle eşleşmeli: güvenlik onayını yalnız güvenlik verir.
      // v2 (D93): ana veri ve finans onayı Satınalma, güvenlik onayı bölüm kullanıcısı rolüne düşer; kişi düzeyindeki ayrılık recordApproval'da.
      const roleFor = { MASTER_DATA: 'PROCUREMENT', SECURITY: 'DEPARTMENT_USER', FINANCE: 'PROCUREMENT' } as const;
      if (!ctx.roles.includes(roleFor[body.kind as keyof typeof roleFor])) throw forbidden(`supplier.approve.${body.kind}`);
      await recordApproval(tx, ctx, (req.params as { id: string }).id, body);
    });
    return reply.status(204).send();
  });

  app.post('/api/v1/suppliers/:id/activate', {
    schema: { tags: ['suppliers'], params: idParams, body: { type: 'object', required: ['expectedRowVersion'], properties: { expectedRowVersion: { type: 'integer' } } } },
  }, async (req, reply) => {
    await scoped(req, 'supplier.activate', (tx, ctx) => activateSupplier(tx, ctx, (req.params as { id: string }).id, (req.body as any).expectedRowVersion));
    return reply.status(204).send();
  });

  app.post('/api/v1/suppliers/:id/identity', {
    schema: { tags: ['suppliers'], params: idParams, body: { type: 'object', required: ['country', 'taxIdType', 'taxId', 'rationale', 'expectedRowVersion'], additionalProperties: false,
      properties: { country: { type: 'string', pattern: '^[A-Z]{2}$' }, taxIdType: { type: 'string', enum: ['VKN', 'TCKN', 'FOREIGN'] }, taxId: text(40),
        rationale: text(), expectedRowVersion: { type: 'integer' } } } },
  }, async (req) => scoped(req, 'supplier.identity.resolve', (tx, ctx) => resolveSupplierIdentity(tx, ctx, (req.params as { id: string }).id, req.body as any)));

  // --- Sözleşmeler ve imza kontrolü (UX09/UX14) -------------------------------------
  app.get('/api/v1/contracts', { schema: { tags: ['contracts'], querystring: { type: 'object', additionalProperties: false, properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } } } } }, async (req) => scoped(req, 'contract.read', async (tx, ctx) => {
    const { limit = 100, offset = 0 } = req.query as { limit?: number; offset?: number };
    // İmza durumu satır başına türetilir; sayfa boyutu bu maliyeti sınırlar (D89).
    const total = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM contract_versions cv WHERE cv.superseded_by_id IS NULL`)).rows[0]!.n;
    const r = await tx.query<{ id: string }>(
      `SELECT cv.id FROM contract_versions cv WHERE cv.superseded_by_id IS NULL ORDER BY cv.created_at DESC, cv.id LIMIT $1 OFFSET $2`, [limit, offset]);
    const items = [];
    const parties = (await tx.query<{ id: string; names: string[] }>(`SELECT contract_version_id AS id, array_agg(display_name ORDER BY display_name) AS names FROM contract_parties
      WHERE party_role = 'SUPPLIER' AND contract_version_id = ANY($1::uuid[]) GROUP BY contract_version_id`, [r.rows.map((x) => x.id)])).rows;
    const supplierNames = new Map(parties.map((x) => [x.id, x.names]));
    for (const row of r.rows) {
      const s = await contracts.getSignatureStatus(tx, ctx, row.id);
      items.push({
        ...s.contractVersion,
        supplierNames: supplierNames.get(row.id) ?? [],
        signature: { overall: s.status.overall, underlying: s.status.underlying, automaticCheck: s.status.automaticCheck,
          automaticAlert: s.status.automaticAlert, custody: s.status.custody,
          missingParties: s.status.blockers.filter((b) => b.code === 'SIGNATURE_MISSING').map((b) => b.partyName),
          blockerCount: s.status.blockers.length, hasActiveException: !!s.status.activeExceptionId },
        lastReviewedAt: s.reviews.at(-1)?.reviewedAt ?? null,
      });
    }
    return { items, total };
  }));

  app.get('/api/v1/contract-options', { schema: { tags: ['contracts'] } }, async (req) => scoped(req, 'contract.read', (tx) => invoices.contractOptions(tx)));
  app.post('/api/v1/contracts', {
    schema: { tags: ['contracts'], body: { type: 'object', required: ['title', 'documentVersionId', 'stage', 'signatureMethod', 'parties'], additionalProperties: false,
      properties: { title: text(300), documentVersionId: uuid, supplierId: { type: ['string', 'null'], format: 'uuid' }, stage, signatureMethod: sigMethod,
        originalCustodyRequired: { type: 'boolean', default: false }, effectiveDate: { type: ['string', 'null'], format: 'date' },
        parties: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['role', 'displayName'], additionalProperties: false,
          properties: { role: { type: 'string', enum: ['BUYER', 'SUPPLIER', 'OTHER'] }, displayName: text(300),
            legalEntityId: { type: ['string', 'null'], format: 'uuid' }, supplierId: { type: ['string', 'null'], format: 'uuid' } } } } } } },
  }, async (req, reply) => reply.status(201).send(await scoped(req, 'contract.manage', (tx, ctx) => contracts.createContract(tx, ctx, req.body as any))));

  app.get('/api/v1/contract-versions/:id/signature-status', { schema: { tags: ['signatures'], params: idParams } }, async (req, reply) => {
    const s = await scoped(req, 'contract.read', async (tx, ctx) => {
      const status = await contracts.reconcileExpiredExceptions(tx, ctx, (req.params as { id: string }).id);
      const parties = await tx.query(`SELECT id, party_role AS role, display_name AS "displayName" FROM contract_parties WHERE contract_version_id = $1`,
        [(req.params as { id: string }).id]);
      return { ...status, parties: parties.rows, can: {
        review: can(ctx.roles, 'signature.review'), defineRequirement: can(ctx.roles, 'signature.requirement.define'),
        analyze: can(ctx.roles, 'signature.analyze'), custody: can(ctx.roles, 'signature.custody.record'),
        requestException: can(ctx.roles, 'signature.exception.request'), decideException: can(ctx.roles, 'signature.exception.decide'),
        finalize: can(ctx.roles, 'signature.finalize'), manage: can(ctx.roles, 'contract.manage'),
      } };
    });
    return reply.header('ETag', s.contractVersion.etag).send(s);
  });

  app.patch('/api/v1/contract-versions/:id/signature-policy', {
    schema: { tags: ['signatures'], params: idParams, body: { type: 'object', required: ['signatureMethod', 'originalCustodyRequired'], additionalProperties: false,
      properties: { signatureMethod: sigMethod, originalCustodyRequired: { type: 'boolean' }, stage } } },
  }, async (req, reply) => {
    await scoped(req, 'signature.requirement.define', (tx, ctx) => contracts.updateSignaturePolicy(tx, ctx, (req.params as any).id, ifMatch(req), req.body as any));
    return reply.status(204).send();
  });

  app.post('/api/v1/contract-versions/:id/versions', {
    schema: { tags: ['contracts'], params: idParams, body: { type: 'object', required: ['documentVersionId', 'kind', 'stage'], additionalProperties: false,
      properties: { documentVersionId: uuid, kind: { type: 'string', enum: ['MAIN', 'AMENDMENT', 'ANNEX', 'SOW'] }, stage, addSupplierId: uuid } } },
  }, async (req, reply) => reply.status(201).send(await scoped(req, 'contract.manage', (tx, ctx) =>
    contracts.addContractVersion(tx, ctx, (req.params as any).id, ifMatch(req), req.body as any))));

  app.post('/api/v1/contract-versions/:id/signature-requirements', {
    schema: { tags: ['signatures'], params: idParams, body: { type: 'object', required: ['partyId', 'signerRole', 'acceptableMethods'], additionalProperties: false,
      properties: { partyId: uuid, signerRole: text(200), requirementCount: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
        acceptableMethods: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['WET_IMAGE_REVIEW', 'QUALIFIED_ELECTRONIC', 'ELECTRONIC_OTHER'] } },
        required: { type: 'boolean', default: true }, page: { type: ['integer', 'null'], minimum: 1 }, policyVersion: { type: 'string', default: contracts.POLICY_VERSION } } } },
  }, async (req, reply) => reply.status(201).send(await scoped(req, 'signature.requirement.define', (tx, ctx) =>
    contracts.defineRequirement(tx, ctx, (req.params as any).id, ifMatch(req), req.body as any))));

  app.post('/api/v1/contract-versions/:id/signature-analysis-jobs', { schema: { tags: ['signatures'], params: idParams } }, async (req, reply) => {
    const r = await scoped(req, 'signature.analyze', (tx, ctx) =>
      contracts.requestSignatureAnalysis(tx, ctx, (req.params as any).id, deps.config.signatureDetectorProvider));
    return reply.status(r.reused ? 200 : 202).send(r);
  });

  app.post('/api/v1/contract-versions/:id/signature-reviews', {
    schema: { tags: ['signatures'], params: idParams, body: { type: 'object', required: ['requirementId', 'decision', 'observedMark', 'rationale', 'documentSha256'], additionalProperties: false,
      properties: { requirementId: uuid, slot: { type: 'integer', minimum: 1, default: 1 },
        decision: { type: 'string', enum: ['IMAGE_CONFIRMED', 'MISSING', 'UNCLEAR'] },
        observedMark: { type: 'string', enum: ['FULL_SIGNATURE', 'STAMP_ONLY', 'INITIALS_ONLY', 'NAME_ONLY', 'NONE', 'ILLEGIBLE'] },
        rationale: { type: 'string', minLength: 3, maxLength: 2000 }, detectionId: { type: ['string', 'null'], format: 'uuid' },
        page: { type: ['integer', 'null'], minimum: 1 }, documentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } } } },
  }, async (req, reply) => reply.status(201).send(await scoped(req, 'signature.review', (tx, ctx) =>
    contracts.submitReview(tx, ctx, (req.params as any).id, ifMatch(req), req.body as any))));

  app.post('/api/v1/contract-versions/:id/original-custody-events', {
    schema: { tags: ['signatures'], params: idParams, body: { type: 'object', required: ['status', 'location', 'responsibleUserId', 'occurredAt'], additionalProperties: false,
      properties: { status: { type: 'string', enum: ['RECEIPT_DECLARED', 'CUSTODY_CONFIRMED'] }, location: text(300), responsibleUserId: uuid,
        occurredAt: { type: 'string', format: 'date-time' }, evidenceReference: { type: ['string', 'null'], maxLength: 500 } } } },
  }, async (req, reply) => {
    await scoped(req, 'signature.custody.record', (tx, ctx) => contracts.recordCustody(tx, ctx, (req.params as any).id, req.body as any));
    return reply.status(201).send({ ok: true });
  });

  app.post('/api/v1/contract-versions/:id/digital-validation-jobs', {
    schema: { tags: ['signatures'], params: idParams, body: { type: 'object', additionalProperties: false, properties: { requirementId: { type: ['string', 'null'], format: 'uuid' } } } },
  }, async (req, reply) => reply.status(202).send(await scoped(req, 'signature.analyze', (tx, ctx) =>
    contracts.requestDigitalValidation(tx, ctx, (req.params as any).id, (req.body as any)?.requirementId ?? null, deps.config.esignValidatorProvider))));

  app.post('/api/v1/contract-versions/:id/signature-exceptions', {
    schema: { tags: ['signatures'], params: idParams, body: { type: 'object', required: ['requirementIds', 'reason', 'residualRisk', 'scope', 'expiresAt'], additionalProperties: false,
      properties: { requirementIds: { type: 'array', minItems: 1, items: uuid }, reason: text(), residualRisk: text(), scope: text(500),
        expiresAt: { type: 'string', format: 'date-time' } } } },
  }, async (req, reply) => reply.status(201).send(await scoped(req, 'signature.exception.request', (tx, ctx) =>
    contracts.requestException(tx, ctx, (req.params as any).id, req.body as any))));

  app.post('/api/v1/signature-exceptions/:id/decision', {
    schema: { tags: ['signatures'], params: idParams, body: { type: 'object', required: ['decision', 'rationale'], additionalProperties: false,
      properties: { decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] }, rationale: text() } } },
  }, async (req, reply) => {
    await scoped(req, 'signature.exception.decide', (tx, ctx) => contracts.decideException(tx, ctx, (req.params as any).id, req.body as any));
    return reply.status(204).send();
  });

  app.post('/api/v1/contract-versions/:id/finalize-signature-review', { schema: { tags: ['signatures'], params: idParams } }, async (req) =>
    scoped(req, 'signature.finalize', (tx, ctx) => contracts.finalizeSignatureReview(tx, ctx, (req.params as any).id, ifMatch(req))));

  // --- Denetim izi --------------------------------------------------------------
  app.get('/api/v1/audit-events', {
    schema: { tags: ['audit'], querystring: { type: 'object', required: ['entityId'], properties: { entityId: uuid } } },
  }, async (req) => scoped(req, 'audit.read', async (tx) => {
    const r = await tx.query(
      `SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", a.data, a.reason, a.at, u.display_name AS "actorName"
       FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.entity_id = $1 ORDER BY a.id`, [(req.query as any).entityId]);
    return { items: r.rows };
  }));

  // --- Faz 4: sipariş, kabul, fatura, ERP (UX10, T13–T18, T37) ------------------------------
  const money2 = { type: 'string', pattern: '^\\d{1,18}(\\.\\d{1,6})?$' } as const;
  app.get('/api/v1/purchase-orders', { schema: { tags: ['po'] } }, async (req) => scoped(req, 'po.read', async (tx) => ({ items: await invoices.listPos(tx) })));
  app.get('/api/v1/purchase-orders/:id', { schema: { tags: ['po'], params: idParams } }, async (req) => scoped(req, 'po.read', async (tx, ctx) =>
    ({ ...(await invoices.getPo(tx, (req.params as any).id)), can: { receive: can(ctx.roles, 'receipt.record'), change: can(ctx.roles, 'po.manage') } })));
  app.post('/api/v1/purchase-orders', { schema: { tags: ['po'], body: { type: 'object', required: ['companyId', 'supplierId', 'currency', 'lines'], additionalProperties: false,
    properties: { companyId: uuid, supplierId: uuid, contractVersionId: { anyOf: [uuid, { type: 'null' }] }, projectId: { anyOf: [uuid, { type: 'null' }] }, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      lines: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', required: ['kind', 'description', 'unit', 'quantity', 'unitPrice'], additionalProperties: false,
        properties: { kind: { type: 'string', enum: ['GOODS', 'SERVICE'] }, description: { type: 'string', minLength: 2, maxLength: 300 }, unit: { type: 'string', minLength: 1, maxLength: 30 }, quantity: money2, unitPrice: money2, taxRate: { anyOf: [money2, { type: 'null' }] } } } } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'po.manage', (tx, ctx) => invoices.createPo(tx, ctx, req.body as any))));
  const poLine = { type: 'object', required: ['kind', 'description', 'unit', 'quantity', 'unitPrice'], additionalProperties: false,
    properties: { kind: { type: 'string', enum: ['GOODS', 'SERVICE'] }, description: { type: 'string', minLength: 2, maxLength: 300 }, unit: { type: 'string', minLength: 1, maxLength: 30 }, quantity: money2, unitPrice: money2, taxRate: { anyOf: [money2, { type: 'null' }] } } } as const;
  app.post('/api/v1/purchase-orders/:id/changes', { schema: { tags: ['po'], params: idParams, body: { type: 'object', required: ['baseChangeNo', 'reason', 'lines'], additionalProperties: false,
    properties: { baseChangeNo: { type: 'integer', minimum: 0 }, reason: { type: 'string', maxLength: 2000 },
      lines: { type: 'array', maxItems: 500, items: { type: 'object', required: ['poLineId', 'quantity', 'unitPrice'], additionalProperties: false, properties: { poLineId: uuid, quantity: money2, unitPrice: money2 } } },
      add: { type: 'array', maxItems: 100, items: poLine } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'po.manage', (tx, ctx) => invoices.changePo(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/purchase-orders/:id/close', { schema: { tags: ['po'], params: idParams, body: { type: 'object', required: ['baseChangeNo', 'reason'], additionalProperties: false,
    properties: { baseChangeNo: { type: 'integer', minimum: 0 }, reason: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'po.manage', (tx, ctx) => invoices.closePo(tx, ctx, (req.params as any).id, req.body as any)));
  app.post('/api/v1/po-lines/:id/receipts', { schema: { tags: ['po'], params: idParams, body: { type: 'object', required: ['quantity', 'note'],
    properties: { quantity: money2, periodFrom: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] }, periodTo: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] }, note: { type: 'string', maxLength: 1000 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'receipt.record', (tx, ctx) => invoices.recordReceipt(tx, ctx, (req.params as any).id, req.body as any, idemKey(req)))));
  app.post('/api/v1/receipts/:id/reverse', { schema: { tags: ['po'], params: idParams, body: { type: 'object', required: ['quantity', 'note'], properties: { quantity: money2, note: { type: 'string', maxLength: 1000 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'receipt.record', (tx, ctx) => invoices.reverseReceipt(tx, ctx, (req.params as any).id, req.body as any))));
  app.get('/api/v1/contract-versions/:id/limit', { schema: { tags: ['contracts'], params: idParams } }, async (req) =>
    scoped(req, null, async (tx, ctx) => {
      if (!can(ctx.roles, 'contract.read') && !can(ctx.roles, 'invoice.read')) throw forbidden('contract.read');
      return invoices.contractLimit(tx, (req.params as any).id);
    }));
  app.get('/api/v1/invoices', { schema: { tags: ['invoices'] } }, async (req) => scoped(req, 'invoice.read', async (tx) => ({ items: await invoices.listInvoices(tx) })));
  app.get('/api/v1/invoices/:id', { schema: { tags: ['invoices'], params: idParams } }, async (req) => scoped(req, 'invoice.read', async (tx, ctx) =>
    ({ ...(await invoices.getInvoice(tx, ctx, (req.params as any).id)), can: { manage: can(ctx.roles, 'invoice.manage'), approve: can(ctx.roles, 'invoice.approve'),
      approveException: can(ctx.roles, 'invoice.exception.approve') } })));
  app.post('/api/v1/invoices', { schema: { tags: ['invoices'], body: { type: 'object', required: ['companyId', 'supplierId', 'kind', 'invoiceNo', 'issueDate', 'currency', 'lines'], additionalProperties: false,
    properties: { companyId: uuid, supplierId: uuid, kind: { type: 'string', enum: ['INVOICE', 'CREDIT_NOTE', 'ADVANCE'] }, invoiceNo: { type: 'string', minLength: 1, maxLength: 40 },
      ettn: { anyOf: [uuid, { type: 'null' }] }, issueDate: { type: 'string', format: 'date' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' }, documentVersionId: { anyOf: [uuid, { type: 'null' }] },
      originalInvoiceId: { anyOf: [uuid, { type: 'null' }] }, lines: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', required: ['description', 'quantity', 'unit', 'unitPrice', 'netAmount'], additionalProperties: false,
        properties: { description: { type: 'string', minLength: 1, maxLength: 300 }, quantity: money2, unit: { type: 'string', minLength: 1, maxLength: 30 }, unitPrice: money2, netAmount: money2, taxRate: money2, taxAmount: { anyOf: [money2, { type: 'null' }] }, otherTax: { anyOf: [money2, { type: 'null' }] },
          // Dizi dalı önce: tür zorlaması (coerceTypes) null dalında diziyi null'a çevirmesin.
          otherTaxes: { anyOf: [{ type: 'array', maxItems: 10, items: { type: 'object', required: ['amount'], additionalProperties: false,
            properties: { code: { anyOf: [{ type: 'string', maxLength: 10 }, { type: 'null' }] }, name: { anyOf: [{ type: 'string', maxLength: 60 }, { type: 'null' }] },
              rate: { anyOf: [money2, { type: 'null' }] }, amount: money2 } } }, { type: 'null' }] } } } },
      declaredOtherTaxTotal: { anyOf: [money2, { type: 'null' }] },
      declaredTaxTotal: { anyOf: [money2, { type: 'null' }] }, declaredWithholding: { anyOf: [money2, { type: 'null' }] }, declaredPayable: { anyOf: [money2, { type: 'null' }] } } } } }, async (req, reply) => {
    const r = await scoped(req, 'invoice.manage', (tx, ctx) => invoices.createInvoice(tx, ctx, req.body as any));
    return reply.status(r.duplicate ? 200 : 201).send(r);
  });
  app.put('/api/v1/invoices/:id/allocations', { schema: { tags: ['invoices'], params: idParams, body: { type: 'object', required: ['allocations'], additionalProperties: false,
    properties: { advanceOffset: money2, advanceInvoiceId: { anyOf: [uuid, { type: 'null' }] }, allocations: { type: 'array', maxItems: 2000, items: { type: 'object', required: ['lineNo', 'poLineId', 'contractVersionId', 'quantity', 'amount'], additionalProperties: false,
      properties: { lineNo: { type: 'integer', minimum: 1 }, poLineId: { anyOf: [uuid, { type: 'null' }] }, contractVersionId: { anyOf: [uuid, { type: 'null' }] }, quantity: money2, amount: money2 } } } } } } }, async (req) =>
    scoped(req, 'invoice.manage', (tx, ctx) => invoices.setAllocations(tx, ctx, (req.params as any).id, req.body as any)));
  app.post('/api/v1/invoices/:id/exception-approval', { schema: { tags: ['invoices'], params: idParams, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'invoice.exception.approve', (tx, ctx) => invoices.approveException(tx, ctx, (req.params as any).id, (req.body as any).reason)));
  app.post('/api/v1/invoices/:id/approve', { schema: { tags: ['invoices'], params: idParams } }, async (req) => {
    // Nihai onay görülen sürüme bağlı: If-Match = kontrol parmak izi; yoksa 428 (eski ekrandan/çevrimdışı onay yok).
    const expected = ifMatch(req);
    if (!expected) throw new ApiError(428, 'precondition_required', 'Onay, incelenen fatura sürümüyle (If-Match) gönderilmeli.');
    return scoped(req, 'invoice.approve', (tx, ctx) => invoices.approveInvoice(tx, ctx, (req.params as any).id, deps.config.erpAdapter ?? null, expected.replace(/^"|"$/g, '')));
  });
  app.post('/api/v1/invoices/:id/reject', { schema: { tags: ['invoices'], params: idParams, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'invoice.approve', (tx, ctx) => invoices.rejectInvoice(tx, ctx, (req.params as any).id, (req.body as any).reason)));
  app.put('/api/v1/tolerance-rules', { schema: { tags: ['invoices'], body: { type: 'object', required: ['currency', 'absAmount', 'percent', 'combine'],
    properties: { currency: { type: 'string', pattern: '^[A-Z]{3}$' }, category: { type: 'string', maxLength: 200 }, absAmount: { anyOf: [money2, { type: 'null' }] }, percent: { anyOf: [money2, { type: 'null' }] }, combine: { type: 'string', enum: ['LOWER', 'HIGHER'] } } } } }, async (req) =>
    scoped(req, 'tolerance.manage', (tx, ctx) => invoices.setTolerance(tx, ctx, req.body as any)));
  app.get('/api/v1/tolerance-rules', { schema: { tags: ['invoices'] } }, async (req) => scoped(req, 'invoice.read', async (tx, ctx) =>
    ({ items: await invoices.listTolerance(tx), can: { manage: can(ctx.roles, 'tolerance.manage') } })));
  // category sorgu parametresi: boş/yok = para biriminin genel kuralı.
  app.delete('/api/v1/tolerance-rules/:currency', { schema: { tags: ['invoices'], params: { type: 'object', required: ['currency'], properties: { currency: { type: 'string', pattern: '^[A-Z]{3}$' } } },
    querystring: { type: 'object', properties: { category: { type: 'string', maxLength: 200 } } } } }, async (req) =>
    scoped(req, 'tolerance.manage', (tx, ctx) => invoices.deleteTolerance(tx, ctx, (req.params as any).currency, (req.query as any).category ?? '')));
  app.post('/api/v1/integration/erp/status-events', { schema: { tags: ['integration'], body: { type: 'object', required: ['events'], properties: { events: { type: 'array', minItems: 1, maxItems: 500,
    items: { type: 'object', required: ['eventId', 'invoiceId', 'status', 'at'], properties: { eventId: { type: 'string', minLength: 3, maxLength: 120 }, invoiceId: uuid, status: { type: 'string', enum: ['POSTED', 'PAID'] }, at: { type: 'string', format: 'date-time' } } } } } } } }, async (req) =>
    scoped(req, 'integration.ingest', (tx, ctx) => invoices.ingestErpEvents(tx, ctx, (req.body as any).events)));

  // --- Faz 3: sözleşme koşulları, ihbar, yükümlülük, yenileme (UX09, T21) -----------------
  const date = { type: 'string', format: 'date' } as const;
  const nDate = { anyOf: [date, { type: 'null' }] } as const;
  app.get('/api/v1/contract-versions/:id/lifecycle', { schema: { tags: ['contracts'], params: idParams } }, async (req) =>
    scoped(req, 'contract.read', async (tx, ctx) => ({ ...(await lifecycle.getLifecycle(tx, ctx, (req.params as any).id)),
      can: { edit: can(ctx.roles, 'contract.terms.edit'), verify: can(ctx.roles, 'contract.terms.verify'), manageObligations: can(ctx.roles, 'contract.obligation.manage'),
        record: can(ctx.roles, 'contract.obligation.record'), decide: can(ctx.roles, 'contract.renewal.decide') } })));
  // --- Faz 3: fiyat revizyonu, SLA kredisi, teminat (öneri → ikinci kişi onayı) ---
  const dec6 = { type: 'string', pattern: '^\\d{1,14}(\\.\\d{1,6})?$' } as const;
  const isoDate = { type: 'string', format: 'date' } as const;
  app.get('/api/v1/contract-versions/:id/commercial', { schema: { tags: ['contracts'], params: idParams } }, async (req) => scoped(req, 'contract.read', async (tx, ctx) => {
    if (can(ctx.roles, 'contract.guarantee.manage')) await commercial.guaranteeReminders(tx, ctx, (req.params as any).id);
    return { ...(await commercial.overview(tx, (req.params as any).id, ctx.userId)),
      can: { propose: can(ctx.roles, 'contract.commercial.propose'), approve: can(ctx.roles, 'contract.commercial.approve'), guarantee: can(ctx.roles, 'contract.guarantee.manage') } };
  }));
  app.post('/api/v1/contract-versions/:id/price-rules', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', additionalProperties: false,
    required: ['indexName', 'baseIndex', 'basePeriod', 'period', 'capPercent', 'floorPercent', 'sourceRef'],
    properties: { indexName: text(120), baseIndex: dec6, basePeriod: isoDate, period: { type: 'string', enum: ['MONTHLY', 'QUARTERLY', 'YEARLY'] },
      capPercent: { anyOf: [dec6, { type: 'null' }] }, floorPercent: { anyOf: [dec6, { type: 'null' }] }, sourceRef: text(300), replaceReason: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }] } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'contract.commercial.propose', (tx, ctx) => commercial.createPriceRule(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/price-rules/:id/revisions', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', additionalProperties: false, required: ['effectiveFrom', 'indexValue', 'indexSource'],
    properties: { effectiveFrom: isoDate, indexValue: dec6, indexSource: text(300) } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'contract.commercial.propose', (tx, ctx) => commercial.proposeRevision(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/price-revisions/:id/approve', { schema: { tags: ['contracts'], params: idParams } }, async (req) =>
    scoped(req, 'contract.commercial.approve', (tx, ctx) => commercial.approveRevision(tx, ctx, (req.params as any).id)));
  app.post('/api/v1/contract-versions/:id/sla-terms', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', additionalProperties: false,
    required: ['name', 'unit', 'direction', 'target', 'periodFee', 'currency', 'tiers', 'capPercent', 'sourceRef'],
    properties: { name: text(160), unit: text(30), direction: { type: 'string', enum: ['MIN', 'MAX'] }, target: dec6, periodFee: dec6, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      tiers: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['threshold', 'creditPercent'], properties: { threshold: dec6, creditPercent: dec6 } } },
      capPercent: { anyOf: [dec6, { type: 'null' }] }, sourceRef: text(300) } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'contract.commercial.propose', (tx, ctx) => commercial.createSlaTerm(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/sla-terms/:id/measurements', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', additionalProperties: false, required: ['periodStart', 'measured', 'evidence'],
    properties: { periodStart: isoDate, measured: { type: 'string', pattern: '^-?\\d{1,14}(\\.\\d{1,6})?$' }, evidence: text(2000), documentVersionId: { anyOf: [uuid, { type: 'null' }] } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'contract.commercial.propose', (tx, ctx) => commercial.recordMeasurement(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/sla-measurements/:id/decision', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', additionalProperties: false, required: ['decision'],
    properties: { decision: { type: 'string', enum: ['VERIFY', 'REJECT'] }, reason: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }] } } } } }, async (req) =>
    scoped(req, 'contract.commercial.approve', (tx, ctx) => commercial.decideMeasurement(tx, ctx, (req.params as any).id, req.body as any)));
  app.post('/api/v1/contract-versions/:id/guarantees', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', additionalProperties: false,
    required: ['kind', 'amount', 'currency', 'issuer', 'referenceNo', 'validUntil'],
    properties: { kind: { type: 'string', enum: ['PERFORMANCE', 'ADVANCE', 'WARRANTY', 'CASH', 'OTHER'] }, amount: dec6, currency: { type: 'string', pattern: '^[A-Z]{3}$' }, issuer: text(200),
      referenceNo: text(100), validUntil: { anyOf: [isoDate, { type: 'null' }] }, documentVersionId: { anyOf: [uuid, { type: 'null' }] } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'contract.guarantee.manage', (tx, ctx) => commercial.addGuarantee(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/guarantees/:id/return', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', additionalProperties: false, required: ['note'], properties: { note: text(2000) } } } }, async (req) =>
    scoped(req, 'contract.guarantee.manage', (tx, ctx) => commercial.returnGuarantee(tx, ctx, (req.params as any).id, (req.body as any).note)));
  app.post('/api/v1/contract-versions/:id/terms', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', additionalProperties: false,
    required: ['currency', 'valueType', 'amount', 'paymentTerms', 'startDate', 'endDate', 'autoRenewal', 'renewalMonths', 'noticeAmount', 'noticeUnit', 'nonWorkingDay', 'sourceRef'],
    properties: { currency: { type: 'string', pattern: '^[A-Z]{3}$' }, valueType: { type: 'string', enum: ['FIXED', 'CEILING', 'UNPRICED'] }, limitBasis: { type: 'string', enum: ['NET', 'GROSS'] },
      amount: { anyOf: [{ type: 'string', pattern: '^\\d{1,18}(\\.\\d{1,2})?$' }, { type: 'null' }] }, paymentTerms: { type: 'string', maxLength: 500 },
      startDate: nDate, endDate: nDate, autoRenewal: { type: 'boolean' }, renewalMonths: { type: ['integer', 'null'], minimum: 1, maximum: 120 },
      noticeAmount: { type: ['integer', 'null'], minimum: 0, maximum: 3650 }, noticeUnit: { anyOf: [{ type: 'string', enum: ['DAY', 'MONTH'] }, { type: 'null' }] },
      nonWorkingDay: { type: 'string', enum: ['PREVIOUS_WORKING_DAY', 'AS_IS'] }, sourceRef: { type: 'string', maxLength: 300 }, changeReason: { type: ['string', 'null'], maxLength: 2000 },
      paymentDays: { type: ['integer', 'null'], minimum: 0, maximum: 365 }, fxDifference: { type: ['string', 'null'], enum: ['ALLOWED', 'NOT_ALLOWED', null] } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'contract.terms.edit', (tx, ctx) => lifecycle.saveTerms(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/contract-terms/:id/verify', { schema: { tags: ['contracts'], params: idParams } }, async (req) =>
    scoped(req, 'contract.terms.verify', (tx, ctx) => lifecycle.verifyTerms(tx, ctx, (req.params as any).id)));
  app.post('/api/v1/contract-versions/:id/renewal-decision', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', required: ['decision', 'rationale'],
    properties: { decision: { type: 'string', enum: ['RENEW', 'TERMINATE', 'RENEGOTIATE'] }, rationale: { type: 'string', maxLength: 4000 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'contract.renewal.decide', (tx, ctx) => lifecycle.decideRenewal(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/contract-versions/:id/obligations', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', additionalProperties: false,
    required: ['title', 'counterparty', 'ownerRole', 'firstDue', 'recurrence', 'until', 'evidenceRequired', 'sourceRef'],
    properties: { title: { type: 'string', maxLength: 300 }, counterparty: { type: 'string', enum: ['BUYER', 'SUPPLIER'] }, ownerRole: { type: ['string', 'null'] },
      firstDue: date, recurrence: { type: 'string', enum: ['NONE', 'MONTHLY', 'QUARTERLY', 'YEARLY'] }, until: nDate, evidenceRequired: { type: 'boolean' },
      sourceRef: { type: 'string', minLength: 3, maxLength: 300 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'contract.obligation.manage', (tx, ctx) => lifecycle.addObligation(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/obligations/:id/events', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', required: ['dueDate', 'outcome', 'note'],
    properties: { dueDate: date, outcome: { type: 'string', enum: ['FULFILLED', 'MISSED', 'WAIVED'] }, note: { type: 'string', maxLength: 2000 }, evidence: { type: ['string', 'null'], maxLength: 500 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'contract.obligation.record', (tx, ctx) => lifecycle.recordObligation(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/obligations/:id/retire', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'contract.obligation.manage', (tx, ctx) => lifecycle.retireObligation(tx, ctx, (req.params as any).id, (req.body as any).reason)));
  app.get('/api/v1/holidays', { schema: { tags: ['contracts'] } }, async (req) => scoped(req, null, async (tx, ctx) => {
    internalOnly(ctx);
    return { items: (await tx.query(`SELECT day::text, name FROM tenant_holidays ORDER BY day`)).rows };
  }));
  app.post('/api/v1/holidays', { schema: { tags: ['contracts'], body: { type: 'object', required: ['day', 'name'], properties: { day: date, name: { type: 'string', minLength: 2, maxLength: 120 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'holiday.manage', async (tx, ctx) => {
      const b = req.body as { day: string; name: string };
      await tx.query(`INSERT INTO tenant_holidays (tenant_id, day, name, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, day) DO NOTHING`, [ctx.tenantId, b.day, b.name.trim(), ctx.userId]);
      await tx.query(`INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, data, correlation_id) VALUES ($1,$2,'holiday.added','tenant',$1,$3,$4)`,
        [ctx.tenantId, ctx.userId, b, ctx.correlationId]);
      return { ok: true };
    })));

  // --- Faz 2: proje, RFQ, tedarikçi portalı, karşılaştırma, tahsis ------------------------
  const dec = { type: 'string', pattern: '^-?\\d{1,18}(\\.\\d{1,6})?$' } as const;
  const lineSchema = { type: 'object', required: ['description', 'unit', 'quantity'], additionalProperties: false, properties: {
    lot: { type: 'string', maxLength: 40 }, description: { type: 'string', minLength: 2, maxLength: 500 }, unit: { type: 'string', minLength: 1, maxLength: 30 },
    quantity: dec, spec: { type: 'string', maxLength: 4000 } } } as const;
  const criterionSchema = { type: 'object', required: ['code', 'name', 'kind', 'weight'], additionalProperties: false, properties: {
    code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,30}$' }, name: { type: 'string', minLength: 2, maxLength: 120 }, kind: { type: 'string', enum: ['PRICE', 'SCORE'] }, weight: dec } } as const;
  const projectBody = { type: 'object', required: ['title', 'category', 'lines', 'criteria'], additionalProperties: false, properties: {
    companyId: uuid, title: { type: 'string', minLength: 3, maxLength: 200 }, category: { type: 'string', minLength: 2, maxLength: 120 },
    need: { type: 'string', maxLength: 4000 }, currency: { type: 'string', pattern: '^[A-Za-z]{3}$' }, budget: { anyOf: [dec, { type: 'null' }] },
    budgetVerified: { type: 'boolean' }, costCenter: { type: ['string', 'null'], maxLength: 60 }, deliveryLocation: { type: ['string', 'null'], maxLength: 200 },
    neededBy: { type: ['string', 'null'], format: 'date' }, lines: { type: 'array', minItems: 1, maxItems: 500, items: lineSchema },
    criteria: { type: 'array', minItems: 1, maxItems: 20, items: criterionSchema } } } as const;

  app.get('/api/v1/projects', { schema: { tags: ['projects'] } }, async (req) => scoped(req, 'project.read', async (tx) => ({ items: await sourcing.listProjects(tx) })));
  app.post('/api/v1/projects', { schema: { tags: ['projects'], body: { ...projectBody, required: [...projectBody.required, 'companyId'] } } }, async (req, reply) => {
    const r = await scoped(req, 'project.manage', (tx, ctx) => sourcing.createProject(tx, ctx, req.body as sourcing.ProjectInput));
    return reply.status(201).header('etag', r.etag).send(r);
  });
  app.get('/api/v1/projects/:id', { schema: { tags: ['projects'], params: idParams } }, async (req, reply) => {
    const r = await scoped(req, 'project.read', async (tx, ctx) => ({ ...(await sourcing.getProject(tx, ctx, (req.params as any).id)),
      savingsBaselines: await kpi.projectBaselines(tx, ctx, (req.params as any).id),
      can: { manage: can(ctx.roles, 'project.manage'), approveBaseline: can(ctx.roles, 'savings.approve'), requestException: can(ctx.roles, 'sourcing.exception.request'), approvePublish: can(ctx.roles, 'project.publish.approve'), score: can(ctx.roles, 'bid.score'),
        evaluate: can(ctx.roles, 'evaluation.create'), propose: can(ctx.roles, 'award.propose'), decide: can(ctx.roles, 'award.decide'), answer: can(ctx.roles, 'rfq.answer') } }));
    return reply.header('etag', r.project.etag).send(r);
  });
  app.put('/api/v1/projects/:id', { schema: { tags: ['projects'], params: idParams, body: projectBody } }, async (req) =>
    scoped(req, 'project.manage', (tx, ctx) => sourcing.updateDraft(tx, ctx, (req.params as any).id, ifMatch(req), req.body as any)));
  app.post('/api/v1/projects/:id/criteria-revisions', { schema: { tags: ['projects'], params: idParams, body: { type: 'object', required: ['criteria', 'reason'],
    properties: { criteria: { type: 'array', minItems: 1, items: criterionSchema }, reason: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'project.manage', (tx, ctx) => sourcing.reviseCriteria(tx, ctx, (req.params as any).id, ifMatch(req), (req.body as any).criteria, (req.body as any).reason)));
  app.post('/api/v1/projects/:id/rounds', { schema: { tags: ['rfq'], params: idParams, body: { type: 'object', required: ['closesAt', 'supplierIds'],
    properties: { closesAt: { type: 'string', format: 'date-time' }, supplierIds: { type: 'array', minItems: 1, maxItems: 50, items: uuid } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'project.manage', (tx, ctx) => sourcing.requestPublish(tx, ctx, (req.params as any).id, ifMatch(req), req.body as any))));
  app.post('/api/v1/rfq-rounds/:id/decision', { schema: { tags: ['rfq'], params: idParams, body: { type: 'object', required: ['approve'],
    properties: { approve: { type: 'boolean' }, note: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'approval.decide', (tx, ctx) => sourcing.decidePublish(tx, ctx, (req.params as any).id, req.body as any)));
  app.post('/api/v1/rfq-rounds/:id/close', { schema: { tags: ['rfq'], params: idParams, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'project.publish.approve', (tx, ctx) => sourcing.closeRoundEarly(tx, ctx, (req.params as any).id, (req.body as any).reason)));
  app.post('/api/v1/rfq-questions/:id/answer', { schema: { tags: ['rfq'], params: idParams, body: { type: 'object', required: ['answer'], properties: { answer: { type: 'string', maxLength: 4000 } } } } }, async (req) =>
    scoped(req, 'rfq.answer', (tx, ctx) => sourcing.answerQuestion(tx, ctx, (req.params as any).id, (req.body as any).answer)));
  app.get('/api/v1/projects/:id/comparison', { schema: { tags: ['evaluation'], params: idParams } }, async (req) =>
    scoped(req, 'project.read', (tx) => sourcing.getComparison(tx, (req.params as any).id)));
  app.post('/api/v1/projects/:id/fx-rates', { schema: { tags: ['evaluation'], params: idParams, body: { type: 'object', required: ['currency', 'rate', 'source', 'asOf'],
    properties: { currency: { type: 'string', pattern: '^[A-Za-z]{3}$' }, rate: dec, source: { type: 'string', minLength: 3, maxLength: 200 }, asOf: { type: 'string', format: 'date' } } } } }, async (req) =>
    scoped(req, 'evaluation.create', (tx, ctx) => sourcing.addFxRate(tx, ctx, (req.params as any).id, req.body as any)));
  app.post('/api/v1/bids/:id/scores', { schema: { tags: ['evaluation'], params: idParams, body: { type: 'object', required: ['criterionCode', 'score', 'evidence'],
    properties: { criterionCode: { type: 'string', maxLength: 32 }, score: dec, evidence: { type: 'string', maxLength: 4000 } } } } }, async (req) =>
    scoped(req, 'bid.score', (tx, ctx) => sourcing.scoreBid(tx, ctx, (req.params as any).id, req.body as any)));
  app.post('/api/v1/projects/:id/evaluations', { schema: { tags: ['evaluation'], params: idParams } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'evaluation.create', (tx, ctx) => sourcing.createEvaluation(tx, ctx, (req.params as any).id))));
  app.get('/api/v1/evaluations/:id', { schema: { tags: ['evaluation'], params: idParams } }, async (req) =>
    scoped(req, 'project.read', async (tx) => { const e = await sourcing.getEvaluation(tx, (req.params as any).id); return { ...e, project: { id: e.project.id, code: e.project.code, title: e.project.title } }; }));
  app.get('/api/v1/evaluations/:id/report.xlsx', { schema: { tags: ['evaluation'], params: idParams } }, async (req, reply) => {
    const e = await scoped(req, 'project.read', (tx) => sourcing.getEvaluation(tx, (req.params as any).id));
    const buf = await evaluationWorkbook(e);
    return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${e.project.code}-degerlendirme-v${e.versionNo}.xlsx"`).header('cache-control', 'no-store').send(buf);
  });
  app.get('/api/v1/evaluations/:id/decision.pdf', { schema: { tags: ['evaluation'], params: idParams } }, async (req, reply) => {
    const { e, awards } = await scoped(req, 'project.read', async (tx) => {
      const e = await sourcing.getEvaluation(tx, (req.params as any).id);
      return { e, awards: await sourcing.awardsForEvaluation(tx, e.id) };
    });
    const buf = await decisionSummaryPdf(e, awards);
    return reply.header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${e.project.code}-karar-ozeti-v${e.versionNo}.pdf"`).header('cache-control', 'no-store').send(buf);
  });
  app.post('/api/v1/projects/:id/awards', { schema: { tags: ['award'], params: idParams, body: { type: 'object', required: ['evaluationId', 'rationale', 'allocations'],
    properties: { evaluationId: uuid, rationale: { type: 'string', maxLength: 4000 }, allocations: { type: 'array', minItems: 1, maxItems: 1000,
      items: { type: 'object', required: ['projectLineId', 'supplierId', 'quantity'], additionalProperties: false, properties: { projectLineId: uuid, supplierId: uuid, quantity: dec } } } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'award.propose', (tx, ctx) => sourcing.proposeAward(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/awards/:id/decision', { schema: { tags: ['award'], params: idParams, body: { type: 'object', required: ['approve'],
    properties: { approve: { type: 'boolean' }, note: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'approval.decide', (tx, ctx) => sourcing.decideAward(tx, ctx, (req.params as any).id, req.body as any)));
  app.post('/api/v1/projects/:id/exceptions', { schema: { tags: ['sourcing'], params: idParams, body: { type: 'object', additionalProperties: false, required: ['kind', 'reason'],
    properties: { kind: { type: 'string', enum: ['SINGLE_SOURCE', 'URGENT', 'CANCEL', 'NO_AWARD'] }, reason: text(2000), supplierId: { anyOf: [uuid, { type: 'null' }] } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'sourcing.exception.request', (tx, ctx) => sourcing.requestException(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/sourcing-exceptions/:id/decision', { schema: { tags: ['sourcing'], params: idParams, body: { type: 'object', additionalProperties: false, required: ['approve'],
    properties: { approve: { type: 'boolean' }, note: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'approval.decide', (tx, ctx) => sourcing.decideException(tx, ctx, (req.params as any).id, req.body as any)));
  // --- Onay politikası (kurallı onay motoru) ---
  const amount2 = { type: 'string', pattern: '^\\d{1,18}(\\.\\d{1,2})?$' } as const;
  const ruleSchema = { type: 'object', additionalProperties: false, required: ['id', 'action', 'currency', 'minAmount', 'maxAmount', 'steps'],
    properties: { id: { type: 'string', minLength: 1, maxLength: 40 }, action: { type: 'string', enum: ['RFQ_PUBLISH', 'AWARD', 'SOURCING_EXCEPTION'] },
      companyId: { anyOf: [uuid, { type: 'null' }] }, category: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] }, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      minAmount: amount2, maxAmount: { anyOf: [amount2, { type: 'null' }] },
      steps: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['role', 'label'],
        properties: { role: { type: 'string', enum: ['PROCUREMENT', 'DEPARTMENT_USER', 'PROCUREMENT_MANAGER', 'FINANCE', 'LEGAL', 'SECURITY'] }, label: { type: 'string', minLength: 1, maxLength: 80 } } } },
      // Tip dizisi: ajv tür zorlaması null'ı yalnız hiçbir tür tutmazsa dönüştürür (anyOf'ta null 0'a çevriliyordu).
      minInvitees: { type: ['integer', 'null'] }, minResponseDays: { type: ['integer', 'null'] } } } as const;
  // Politikayı proje kullanıcıları okur (simülasyon); kiracı yöneticisi de yönetir (ikinci kişi olarak yayınlayabilsin).
  app.get('/api/v1/approval-policies', { schema: { tags: ['approvals'] } }, async (req) => scoped(req, null, async (tx, ctx) => {
    if (!can(ctx.roles, 'project.read') && !can(ctx.roles, 'approval.policy.manage')) throw forbidden('project.read');
    return { items: await approvals.listPolicies(tx, ctx), can: { manage: can(ctx.roles, 'approval.policy.manage') } };
  }));
  app.post('/api/v1/approval-policies', { schema: { tags: ['approvals'], body: { type: 'object', additionalProperties: false, required: ['rules', 'note'],
    properties: { rules: { type: 'array', maxItems: 200, items: ruleSchema }, note: text(2000) } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'approval.policy.manage', (tx, ctx) => approvals.createDraft(tx, ctx, req.body as any))));
  app.post('/api/v1/approval-policies/:id/activate', { schema: { tags: ['approvals'], params: idParams } }, async (req) =>
    scoped(req, 'approval.policy.manage', (tx, ctx) => approvals.activate(tx, ctx, (req.params as any).id)));
  app.post('/api/v1/approval-policies/simulate', { schema: { tags: ['approvals'], body: { type: 'object', additionalProperties: false, required: ['action', 'companyId', 'currency'],
    properties: { policyId: { anyOf: [uuid, { type: 'null' }] }, action: { type: 'string', enum: ['RFQ_PUBLISH', 'AWARD', 'SOURCING_EXCEPTION'] }, companyId: uuid,
      category: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] }, currency: { type: 'string', pattern: '^[A-Z]{3}$' }, amount: { anyOf: [amount2, { type: 'null' }] } } } } }, async (req) =>
    scoped(req, 'project.read', (tx) => approvals.simulate(tx, req.body as any)));
  // Davet listesi için tedarikçi arama (alıcı)
  // --- Faz 5: tedarikçi değerlendirmesi, olay, performans (02 §8–9, UX12, T19–T20) ---
  const lvl = { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] } as const;
  const lmh = { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] } as const;
  const dateStr = { type: 'string', format: 'date' } as const;
  const optDate = { anyOf: [dateStr, { type: 'null' }] } as const;
  const optText = (max: number) => ({ anyOf: [{ type: 'string', maxLength: max }, { type: 'null' }] }) as const;
  const qParams = { type: 'object', required: ['id', 'questionId'], properties: { id: uuid, questionId: uuid } } as const;
  app.get('/api/v1/questionnaire-templates', { schema: { tags: ['evaluation'] } }, async (req) => scoped(req, 'assessment.read', async (tx, ctx) =>
    ({ items: await evals.listTemplates(tx), can: { manage: can(ctx.roles, 'questionnaire.manage') } })));
  app.get('/api/v1/questionnaire-templates/:id', { schema: { tags: ['evaluation'], params: idParams } }, async (req) => scoped(req, 'assessment.read', (tx) => evals.getTemplate(tx, (req.params as any).id)));
  app.post('/api/v1/questionnaire-templates', { schema: { tags: ['evaluation'], body: { type: 'object', required: ['code', 'name', 'category', 'questions'], additionalProperties: false,
    properties: { code: { type: 'string', pattern: '^[A-Za-z0-9_-]{2,40}$' }, name: { type: 'string', minLength: 3, maxLength: 200 }, category: { type: 'string', minLength: 2, maxLength: 100 },
      questions: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['controlId', 'reference', 'text', 'critical', 'evidenceRequired'], additionalProperties: false,
        properties: { controlId: { type: 'string', minLength: 1, maxLength: 40 }, reference: { type: 'string', minLength: 2, maxLength: 300 }, text: { type: 'string', minLength: 5, maxLength: 2000 },
          critical: { type: 'boolean' }, evidenceRequired: { type: 'boolean' } } } } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'questionnaire.manage', (tx, ctx) => evals.createTemplate(tx, ctx, req.body as any))));
  app.post('/api/v1/questionnaire-templates/:id/publish', { schema: { tags: ['evaluation'], params: idParams } }, async (req) =>
    scoped(req, 'questionnaire.manage', (tx, ctx) => evals.publishTemplate(tx, ctx, (req.params as any).id)));
  app.get('/api/v1/suppliers/:id/assessments', { schema: { tags: ['evaluation'], params: idParams } }, async (req) => scoped(req, 'assessment.read', async (tx, ctx) =>
    ({ items: await evals.supplierAssessments(tx, ctx, (req.params as any).id), can: { manage: can(ctx.roles, 'assessment.manage') } })));
  app.post('/api/v1/assessments', { schema: { tags: ['evaluation'], body: { type: 'object', required: ['supplierId', 'templateId', 'scope', 'inherentFactors'], additionalProperties: false,
    properties: { supplierId: uuid, templateId: uuid, scope: { type: 'string', minLength: 3, maxLength: 300 }, reviewDue: optDate,
      inherentFactors: { type: 'object', required: ['dataSensitivity', 'accessLevel', 'criticality', 'substitutability', 'subcontractorDependence'], additionalProperties: false,
        properties: { dataSensitivity: lmh, accessLevel: lmh, criticality: lmh, substitutability: lmh, subcontractorDependence: lmh } } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'assessment.manage', (tx, ctx) => evals.createAssessment(tx, ctx, req.body as any))));
  app.get('/api/v1/assessments/:id', { schema: { tags: ['evaluation'], params: idParams } }, async (req) => scoped(req, 'assessment.read', async (tx, ctx) =>
    ({ ...(await evals.getAssessment(tx, ctx, (req.params as any).id)), can: { answer: can(ctx.roles, 'assessment.manage'), review: can(ctx.roles, 'assessment.review'), acceptRisk: can(ctx.roles, 'risk.accept') } })));
  app.put('/api/v1/assessments/:id/answers/:questionId', { schema: { tags: ['evaluation'], params: qParams, body: { type: 'object', required: ['response'], additionalProperties: false,
    properties: { response: { type: 'string', enum: ['YES', 'PARTIAL', 'NO', 'NOT_APPLICABLE', 'UNKNOWN'] }, naReason: optText(1000), note: optText(2000),
      evidenceDocumentVersionId: { anyOf: [uuid, { type: 'null' }] }, evidenceDate: optDate, evidenceExpires: optDate } } } }, async (req) =>
    scoped(req, 'assessment.manage', (tx, ctx) => evals.saveAnswer(tx, ctx, (req.params as any).id, (req.params as any).questionId, req.body as any)));
  // --- Faz 5: tedarikçi portalından anket yanıtlama ---
  app.post('/api/v1/assessments/:id/send-to-supplier', { schema: { tags: ['evaluation'], params: idParams, body: { type: 'object', additionalProperties: false, properties: { due: optDate } } } }, async (req) =>
    scoped(req, 'assessment.manage', (tx, ctx) => evals.sendToSupplier(tx, ctx, (req.params as any).id, (req.body as any)?.due ?? null)));
  app.get('/api/v1/portal/assessments', { schema: { tags: ['portal'] } }, async (req) => scoped(req, 'portal.assessment', async (tx, ctx) => ({ items: await evals.portalAssessments(tx, ctx) })));
  app.get('/api/v1/portal/assessments/:id', { schema: { tags: ['portal'], params: idParams } }, async (req) => scoped(req, 'portal.assessment', (tx, ctx) => evals.portalAssessment(tx, ctx, (req.params as any).id)));
  app.put('/api/v1/portal/assessments/:id/answers/:questionId', { schema: { tags: ['portal'], params: qParams, body: { type: 'object', required: ['response'], additionalProperties: false,
    properties: { response: { type: 'string', enum: ['YES', 'PARTIAL', 'NO', 'NOT_APPLICABLE', 'UNKNOWN'] }, naReason: optText(1000), note: optText(2000), evidenceDate: optDate, evidenceExpires: optDate } } } }, async (req) =>
    scoped(req, 'portal.assessment', (tx, ctx) => evals.portalAnswer(tx, ctx, (req.params as any).id, (req.params as any).questionId, req.body as any)));
  app.post('/api/v1/portal/assessments/:id/submit', { schema: { tags: ['portal'], params: idParams } }, async (req) =>
    scoped(req, 'portal.assessment', (tx, ctx) => evals.portalSubmit(tx, ctx, (req.params as any).id)));
  // --- Faz 5: kategori bazında performans ağırlığı ---
  const weightsSchema = { type: 'object', additionalProperties: false, required: ['quality', 'delivery', 'sla', 'communication', 'commercial'],
    properties: Object.fromEntries(['quality', 'delivery', 'sla', 'communication', 'commercial'].map((k) => [k, { type: 'integer', minimum: 0, maximum: 100 }])) } as const;
  app.get('/api/v1/performance-weights', { schema: { tags: ['evaluation'] } }, async (req) => scoped(req, 'assessment.read', async (tx, ctx) =>
    ({ items: await evals.listWeightPolicies(tx), can: { manage: can(ctx.roles, 'performance.weights.manage') } })));
  app.put('/api/v1/performance-weights', { schema: { tags: ['evaluation'], body: { type: 'object', additionalProperties: false, required: ['category', 'weights', 'reason'],
    properties: { category: text(200), weights: weightsSchema, reason: text(2000) } } } }, async (req) =>
    scoped(req, 'performance.weights.manage', (tx, ctx) => evals.setWeightPolicy(tx, ctx, req.body as any)));
  // --- Faz 5: tasarruf bazı ---
  app.post('/api/v1/projects/:id/savings-baselines', { schema: { tags: ['reports'], params: idParams, body: { type: 'object', additionalProperties: false, required: ['basis', 'amount', 'source'],
    properties: { basis: { type: 'string', enum: ['BUDGET', 'PREVIOUS_PRICE', 'MARKET'] }, amount: { type: 'string', maxLength: 22 }, source: text(1000) } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'project.manage', (tx, ctx) => kpi.proposeBaseline(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/savings-baselines/:id/decision', { schema: { tags: ['reports'], params: idParams, body: { type: 'object', additionalProperties: false, required: ['approve'],
    properties: { approve: { type: 'boolean' }, note: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'savings.approve', (tx, ctx) => kpi.decideBaseline(tx, ctx, (req.params as any).id, req.body as any)));
  app.post('/api/v1/assessments/:id/answers/:questionId/review', { schema: { tags: ['evaluation'], params: qParams, body: { type: 'object', required: ['review'], additionalProperties: false,
    properties: { review: { type: 'string', enum: ['ACCEPTED', 'FINDING'] }, findingSeverity: { anyOf: [lvl, { type: 'null' }] }, findingNote: optText(2000) } } } }, async (req) =>
    scoped(req, 'assessment.review', (tx, ctx) => evals.reviewAnswer(tx, ctx, (req.params as any).id, (req.params as any).questionId, req.body as any)));
  app.post('/api/v1/assessments/:id/complete', { schema: { tags: ['evaluation'], params: idParams } }, async (req) =>
    scoped(req, 'assessment.review', (tx, ctx) => evals.completeReview(tx, ctx, (req.params as any).id)));
  app.post('/api/v1/assessments/:id/residual', { schema: { tags: ['evaluation'], params: idParams, body: { type: 'object', required: ['level', 'reason'], additionalProperties: false,
    properties: { level: lvl, reason: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'risk.accept', (tx, ctx) => evals.acceptResidual(tx, ctx, (req.params as any).id, req.body as any)));
  app.get('/api/v1/incidents', { schema: { tags: ['evaluation'], querystring: { type: 'object', properties: { supplierId: uuid } } } }, async (req) => scoped(req, 'incident.read', async (tx, ctx) =>
    ({ items: await evals.listIncidents(tx, req.query as any), can: { report: can(ctx.roles, 'incident.report') } })));
  app.post('/api/v1/incidents', { schema: { tags: ['evaluation'], body: { type: 'object', required: ['supplierId', 'category', 'severity', 'title', 'description', 'occurredOn'], additionalProperties: false,
    properties: { supplierId: uuid, contractVersionId: { anyOf: [uuid, { type: 'null' }] }, poId: { anyOf: [uuid, { type: 'null' }] },
      category: { type: 'string', enum: ['QUALITY', 'DELAY', 'OUTAGE', 'SLA', 'INVOICE_DISPUTE', 'SECURITY', 'PERSONAL_DATA', 'ETHICS'] }, severity: lvl,
      title: { type: 'string', minLength: 5, maxLength: 200 }, description: { type: 'string', minLength: 10, maxLength: 5000 }, impact: optText(2000), location: optText(200), occurredOn: dateStr } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'incident.report', (tx, ctx) => evals.reportIncident(tx, ctx, req.body as any, idemKey(req)))));
  app.get('/api/v1/incidents/:id', { schema: { tags: ['evaluation'], params: idParams } }, async (req) => scoped(req, 'incident.read', async (tx, ctx) =>
    ({ ...(await evals.getIncident(tx, ctx, (req.params as any).id)), can: { verify: can(ctx.roles, 'incident.verify'), report: can(ctx.roles, 'incident.report'), roles: ctx.roles } })));
  app.post('/api/v1/incidents/:id/transitions', { schema: { tags: ['evaluation'], params: idParams, body: { type: 'object', required: ['action', 'note'], additionalProperties: false,
    properties: { action: { type: 'string', enum: ['START_REVIEW', 'VERIFY', 'REJECT', 'DISPUTE', 'RESOLVE_DISPUTE', 'MARK_DUPLICATE', 'CLOSE', 'REOPEN'] }, note: { type: 'string', maxLength: 5000 },
      severity: lvl, countedInMetric: { type: 'boolean' }, duplicateOfId: { anyOf: [uuid, { type: 'null' }] }, upheld: { type: 'boolean' }, evidenceDocumentVersionId: { anyOf: [uuid, { type: 'null' }] } } } } }, async (req) => {
    const b = req.body as any;
    // Tedarikçi itirazı dahil tüm geçişler doğrulama yetkisi ister (itiraz cezayı askıya aldığı için).
    return scoped(req, 'incident.verify', (tx, ctx) => evals.transitionIncident(tx, ctx, (req.params as any).id, b.action, b));
  });
  app.post('/api/v1/incidents/:id/actions', { schema: { tags: ['evaluation'], params: idParams, body: { type: 'object', required: ['title', 'ownerRole', 'dueDate'], additionalProperties: false,
    properties: { title: { type: 'string', minLength: 5, maxLength: 300 }, ownerRole: { type: 'string', enum: ['PROCUREMENT', 'DEPARTMENT_USER', 'REQUESTER', 'BUYER', 'PROCUREMENT_MANAGER', 'TECH_EVALUATOR', 'LEGAL', 'FINANCE', 'SECURITY', 'MASTER_DATA'] }, dueDate: dateStr } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'incident.verify', (tx, ctx) => evals.addCorrectiveAction(tx, ctx, (req.params as any).id, req.body as any))));
  app.post('/api/v1/corrective-actions/:id/complete', { schema: { tags: ['evaluation'], params: idParams, body: { type: 'object', required: ['note'], properties: { note: { type: 'string', maxLength: 5000 } } } } }, async (req) =>
    scoped(req, 'corrective.complete', (tx, ctx) => evals.completeAction(tx, ctx, (req.params as any).id, (req.body as any).note)));
  app.post('/api/v1/corrective-actions/:id/verify', { schema: { tags: ['evaluation'], params: idParams } }, async (req) =>
    scoped(req, 'incident.verify', (tx, ctx) => evals.verifyAction(tx, ctx, (req.params as any).id)));
  const score = { type: 'integer', minimum: 0, maximum: 100 } as const;
  const dims = { type: 'object', additionalProperties: false, properties: { quality: score, delivery: score, sla: score, communication: score, commercial: score } } as const;
  app.post('/api/v1/suppliers/:id/performance-reviews', { schema: { tags: ['evaluation'], params: idParams, body: { type: 'object', required: ['periodStart', 'periodEnd', 'category', 'scores', 'basis'], additionalProperties: false,
    properties: { periodStart: dateStr, periodEnd: dateStr, category: { type: 'string', minLength: 2, maxLength: 100 }, weights: dims, scores: dims, basis: { type: 'string', maxLength: 5000 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'performance.review', (tx, ctx) => evals.addPerformanceReview(tx, ctx, (req.params as any).id, req.body as any))));
  app.get('/api/v1/suppliers/:id/scorecard', { schema: { tags: ['evaluation'], params: idParams, querystring: { type: 'object', properties: { year: { type: 'integer', minimum: 2000, maximum: 2100 } } } } }, async (req) =>
    scoped(req, 'assessment.read', async (tx, ctx) => ({ ...(await evals.scorecard(tx, ctx, (req.params as any).id, (req.query as any).year ?? Number(new Date().getFullYear()))),
      can: { review: can(ctx.roles, 'performance.review'), reportIncident: can(ctx.roles, 'incident.report') } })));

  // --- Faz 5: AI yönetişimi (07, T22–T24) ---
  app.get('/api/v1/ai/overview', { schema: { tags: ['ai'] } }, async (req) => scoped(req, 'ai.read', async (tx, ctx) =>
    ({ ...(await ai.overview(tx)), can: { manage: can(ctx.roles, 'ai.policy.manage') } })));
  app.put('/api/v1/ai/policy', { schema: { tags: ['ai'], body: { type: 'object', required: ['allowedProviders', 'allowedRegions', 'monthlyBudget', 'budgetCurrency', 'dailyCallLimit', 'allowUpgrade'], additionalProperties: false,
    properties: { allowedProviders: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 60 } }, allowedRegions: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40 } },
      // null önce: tür dönüştürme boş değeri "" veya 0'a çevirmesin (boş = sınırsız).
      monthlyBudget: { anyOf: [{ type: 'null' }, { type: 'string' }] }, budgetCurrency: { type: 'string', pattern: '^[A-Z]{3}$' }, dailyCallLimit: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0 }] },
      allowUpgrade: { type: 'boolean' } } } } }, async (req) => scoped(req, 'ai.policy.manage', (tx, ctx) => ai.setPolicy(tx, ctx, req.body as any)));
  app.delete('/api/v1/ai/policy', { schema: { tags: ['ai'] } }, async (req) => scoped(req, 'ai.policy.manage', (tx, ctx) => ai.deletePolicy(tx, ctx)));
  app.post('/api/v1/ai/runs/:id/retry', { schema: { tags: ['ai'], params: idParams } }, async (req) => scoped(req, 'ai.read', (tx, ctx) => ai.retryRun(tx, ctx, (req.params as any).id)));
  app.get('/api/v1/document-versions/:id/ai-fields', { schema: { tags: ['ai'], params: idParams } }, async (req) => scoped(req, 'document.read', async (tx) => ({ items: await ai.documentAiFields(tx, (req.params as any).id) })));

  // --- Faz 5: raporlar (UX13). Dışa aktarma ekranla aynı yetki ve kapsamı uygular. ---
  const period = { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, fresh: { type: 'boolean' } } } as const;
  const reportCache = new kpi.ReportCache((deps.config.reportCacheSeconds ?? 0) * 1000);
  app.get('/api/v1/reports/summary', { schema: { tags: ['reports'], querystring: period } }, async (req) => scoped(req, 'report.read', (tx, ctx) => kpi.summary(tx, ctx, req.query as any, reportCache)));
  app.get('/api/v1/reports/summary.csv', { schema: { tags: ['reports'], querystring: period } }, async (req, reply) => {
    const csv = await scoped(req, 'report.read', (tx, ctx) => kpi.summaryCsv(tx, ctx, req.query as any, reportCache));
    const q = req.query as { from: string; to: string };
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="yonetim-gostergeleri-${q.from}-${q.to}.csv"`).send(csv);
  });

  // --- Faz 7 / T48: saklama, hukuki saklama, imha ve kiracı dışa aktarımı ---------------------------------
  // --- Lira Defteri (D80): kanıt zinciri ve geri kazanım vakaları ---
  const ledgerPeriod = { type: 'object', required: ['from', 'to'], properties: { from: date, to: date } } as const;
  app.get('/api/v1/ledger', { schema: { tags: ['recovery'], querystring: ledgerPeriod } }, async (req) => scoped(req, 'recovery.read', async (tx, ctx) => {
    const q = req.query as { from: string; to: string };
    if (q.from > q.to) throw unprocessable('invalid_period', 'Dönem başlangıcı bitişten sonra olamaz.');
    return { ...(await recovery.ledger(tx, q.from, q.to)),
      can: { scan: can(ctx.roles, 'recovery.manage'), manage: can(ctx.roles, 'recovery.manage'), settle: can(ctx.roles, 'recovery.settle'), settings: can(ctx.roles, 'recovery.settings') } };
  }));
  app.post('/api/v1/recovery/scan', { schema: { tags: ['recovery'] } }, async (req) => scoped(req, 'recovery.manage', (tx, ctx) => recovery.scan(tx, ctx)));
  app.get('/api/v1/recovery/cases', { schema: { tags: ['recovery'] } }, async (req) => scoped(req, 'recovery.read', async (tx) => ({ items: await recovery.listCases(tx) })));
  app.get('/api/v1/recovery/cases/:id', { schema: { tags: ['recovery'], params: idParams } }, async (req) => scoped(req, 'recovery.read', async (tx, ctx) =>
    ({ ...(await recovery.getCase(tx, ctx, (req.params as any).id)),
      can: { manage: can(ctx.roles, 'recovery.manage'), settle: can(ctx.roles, 'recovery.settle') } })));
  app.post('/api/v1/recovery/cases/:id/confirm', { schema: { tags: ['recovery'], params: idParams } }, async (req) =>
    scoped(req, 'recovery.manage', (tx, ctx) => recovery.confirmCase(tx, ctx, (req.params as any).id)));
  app.post('/api/v1/recovery/cases/:id/claim', { schema: { tags: ['recovery'], params: idParams, body: { type: 'object', additionalProperties: false, required: ['note'],
    properties: { note: { type: 'string', minLength: 5, maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'recovery.manage', (tx, ctx) => recovery.claimCase(tx, ctx, (req.params as any).id, (req.body as any).note)));
  app.post('/api/v1/recovery/cases/:id/recover', { schema: { tags: ['recovery'], params: idParams, body: { type: 'object', additionalProperties: false, required: ['amount', 'note'],
    properties: { amount: { type: 'string', pattern: '^\\d{1,18}(\\.\\d{1,2})?$' }, note: { type: 'string', minLength: 5, maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'recovery.settle', (tx, ctx) => recovery.recoverCase(tx, ctx, (req.params as any).id, req.body as any)));
  app.post('/api/v1/recovery/cases/:id/dismiss', { schema: { tags: ['recovery'], params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'],
    properties: { reason: { type: 'string', minLength: 10, maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'recovery.manage', (tx, ctx) => recovery.dismissCase(tx, ctx, (req.params as any).id, (req.body as any).reason)));
  app.get('/api/v1/fx-rates', { schema: { tags: ['recovery'] } }, async (req) => scoped(req, 'recovery.read', async (tx) => ({ items: await recovery.listFxRates(tx) })));
  app.post('/api/v1/fx-rates', { schema: { tags: ['recovery'], body: { type: 'object', additionalProperties: false, required: ['currency', 'rateDate', 'rate', 'source'],
    properties: { currency: { type: 'string', pattern: '^[A-Z]{3}$' }, rateDate: date, rate: { type: 'string', pattern: '^\\d{1,12}(\\.\\d{1,6})?$' }, source: { type: 'string', minLength: 2, maxLength: 200 } } } } },
  async (req, reply) => reply.status(201).send(await scoped(req, 'recovery.settings', async (tx, ctx) => {
    const b = req.body as { currency: string; rateDate: string; rate: string; source: string };
    if (b.currency === 'TRY') throw unprocessable('invalid_currency', 'TRY için kur girilmez; kur, döviz karşılığı TRY tutarıdır.');
    if (decimal(b.rate) <= 0n) throw unprocessable('invalid_rate', 'Kur sıfırdan büyük olmalı.');
    return recovery.addFxRate(tx, ctx, b);
  })));
  app.post('/api/v1/fx-rates/tcmb', { schema: { tags: ['recovery'], body: { type: 'object', additionalProperties: false, properties: { date } } } }, async (req) => {
    // Önce yetki; ağ çağrısı veritabanı işleminin dışında.
    await scoped(req, 'recovery.settings', async () => undefined);
    const bulletin = await tcmb.fetchTcmbBulletin((req.body as { date?: string } | undefined)?.date);
    return scoped(req, 'recovery.settings', (tx, ctx) => tcmb.importTcmbRates(tx, ctx, bulletin));
  });
  app.delete('/api/v1/fx-rates/:currency/:rateDate', { schema: { tags: ['recovery'], params: { type: 'object', required: ['currency', 'rateDate'],
    properties: { currency: { type: 'string', pattern: '^[A-Z]{3}$' }, rateDate: date } } } }, async (req) =>
    scoped(req, 'recovery.settings', (tx, ctx) => recovery.deleteFxRate(tx, ctx, (req.params as any).currency, (req.params as any).rateDate)));
  app.put('/api/v1/recovery/settings', { schema: { tags: ['recovery'], body: { type: 'object', additionalProperties: false, required: ['capitalCostRate'],
    properties: { capitalCostRate: { type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,4})?$' } } } } }, async (req) => scoped(req, 'recovery.settings', async (tx, ctx) => {
    const r = (req.body as { capitalCostRate: string }).capitalCostRate;
    if (decimal(r) <= 0n || decimal(r) > decimal('500')) throw unprocessable('invalid_rate', 'Yıllık sermaye maliyeti %0 ile %500 arasında olmalı.');
    return recovery.setCapitalCost(tx, ctx, r);
  }));

  const decision = { type: 'object', required: ['decision', 'note'], properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT'] }, note: text(2000) } } as const;
  const kindParams = { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['INVOICE', 'CONTRACT', 'QUOTE', 'OTHER'] } } } as const;
  app.get('/api/v1/retention', { schema: { tags: ['governance'] } }, async (req) => scoped(req, 'retention.read', async (tx, ctx) => ({
    ...(await gov.retentionOverview(tx)),
    can: { managePolicy: can(ctx.roles, 'retention.manage'), manageHold: can(ctx.roles, 'legal_hold.manage'), propose: can(ctx.roles, 'disposal.propose'), approve: can(ctx.roles, 'disposal.approve') },
    userId: ctx.userId,
  })));
  app.put('/api/v1/retention/policies/:kind', { schema: { tags: ['governance'], params: kindParams, body: { type: 'object', required: ['retentionMonths', 'legalBasis'],
    properties: { retentionMonths: { type: 'integer', minimum: 1, maximum: 1200 }, legalBasis: text(500) } } } }, async (req) =>
    scoped(req, 'retention.manage', (tx, ctx) => gov.setPolicy(tx, ctx, (req.params as any).kind, req.body as any)));
  app.delete('/api/v1/retention/policies/:kind', { schema: { tags: ['governance'], params: kindParams } }, async (req) =>
    scoped(req, 'retention.manage', (tx, ctx) => gov.deletePolicy(tx, ctx, (req.params as any).kind)));
  app.get('/api/v1/retention/candidates', { schema: { tags: ['governance'] } }, async (req) => scoped(req, 'retention.read', (tx) => gov.retentionCandidates(tx)));
  app.post('/api/v1/legal-holds', { schema: { tags: ['governance'], body: { type: 'object', required: ['scope', 'matterRef', 'reason'], properties: {
    scope: { type: 'string', enum: ['TENANT', 'COMPANY', 'DOCUMENT'] }, companyId: { anyOf: [{ type: 'null' }, uuid] }, documentId: { anyOf: [{ type: 'null' }, uuid] },
    matterRef: text(200), reason: { type: 'string', minLength: 10, maxLength: 2000 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'legal_hold.manage', (tx, ctx) => gov.createHold(tx, ctx, req.body as any))));
  app.post('/api/v1/legal-holds/:id/release', { schema: { tags: ['governance'], params: idParams, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 10, maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'legal_hold.manage', (tx, ctx) => gov.releaseHold(tx, ctx, (req.params as any).id, (req.body as any).reason)));
  app.post('/api/v1/disposal-batches', { schema: { tags: ['governance'], body: { type: 'object', required: ['documentIds', 'reason'], properties: {
    documentIds: { type: 'array', minItems: 1, maxItems: 500, items: uuid }, reason: { type: 'string', minLength: 10, maxLength: 2000 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'disposal.propose', (tx, ctx) => gov.proposeDisposal(tx, ctx, req.body as any))));
  app.get('/api/v1/disposal-batches/:id', { schema: { tags: ['governance'], params: idParams } }, async (req) =>
    scoped(req, 'retention.read', async (tx, ctx) => ({ ...(await gov.getBatch(tx, (req.params as any).id)), canDecide: can(ctx.roles, 'disposal.approve'), userId: ctx.userId })));
  app.post('/api/v1/disposal-batches/:id/decision', { schema: { tags: ['governance'], params: idParams, body: decision } }, async (req) =>
    scoped(req, 'disposal.approve', (tx, ctx) => gov.decideDisposal(tx, ctx, (req.params as any).id, req.body as any)));

  app.get('/api/v1/tenant-exports', { schema: { tags: ['governance'] } }, async (req) => scoped(req, null, async (tx, ctx) => {
    if (!can(ctx.roles, 'tenant.export.request') && !can(ctx.roles, 'tenant.export.approve') && !can(ctx.roles, 'audit.read')) throw forbidden('tenant.export.request');
    return { items: await gov.listExports(tx), can: { request: can(ctx.roles, 'tenant.export.request'), approve: can(ctx.roles, 'tenant.export.approve') }, userId: ctx.userId };
  }));
  app.post('/api/v1/tenant-exports', { schema: { tags: ['governance'], body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 10, maxLength: 2000 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'tenant.export.request', (tx, ctx) => gov.requestExport(tx, ctx, (req.body as any).reason))));
  app.post('/api/v1/tenant-exports/:id/decision', { schema: { tags: ['governance'], params: idParams, body: decision } }, async (req) =>
    scoped(req, 'tenant.export.approve', (tx, ctx) => gov.decideExport(tx, ctx, (req.params as any).id, req.body as any)));
  app.post('/api/v1/tenant-exports/:id/download', { schema: { tags: ['governance'], params: idParams } }, async (req) =>
    scoped(req, 'tenant.export.request', (tx, ctx) => gov.exportDownload(tx, ctx, deps.store, (req.params as any).id, deps.config.signedUrlTtlSeconds)));

  // --- Faz 7: ERP mutabakatı, yetkili tekrar gönderim, CSV aktarım ve sonuç dosyası ------------------------
  app.get('/api/v1/integration/erp/reconciliation', { schema: { tags: ['integration'], querystring: period } }, async (req) =>
    scoped(req, 'integration.reconcile', async (tx, ctx) => ({ ...(await integration.reconciliation(tx, req.query as any, deps.config.erpAdapter ?? null)), canReplay: can(ctx.roles, 'integration.replay') })));
  app.post('/api/v1/integration/erp/exports/:id/replay', { schema: { tags: ['integration'], params: idParams, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 10, maxLength: 1000 } } } } }, async (req) =>
    scoped(req, 'integration.replay', (tx, ctx) => integration.replay(tx, ctx, (req.params as any).id, (req.body as any).reason, deps.config.erpAdapter ?? null)));
  app.get('/api/v1/integration/erp/batch.csv', { schema: { tags: ['integration'], querystring: period } }, async (req, reply) => {
    const r = await scoped(req, 'integration.replay', (tx, ctx) => integration.batchCsv(tx, ctx, req.query as any));
    const q = req.query as { from: string; to: string };
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="erp-aktarim-${q.from}-${q.to}.csv"`)
      .header('x-row-count', String(r.rows)).header('cache-control', 'no-store').send(r.csv);
  });
  app.post('/api/v1/integration/erp/results', { bodyLimit: 5 * 1024 * 1024, schema: { tags: ['integration'], body: { type: 'object', required: ['csv', 'dryRun'], properties: {
    csv: { type: 'string', minLength: 1, maxLength: 5 * 1024 * 1024 }, dryRun: { type: 'boolean' } } } } }, async (req) =>
    scoped(req, 'integration.replay', (tx, ctx) => integration.applyResultCsv(tx, ctx, req.body as any)));

  app.get('/api/v1/supplier-options', { schema: { tags: ['projects'] } }, async (req) => scoped(req, 'supplier.read', async (tx) => {
    const rows = (await tx.query<{ id: string; legalName: string; status: string; taxIdType: string | null; taxId: string | null; identityReviewRequired: boolean }>(
      `SELECT id, legal_name AS "legalName", status, tax_id_type AS "taxIdType", tax_id AS "taxId", identity_review_required AS "identityReviewRequired", created_at AS "createdAt"
         FROM suppliers WHERE status IN ('ACTIVE','CONDITIONAL','CANDIDATE') ORDER BY legal_name, created_at LIMIT 500`)).rows;
    // Aynı adlı kayıtlar listede ayırt edilsin (D82); tam vergi kimliği dönmez, yalnız son 4 hane.
    const labels = supplierOptionLabels(rows);
    return { items: rows.map((r) => ({ id: r.id, legalName: r.legalName, status: r.status, label: labels.get(r.id)!,
      taxIdTail: taxIdTail(r.taxIdType, r.taxId), identityVerified: !r.identityReviewRequired && !!r.taxId })) };
  }));

  // Tedarikçi portalı (UX04): yalnız SUPPLIER rolü ve davet edildiği turlar.
  app.get('/api/v1/portal/rounds', { schema: { tags: ['portal'] } }, async (req) => scoped(req, 'bid.submit', async (tx, ctx) => ({ items: await sourcing.portalList(tx, ctx) })));
  app.get('/api/v1/portal/rounds/:id', { schema: { tags: ['portal'], params: idParams } }, async (req) => scoped(req, 'bid.submit', (tx, ctx) => sourcing.portalProject(tx, ctx, (req.params as any).id)));
  app.post('/api/v1/portal/rounds/:id/bids', { schema: { tags: ['portal'], params: idParams, body: { type: 'object', required: ['currency', 'lines'], additionalProperties: false, properties: {
    currency: { type: 'string', pattern: '^[A-Z]{3}$' }, validityDays: { type: ['integer', 'null'], minimum: 1, maximum: 365 }, note: { type: 'string', maxLength: 4000 },
    lines: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', required: ['projectLineId', 'unit', 'quantity', 'unitPrice', 'scope'], additionalProperties: false,
      properties: { projectLineId: uuid, unit: { type: 'string', minLength: 1, maxLength: 30 }, quantity: dec, unitPrice: dec, scope: { type: 'string', enum: ['INCLUDED', 'EXCLUDED', 'ALTERNATIVE'] }, note: { type: 'string', maxLength: 1000 } } } },
    costs: { type: 'array', maxItems: 20, items: { type: 'object', required: ['kind', 'amount'], additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['SHIPPING', 'INSTALLATION', 'MAINTENANCE', 'RENEWAL', 'OTHER'] }, amount: dec, note: { type: 'string', maxLength: 500 } } } },
    attachmentIds: { type: 'array', maxItems: 20, items: uuid } } } } }, async (req, reply) => {
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
    const r = await scoped(req, 'bid.submit', (tx, ctx) => sourcing.submitBid(tx, ctx, (req.params as any).id, key, req.body as any));
    return reply.status(r.replay ? 200 : 201).send(r);
  });
  app.post('/api/v1/portal/rounds/:id/files', { schema: { tags: ['portal'], params: idParams, consumes: ['multipart/form-data'] } }, async (req, reply) => {
    const file = await req.file();
    if (!file) throw new ApiError(400, 'file_required', 'Dosya gerekli.');
    const f = file.fields as Record<string, { value?: string } | undefined>;
    const body = await file.toBuffer();
    const r = await scoped(req, 'bid.submit', (tx, ctx) => sourcing.uploadBidFile(tx, ctx, deps.store, (req.params as any).id,
      { filename: file.filename, mimeType: file.mimetype, body, title: (f.title?.value || file.filename).slice(0, 200) }));
    return reply.status(r.duplicate ? 200 : 201).send(r);
  });
  app.get('/api/v1/bid-files/:id/content', { schema: { tags: ['portal'], params: idParams } }, async (req, reply) => {
    const meta = await scoped(req, null, async (tx, ctx) => {
      if (!ctx.supplierId && !can(ctx.roles, 'project.read')) throw forbidden('project.read');
      return sourcing.bidFileForDownload(tx, ctx, (req.params as any).id);
    });
    const bytes = await deps.store.get(meta.storage_key);
    return reply.header('Content-Type', meta.mime_type).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${meta.original_filename.replace(/[^\w.\-]/g, '_')}"`).send(bytes);
  });
  app.post('/api/v1/portal/rounds/:id/questions', { schema: { tags: ['portal'], params: idParams, body: { type: 'object', required: ['question'], properties: { question: { type: 'string', maxLength: 4000 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'bid.submit', (tx, ctx) => sourcing.askQuestion(tx, ctx, (req.params as any).id, (req.body as any).question))));

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
export type { FastifyReply };
