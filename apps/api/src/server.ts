import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import type pg from 'pg';
import { can, canInviteSupplier, dec as decimal, ERP_FEATURES, normalizeRoles, PERMISSIONS, supplierOptionLabels, supplierStage, taxIdTail, type Permission, type SupplierStatus } from '@sp/domain';
import type { Config } from './config.ts';
import { withTenant, type TenantContext, type Tx } from './db.ts';
import { DevAuthProvider, identityFor, resolveIdentity, tenantContext, type AuthProvider } from './auth.ts';
import { DEFAULT_SESSION, WebSessions } from './webSession.ts';
import { ApiError, forbidden, notFound, unprocessable } from './errors.ts';
import type { ObjectStore } from './storage.ts';
import { MAX_UPLOAD_BYTES } from './files.ts';
import { submitSellerIdentity, uploadDocument } from './modules/documents.ts';
import { activateSupplier, createCandidateSupplier, recordApproval, resolveIdentity as resolveSupplierIdentity } from './modules/suppliers.ts';
import * as tcmb from './modules/tcmb.ts';
import * as contracts from './modules/contracts.ts';
import * as sourcing from './modules/sourcing.ts';
import * as lifecycle from './modules/contractTerms.ts';
import * as invoices from './modules/invoices.ts';
import * as invoiceMatching from './modules/invoiceMatching.ts';
import * as evals from './modules/supplierEval.ts';
import * as ai from './modules/ai.ts';
import * as kpi from './modules/kpi.ts';
import * as gov from './modules/governance.ts';
import * as integration from './modules/integration.ts';
import * as erpEndpoints from './modules/integrationEndpoints.ts';
import * as commercial from './modules/commercial.ts';
import * as approvals from './modules/approvals.ts';
import * as search from './modules/search.ts';
import * as recovery from './modules/recovery.ts';
import * as departments from './modules/departments.ts';
import * as directory from './modules/directory.ts';
import * as approvers from './modules/approvers.ts';
import * as templates from './modules/templates.ts';
import * as riskQuestions from './modules/riskQuestions.ts';
import * as riskAssessments from './modules/riskAssessments.ts';
import * as portal from './modules/portal.ts';
import * as riskCycle from './modules/riskCycle.ts';
import * as riskImport from './modules/riskImport.ts';
import * as intake from './modules/contractIntake.ts';
import * as contractAi from './modules/contractAi.ts';
import * as reminders from './modules/contractReminders.ts';
import * as contractApprovals from './modules/contractApprovals.ts';
import { directoryProvider, type DirectoryProvider } from './directory/provider.ts';
import * as emailOutbox from './modules/emailOutbox.ts';
import { configureMailChannel } from './mail/index.ts';
import { taskRoleSql, visibleTaskSql } from './tasks.ts';
import { decisionSummaryPdf, evaluationWorkbook } from './reports.ts';
import { RateLimiter, rateLimited } from './rateLimit.ts';
import { DEFAULT_PUBLIC_RATE_LIMIT, PublicRateLimiter } from './publicRateLimit.ts';
import { avScanner } from './av/index.ts';
import * as applications from './modules/supplierApplications.ts';
import * as supplierCard from './modules/supplierCard.ts';
import * as offboarding from './modules/supplierOffboarding.ts';

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  auth: AuthProvider;
  store: ObjectStore;
  /** v2 Faz 2 (D105): dizin sağlayıcısı. Verilmezse yapılandırmadan bir kez kurulur; testler sahte sağlayıcı (ya da null) verir. */
  directoryProvider?: DirectoryProvider | null;
}

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
/** v2 (D93): oluşturmada departman (bölüm kullanıcısı için zorunluluk modülde) ve liste süzgeci. */
const optDepartment = { anyOf: [uuid, { type: 'null' }] } as const;
const departmentFilter = { type: 'object', properties: { departmentId: uuid } } as const;
const sigMethod = { type: 'string', enum: ['WET_IMAGE_REVIEW', 'QUALIFIED_ELECTRONIC', 'ELECTRONIC_OTHER', 'HYBRID', 'NOT_REQUIRED', 'PENDING_CLASSIFICATION'] } as const;
const stage = { type: 'string', enum: ['DRAFT', 'EXECUTION', 'ARCHIVE_IMPORT'] } as const;
const text = (max = 2000) => ({ type: 'string', minLength: 1, maxLength: max }) as const;
/** v2 Faz 3 (D108+): sözleşme listesine eklenen alanlar (eski alanlar aynen kalır). */
const v2Fields = (i: { code: string; status: string; statusLabel: string; project: unknown; supplier: unknown; endDate: string | null; indefinite: boolean; amount: string | null; currency: string | null } | undefined) =>
  ({ code: i?.code ?? null, status: i?.status ?? null, statusLabel: i?.statusLabel ?? null, project: i?.project ?? null, supplier: i?.supplier ?? null,
    endDate: i?.endDate ?? null, indefinite: i?.indefinite ?? false, amount: i?.amount ?? null, currency: i?.currency ?? null });

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
    exposedHeaders: ['ETag', 'X-Correlation-Id', 'Retry-After', 'X-SP-User'], allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'X-Tenant-Id', 'X-Correlation-Id', 'X-SP-CSRF', 'X-SP-Expect-User', 'X-Application-Token'],
  });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } });

  // v2 Faz 5 (R6): e-posta kanalı (varsayılan none → NOT_CONFIGURED). R5: üretimde virüs taraması kapalıysa açılışta uyarı (reddedilmez).
  const mail = configureMailChannel(deps.config.mail);
  if (deps.config.env === 'production' && (deps.config.av?.kind ?? 'none') === 'none') {
    app.log.warn('AV_SCANNER=none: virüs taraması yapılandırılmadı; yüklenen dosyalar "Virüs taraması yapılandırılmadı" olarak işaretlenir');
  }
  const dirProvider: DirectoryProvider | null = deps.directoryProvider !== undefined ? deps.directoryProvider : directoryProvider(deps.config.directory);
  const sessions = new WebSessions(deps.pool, deps.config.session ?? DEFAULT_SESSION, deps.config.webOrigin, deps.config.oidc, deps.auth, deps.config.extraWebOrigins);
  const limiter = deps.config.rateLimit?.enabled ? new RateLimiter(deps.config.rateLimit) : null;
  // v2 Faz 5 (R4a): girişsiz uç sınırlayıcısı her ortamda açık (RATE_LIMIT_ENABLED'dan bağımsız). R5: tarayıcı yoksa NOT_CONFIGURED.
  const publicLimiter = new PublicRateLimiter(deps.config.publicRateLimit ?? DEFAULT_PUBLIC_RATE_LIMIT);
  const scanner = avScanner(deps.config.av);
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
    if (err.code === 'FST_FILES_LIMIT' || err.code === 'FST_PARTS_LIMIT' || err.code === 'FST_FIELDS_LIMIT') return reply.status(413).send({ error: { code: 'too_many_parts', message: 'İstekte çok fazla dosya ya da alan var; tek dosya yükleyin.' } });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: { code: 'file_too_large', message: 'Dosya 25 MB sınırını aşıyor.' } });
    // PostgreSQL kısıtları: iş kuralı ihlali olarak döner, ayrıntı sızdırmaz.
    if (err.code === '23505') return reply.status(409).send({ error: { code: 'duplicate', message: 'Bu kayıt zaten mevcut.' } });
    if (err.code === '23514') return reply.status(422).send({ error: { code: 'rule_violation', message: 'İş kuralı ihlali.', details: { constraint: err.constraint } } });
    // v2 Faz 5 (052): girişsiz başvuru işlevlerinin hata durumları. İleti genel; var olan kayıt ya da kiracı bilgisi sızdırmaz.
    if (typeof err.code === 'string' && err.code.startsWith('SP4')) {
      const sp = publicFunctionError(err.code, String(err.message ?? ''));
      if (sp) {
        if (sp.status === 429) reply.header('Retry-After', '3600');
        return reply.status(sp.status).send({ error: { code: sp.code, message: sp.message } });
      }
    }
    // v2 Faz 7 (056a): fatura eşleşme koruması kendi koduyla döner (immutable_record değil).
    const matchErr = invoiceMatching.matchGuardError(err);
    if (matchErr) return reply.status(matchErr.status).send({ error: { code: matchErr.code, message: matchErr.message, details: matchErr.details } });
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
    const scope = active ? await withTenant(deps.pool, active, async (tx) => ({
      companies: (await tx.query(`SELECT id, name, country, default_currency FROM legal_entities WHERE id = ANY($1::uuid[]) ORDER BY name`, [active!.companyIds])).rows,
      departments: await departments.departmentsOf(tx, active!.departmentIds),
    })) : { companies: [], departments: [] };
    return {
      user: { id: identity.userId, email: identity.email, displayName: identity.displayName },
      memberships: identity.memberships.map((m) => ({ tenantId: m.tenantId, tenantName: m.tenantName, roles: m.roles })),
      activeTenantId: active?.tenantId ?? null,
      roles: active?.roles ?? [],
      // Final inceleme M8: arayüz izinleri rol eşlemesini kopyalamadan buradan okur (ör. proje sayfasında sözleşme sekmesi).
      permissions: active ? (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(active!.roles, p)) : [],
      supplierPortal: !!active?.supplierId,
      companies: scope.companies,
      // v2 (D93): aktif üyeliğin departmanları; allDepartments rolden türetilir (Yönetici, Satınalma, Denetçi).
      departments: scope.departments,
      allDepartments: active?.allDepartments ?? false,
    };
  });

  /** Tedarikçi portalı kullanıcısı iç ekranların yardımcı uçlarını (kullanıcı listesi, tatiller, görünümler) kullanamaz. */
  const internalOnly = (ctx: TenantContext) => { if (ctx.supplierId) throw forbidden('internal'); };
  app.get('/api/v1/members', async (req) => scoped(req, null, async (tx, ctx) => {
    internalOnly(ctx);
    // Düzeltme dalgası (Y4): Yönetici listesiyle aynı kapsam — tedarikçi portalı kullanıcıları listelenmez; roller v2 adlarıyla.
    // Final inceleme M5: kişi seçicileri (sözleşme sorumlusu, ek onaycı) `?active=true` ile yalnız etkin üyeleri alır; API askıdaki
    // kişiyi 422 ile reddeder. Parametresiz çağıranlar (salt okunur kullanıcı listesi) eskisi gibi tüm üyeleri görür.
    const activeOnly = (req.query as { active?: string } | undefined)?.active === 'true';
    const rows = (await tx.query<{ id: string; displayName: string; roles: string[] }>(`SELECT u.id, u.display_name AS "displayName", m.roles FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE m.supplier_id IS NULL ${activeOnly ? `AND m.status = 'ACTIVE'` : ''} ORDER BY u.display_name, u.id`)).rows;
    return rows.map((r) => ({ ...r, roles: normalizeRoles(r.roles) })).filter((r) => r.roles.length > 0 && !r.roles.includes('SUPPLIER'));
  }));

  // --- Departmanlar (v2 D93) ------------------------------------------------------
  app.get('/api/v1/departments', { schema: { tags: ['departments'] } }, async (req) =>
    scoped(req, 'department.read', async (tx, ctx) => ({ items: await departments.listDepartments(tx, { withAdminFields: can(ctx.roles, 'department.manage') }) })));
  // v2 Faz 2 (R6, D105): departman birleştirme (geri alınamaz, onay ister).
  app.post('/api/v1/departments/:id/merge', { schema: { tags: ['departments'], params: idParams,
    body: { type: 'object', required: ['intoId'], additionalProperties: false, properties: { intoId: uuid, confirm: { type: 'boolean' } } } } }, async (req) =>
    scoped(req, 'directory.manage', (tx, ctx) => departments.mergeDepartments(tx, ctx, (req.params as { id: string }).id, req.body as { intoId: string; confirm?: boolean })));
  app.post('/api/v1/departments', { schema: { tags: ['departments'], body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: text(200) } } } },
    async (req, reply) => reply.status(201).send(await scoped(req, 'department.manage', (tx, ctx) => departments.createDepartment(tx, ctx, req.body as { name: string }))));
  // Düzeltme dalgası (C1, D96): departmansız kayıtlar ve departman ataması (Yönetici, Satınalma).
  app.get('/api/v1/department-assignments/unassigned', { schema: { tags: ['departments'] } }, async (req) =>
    scoped(req, 'department.assign', (tx, ctx) => departments.listUnassigned(tx, ctx)));
  app.put('/api/v1/department-assignments', { schema: { tags: ['departments'], body: { type: 'object', required: ['entityType', 'ids', 'departmentId'], additionalProperties: false,
    properties: { entityType: { type: 'string', enum: ['project', 'contract_family', 'supplier_assessment'] }, ids: { type: 'array', minItems: 1, maxItems: 500, items: uuid }, departmentId: uuid } } } },
  async (req) => scoped(req, 'department.assign', (tx, ctx) => departments.assignDepartment(tx, ctx, req.body as { entityType: departments.AssignableEntity; ids: string[]; departmentId: string })));
  app.get('/api/v1/memberships', { schema: { tags: ['departments'] } }, async (req) =>
    scoped(req, 'department.manage', async (tx, ctx) => ({ items: await departments.listMemberships(tx, ctx) })));
  app.put('/api/v1/memberships/:userId/departments', { schema: { tags: ['departments'], params: { type: 'object', required: ['userId'], properties: { userId: uuid } },
    body: { type: 'object', required: ['departmentIds'], additionalProperties: false, properties: { departmentIds: { type: 'array', maxItems: 100, items: uuid } } } } }, async (req) =>
    scoped(req, 'department.manage', (tx, ctx) => departments.setMembershipDepartments(tx, ctx, (req.params as { userId: string }).userId, req.body as { departmentIds: string[] })));

  // --- Dizin (Entra) yönetimi (v2 Faz 2, D105) ----------------------------------------
  // Sır (ENTRA_CLIENT_SECRET) hiçbir yanıtta yok: sağlayıcıdan yalnız tür ve etiketler döner.
  app.get('/api/v1/directory/connection', { schema: { tags: ['directory'] } }, async (req) =>
    scoped(req, 'directory.read', (tx) => directory.getConnection(tx, dirProvider)));
  app.put('/api/v1/directory/connection', { schema: { tags: ['directory'], body: { type: 'object', required: ['scopeType', 'scopeValue', 'enabled'], additionalProperties: false,
    properties: { scopeType: { type: 'string', enum: ['GROUP', 'ADMIN_UNIT', 'OU_FILTER'] }, scopeValue: { type: 'string', maxLength: 500 }, enabled: { type: 'boolean' } } } } }, async (req) =>
    scoped(req, 'directory.manage', (tx, ctx) => directory.setConnection(tx, ctx, dirProvider, req.body as { scopeType: 'GROUP' | 'ADMIN_UNIT' | 'OU_FILTER'; scopeValue: string; enabled: boolean })));
  app.post('/api/v1/directory/connection/test', { schema: { tags: ['directory'] } }, async (req) => {
    await scoped(req, 'directory.manage', async () => null);
    if (!dirProvider) throw directory.notConfigured();
    // Ağ çağrısı veritabanı işlemi dışında yapılır.
    return directory.testConnection(dirProvider);
  });
  app.post('/api/v1/directory/sync', { schema: { tags: ['directory'] } }, async (req, reply) => {
    const r = await scoped(req, 'directory.manage', (tx, ctx) => {
      if (!dirProvider) throw directory.notConfigured();
      return directory.startManualSync(tx, ctx, dirProvider);
    });
    return reply.status(202).send(r);
  });
  app.get('/api/v1/directory/runs', { schema: { tags: ['directory'] } }, async (req) =>
    scoped(req, 'directory.read', async (tx) => ({ items: await directory.listRuns(tx) })));
  app.get('/api/v1/directory/users', { schema: { tags: ['directory'], querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 200 }, departmentId: uuid } } } },
    async (req) => scoped(req, 'directory.read', (tx) => directory.listDirectoryUsers(tx, req.query as { q?: string; departmentId?: string })));
  app.put('/api/v1/directory/users/:id/roles', { schema: { tags: ['directory'], params: idParams, body: { type: 'object', required: ['roles'], additionalProperties: false,
    properties: { roles: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } } } } } }, async (req) =>
    scoped(req, 'role.assign', (tx, ctx) => directory.setDirectoryUserRoles(tx, ctx, (req.params as { id: string }).id, req.body as { roles: string[] })));

  // --- Onaycı ataması (v2 Faz 2, D105, R2) ---------------------------------------------
  const nullableUuid = { anyOf: [uuid, { type: 'null' }] };
  app.get('/api/v1/approver-assignments', { schema: { tags: ['approvers'] } }, async (req) =>
    scoped(req, 'approver.read', (tx) => approvers.listApprovers(tx)));
  app.put('/api/v1/approver-assignments', { schema: { tags: ['approvers'], body: { type: 'object', additionalProperties: false, properties: {
    organization: { type: 'object', additionalProperties: false, properties: { leadUserId: nullableUuid, leadDeputyUserId: nullableUuid, directorUserId: nullableUuid, directorDeputyUserId: nullableUuid } },
    departments: { type: 'array', maxItems: 500, items: { type: 'object', required: ['departmentId'], additionalProperties: false,
      properties: { departmentId: uuid, headUserId: nullableUuid, deputyUserId: nullableUuid } } } } } } }, async (req) =>
    scoped(req, 'approver.manage', (tx, ctx) => approvers.setApprovers(tx, ctx, req.body as { organization?: approvers.OrgInput; departments?: approvers.DeptInput[] })));

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
    schema: { tags: ['tasks'], querystring: { type: 'object', properties: { view: { type: 'string', enum: ['mine', 'overdue', 'all'] },
      // Persona K2: sayfalama. Varsayılan ilk 200 (önceki davranış); sonraki sayfa `offset` ile, `nextOffset` null olunca liste biter.
      offset: { type: 'integer', minimum: 0, maximum: 1_000_000, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 200 } } } },
  }, async (req) => scoped(req, 'task.read', async (tx, ctx) => {
    const q = req.query as { view?: string; offset?: number; limit?: number };
    const view = q.view ?? 'mine';
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 200;
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
                WHEN 'contract_reminder' THEN (SELECT f.code FROM contract_families f WHERE f.id = t.entity_id)
                WHEN 'contract_rejection' THEN (SELECT f.code FROM contract_families f WHERE f.id = t.entity_id)
                WHEN 'contract_family' THEN (SELECT f.code FROM contract_families f WHERE f.id = t.entity_id)
                WHEN 'contract_approval_step' THEN (SELECT f.code FROM contract_approval_steps s JOIN contract_approval_chains c ON c.id = s.chain_id
                  JOIN contract_families f ON f.id = c.family_id WHERE s.id = t.entity_id)
              END AS "refNo"
       FROM tasks t WHERE t.status = 'OPEN' AND ${taskRoleSql('$1')} AND ${visibleTaskSql()}
         AND (t.entity_type <> 'contract_approval_step' OR t.assignee_user_id = $3)
         AND (t.entity_type NOT IN ('contract_reminder', 'contract_rejection') OR t.assignee_user_id IS NULL OR t.assignee_user_id = $3)
         AND ($2 <> 'overdue' OR (t.due_at IS NOT NULL AND t.due_at < now()))
         AND ($2 <> 'mine' OR t.assignee_user_id IS NULL OR t.assignee_user_id = $3)
       -- Kişiye atanmış açık onay adımı en üstte (yoğun onaycıda rol kuyruğunun altında kalmasın, persona K2); sonra önceki sıra.
       -- t.id son anahtar: sayfalar arasında kararlı sıra (aynı satır iki sayfada görünmez, hiçbiri atlanmaz).
       ORDER BY CASE WHEN t.entity_type = 'contract_approval_step' AND t.assignee_user_id = $3 THEN 0 ELSE 1 END,
                CASE t.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END, t.due_at NULLS LAST, t.created_at, t.id
       LIMIT $4 OFFSET $5`, [ctx.roles, view, ctx.userId, limit, offset]);
    // Sekme sayıları aynı yetki sınırıyla: yalnız kullanıcının rolüne atanmış işler.
    const c = (await tx.query<{ mine: number; overdue: number; all: number }>(
      `SELECT count(*) FILTER (WHERE assignee_user_id IS NULL OR assignee_user_id = $2)::int AS mine,
              count(*) FILTER (WHERE due_at IS NOT NULL AND due_at < now())::int AS overdue, count(*)::int AS "all"
       FROM tasks t WHERE t.status = 'OPEN' AND ${taskRoleSql('$1')} AND ${visibleTaskSql()}
         AND (t.entity_type <> 'contract_approval_step' OR t.assignee_user_id = $2)
         AND (t.entity_type NOT IN ('contract_reminder', 'contract_rejection') OR t.assignee_user_id IS NULL OR t.assignee_user_id = $2)`, [ctx.roles, ctx.userId])).rows[0]!;
    // Menü sayaçları (modül başına "Benden beklenen"): listeden değil sayımdan; 200 sınırı ve sayfalama sayacı kısaltmaz.
    const byType = (await tx.query<{ entityType: string; n: number }>(
      `SELECT t.entity_type AS "entityType", count(*)::int AS n FROM tasks t WHERE t.status = 'OPEN' AND ${taskRoleSql('$1')} AND ${visibleTaskSql()}
         AND (t.assignee_user_id IS NULL OR t.assignee_user_id = $2)
         AND (t.entity_type <> 'contract_approval_step' OR t.assignee_user_id = $2)
       GROUP BY t.entity_type`, [ctx.roles, ctx.userId])).rows;
    const total = c[view as keyof typeof c];
    const nextOffset = offset + r.rows.length < total && r.rows.length === limit ? offset + r.rows.length : null;
    return { items: r.rows, counts: c, total, offset, nextOffset, mineByType: Object.fromEntries(byType.map((x) => [x.entityType, x.n])) };
  }));

  // --- Sözleşme şablon kütüphanesi (v2 Faz 3, R8) ---------------------------------
  /** Çok parçalı gövde: alanlar dosyadan önce ya da sonra gelebilir. */
  const readTemplateForm = async (req: FastifyRequest) => {
    const fields: Record<string, string> = {};
    let file: templates.TemplateUpload | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (file) { part.file.resume(); throw new ApiError(413, 'too_many_files', 'Yalnız tek dosya yüklenebilir.'); }
        file = { filename: part.filename, body: await part.toBuffer() };
      }
      else if (typeof part.value === 'string') fields[part.fieldname] = part.value;
    }
    return { fields, file };
  };
  app.get('/api/v1/contract-templates', { schema: { tags: ['templates'] } }, async (req) =>
    scoped(req, 'template.read', (tx) => templates.listTemplates(tx)));
  app.post('/api/v1/contract-templates', { schema: { tags: ['templates'], consumes: ['multipart/form-data'] } }, async (req, reply) => {
    const { fields, file } = await readTemplateForm(req);
    const r = await scoped(req, 'template.manage', (tx, ctx) => templates.createTemplate(tx, ctx, deps.store, { ...fields, file }));
    return reply.status(201).send(r);
  });
  app.post('/api/v1/contract-templates/:id/versions', { schema: { tags: ['templates'], params: idParams, consumes: ['multipart/form-data'] } }, async (req, reply) => {
    const { fields, file } = await readTemplateForm(req);
    const r = await scoped(req, 'template.manage', (tx, ctx) => templates.addTemplateVersion(tx, ctx, deps.store, (req.params as { id: string }).id, { validFrom: fields.validFrom, file }));
    return reply.status(201).send(r);
  });
  app.get('/api/v1/contract-template-versions/:id/download', { schema: { tags: ['templates'], params: idParams } }, async (req, reply) => {
    const meta = await scoped(req, 'template.read', (tx, ctx) => templates.templateDownload(tx, ctx, (req.params as { id: string }).id));
    const bytes = await deps.store.get(meta.key);
    const ascii = meta.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return reply
      .header('Content-Type', meta.mimeType)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(meta.filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`)
      .send(bytes);
  });

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
    // v2 Faz 7 (R2): e-Fatura girişinde isteğe bağlı ERP referansları (≤60).
    const erpContractRef = f.erpContractRef?.value?.trim() || null;
    const erpOrderRef = f.erpOrderRef?.value?.trim() || null;
    if ((erpContractRef?.length ?? 0) > 60 || (erpOrderRef?.length ?? 0) > 60) throw new ApiError(400, 'validation_failed', 'ERP sözleşme ve sipariş referansı en fazla 60 karakter olabilir.');
    const body = await file.toBuffer();
    const result = await scoped(req, 'document.upload', (tx, ctx) => uploadDocument(tx, ctx, deps.store, {
      companyId, kind, documentId, title: (f.title?.value || file.filename).slice(0, 200), filename: file.filename, mimeType: file.mimetype, body,
      ...(erpContractRef ? { erpContractRef } : {}), ...(erpOrderRef ? { erpOrderRef } : {}),
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
    // v2 Faz 5 (R1): `stage` süzgeci ve sayımlar eklendi; eski `status` süzgeci ve satır alanları aynen.
    schema: { tags: ['suppliers'], querystring: { type: 'object', properties: { status: { type: 'string' }, q: { type: 'string', maxLength: 100 },
      stage: { type: 'string', enum: [...supplierCard.LIST_STAGES] } } } },
  }, async (req) => scoped(req, 'supplier.read', async (tx) => {
    const { status, q, stage } = req.query as { status?: string; q?: string; stage?: supplierCard.ListStage };
    const r = await tx.query<{ id: string }>(
      `SELECT s.id, s.status, s.country, s.tax_id_type AS "taxIdType", s.tax_id AS "taxId", s.legal_name AS "legalName",
              s.identity_review_required AS "identityReviewRequired", s.created_at AS "createdAt", s.row_version AS "rowVersion",
              (SELECT count(*)::int FROM supplier_document_links l WHERE l.supplier_id = s.id) AS "documentCount",
              (SELECT count(*)::int FROM bank_change_requests b WHERE b.supplier_id = s.id AND b.status = 'PENDING_VERIFICATION') AS "pendingBankChanges"
       FROM suppliers s
       WHERE ($1::text IS NULL OR s.status = $1) AND s.status <> 'MERGED'
         AND ($2::text IS NULL OR s.legal_name ILIKE '%' || $2 || '%' OR s.tax_id = $2)
         AND ($3::text[] IS NULL OR s.status = ANY($3::text[]))
       ORDER BY s.created_at DESC LIMIT 200`, [status ?? null, q ?? null, supplierCard.stageFilterStatuses(stage)]);
    const extras = await supplierCard.listExtras(tx, r.rows.map((x) => x.id));
    return { items: r.rows.map((x) => ({ ...x, ...extras.get(x.id)! })), ...(await supplierCard.listCounts(tx, q ?? null)) };
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
      // v2 Faz 5 (R1, R10–R14): eski alanlar aynen; `documents` (bağlı fatura/sözleşme belgeleri) korunur, tedarikçi belgeleri `supplierDocuments`.
      const v2 = await supplierCard.cardExtras(tx, ctx, id);
      const { documents: supplierDocuments, ...rest } = v2;
      return { ...s.rows[0], isCreator: s.rows[0].createdBy === ctx.userId, documents: docs.rows, approvals: approvals.rows,
        bankAccounts: banks.rows, bankChangeRequests: bankChanges.rows, ...rest, supplierDocuments };
    }));

  // --- v2 Faz 5 (D110) Görev 5: kart envanteri, belgeler, pasife alma, portal kullanıcıları ---------------------------
  const nullableText = (max: number) => ({ anyOf: [{ type: 'string', maxLength: max }, { type: 'null' }] }) as const;
  app.put('/api/v1/suppliers/:id/profile', { schema: { tags: ['suppliers'], params: idParams, body: { type: 'object', required: ['expectedRowVersion'], additionalProperties: false,
    properties: { expectedRowVersion: { type: 'integer' }, contactName: nullableText(200), contactEmail: nullableText(254), contactPhone: nullableText(40),
      address: nullableText(1000), serviceCategories: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 100 } }, servicesOffered: nullableText(4000),
      serviceScope: nullableText(4000), responsibleDepartmentId: { anyOf: [uuid, { type: 'null' }] }, supplierManagerUserId: { anyOf: [uuid, { type: 'null' }] },
      vpnAccess: { type: 'string', enum: ['YES', 'NO', 'UNKNOWN'] }, slaSummary: nullableText(2000), supportChannel: nullableText(500) } } } }, async (req) =>
    scoped(req, 'supplier.profile.edit', (tx, ctx) => supplierCard.updateProfile(tx, ctx, (req.params as { id: string }).id, req.body as supplierCard.ProfileInput)));

  app.post('/api/v1/suppliers/:id/documents', { schema: { tags: ['suppliers'], params: idParams, consumes: ['multipart/form-data'] } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    // İzin dosya okunmadan önce denetlenir (yetkisiz istekte gövde işlenmez).
    await scoped(req, 'supplier.documents.manage', async () => undefined);
    const fields: Record<string, string> = {};
    let file: { filename: string; mimetype: string; body: Buffer } | null = null;
    try {
      for await (const part of req.parts({ limits: { fileSize: supplierCard.SUPPLIER_DOC_MAX_BYTES, files: 1, fields: 10, fieldSize: 2000 } })) {
        if (part.type === 'file') file = { filename: part.filename, mimetype: part.mimetype, body: await part.toBuffer() };
        else fields[part.fieldname] = String(part.value ?? '');
      }
    } catch (err: any) {
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') throw unprocessable('file_too_large', 'Dosya 10 MB sınırını aşıyor.');
      throw err;
    }
    if (!file) throw unprocessable('file_required', 'Dosya seçin.');
    const upload = { ...file, fields };
    const prepared = await scoped(req, 'supplier.documents.manage', async (_tx, ctx) => supplierCard.prepareInternalUpload(upload, ctx.tenantId, scanner));
    await deps.store.put(prepared.storageKey, file.body, prepared.mimeType);
    try {
      return reply.status(201).send(await scoped(req, 'supplier.documents.manage', (tx, ctx) => supplierCard.addInternalDocument(tx, ctx, id, upload, prepared)));
    } catch (err) {
      await deps.store.delete(prepared.storageKey).catch(() => req.log.warn({ key: prepared.storageKey }, 'supplier document cleanup failed'));
      throw err;
    }
  });
  app.get('/api/v1/supplier-documents/:id/content', { schema: { tags: ['suppliers'], params: idParams } }, async (req, reply) => {
    const meta = await scoped(req, null, async (tx, ctx) => {
      // İç kullanıcı (`supplier.read`) ya da sahibi tedarikçi (RLS yalnız kendi kartının belgelerini açar; başvuru belgeleri ona kapalı).
      if (!ctx.supplierId && !can(ctx.roles, 'supplier.read')) throw forbidden('supplier.read');
      return supplierCard.documentForDownload(tx, ctx, (req.params as { id: string }).id);
    });
    const bytes = await deps.store.get(meta.storage_key);
    return reply.header('Content-Type', meta.mime_type).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${meta.original_filename.replace(/[^\w.\-]/g, '_')}"`).send(bytes);
  });

  const reasonBody = { type: 'object', required: ['reason', 'expectedRowVersion'], additionalProperties: false,
    properties: { reason: { type: 'string', maxLength: 2000 }, expectedRowVersion: { type: 'integer' } } } as const;
  app.post('/api/v1/suppliers/:id/deactivate', { schema: { tags: ['suppliers'], params: idParams, body: reasonBody } }, async (req) =>
    scoped(req, 'supplier.offboard', (tx, ctx) => offboarding.deactivateSupplier(tx, ctx, (req.params as { id: string }).id, req.body as { reason: string; expectedRowVersion: number })));
  app.post('/api/v1/suppliers/:id/reactivate', { schema: { tags: ['suppliers'], params: idParams, body: reasonBody } }, async (req) =>
    scoped(req, 'supplier.offboard', (tx, ctx) => offboarding.reactivateSupplier(tx, ctx, (req.params as { id: string }).id, req.body as { reason: string; expectedRowVersion: number })));
  app.put('/api/v1/supplier-offboarding-items/:id', { schema: { tags: ['suppliers'], params: idParams, body: { type: 'object', additionalProperties: false,
    properties: { done: { type: 'boolean', const: true }, notApplicable: { type: 'boolean', const: true }, note: nullableText(2000) } } } }, async (req) =>
    scoped(req, 'supplier.offboard', (tx, ctx) => offboarding.decideOffboardingItem(tx, ctx, (req.params as { id: string }).id, req.body as { done?: boolean; notApplicable?: boolean; note?: string })));

  app.post('/api/v1/suppliers/:id/portal-users', { schema: { tags: ['suppliers'], params: idParams, body: { type: 'object', required: ['name', 'email'], additionalProperties: false,
    properties: { name: { type: 'string', maxLength: 200 }, email: { type: 'string', maxLength: 254 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'supplier.portal_users.manage', (tx, ctx) =>
      supplierCard.addPortalUser(tx, ctx, (req.params as { id: string }).id, req.body as { name: string; email: string }, deps.config.webOrigin))));
  const portalUserParams = { type: 'object', required: ['id', 'userId'], properties: { id: uuid, userId: uuid } } as const;
  for (const action of ['suspend', 'reactivate'] as const) {
    app.post(`/api/v1/suppliers/:id/portal-users/:userId/${action}`, { schema: { tags: ['suppliers'], params: portalUserParams } }, async (req) =>
      scoped(req, 'supplier.portal_users.manage', (tx, ctx) => {
        const p = req.params as { id: string; userId: string };
        return supplierCard.setPortalUserStatus(tx, ctx, p.id, p.userId, action);
      }));
  }

  // --- v2 Faz 5 (D110) Görev 5: başvuru inceleme (okuma supplier.read, karar Satınalma) -------------------------------
  app.get('/api/v1/supplier-applications', { schema: { tags: ['suppliers'], querystring: { type: 'object', additionalProperties: false,
    properties: { status: { type: 'string', enum: ['UNVERIFIED', 'SUBMITTED', 'NEEDS_DOCUMENTS', 'APPROVED', 'REJECTED', 'EXPIRED'] } } } } }, async (req) =>
    scoped(req, 'supplier.read', async (tx, ctx) => ({ ...(await applications.listApplications(tx, req.query as { status?: any })),
      can: { decide: can(ctx.roles, 'supplier.application.review') } })));
  app.get('/api/v1/supplier-applications/:id', { schema: { tags: ['suppliers'], params: idParams } }, async (req) =>
    scoped(req, 'supplier.read', (tx, ctx) => applications.getApplication(tx, ctx, (req.params as { id: string }).id)));
  app.post('/api/v1/supplier-applications/:id/decision', { schema: { tags: ['suppliers'], params: idParams, body: { type: 'object', required: ['action', 'expectedRowVersion'],
    additionalProperties: false, properties: { action: { type: 'string', enum: ['APPROVE', 'REQUEST_DOCUMENTS', 'REJECT'] }, reason: nullableText(2000),
      documents: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } }, note: nullableText(2000), expectedRowVersion: { type: 'integer' } } } } }, async (req) =>
    scoped(req, 'supplier.application.review', (tx, ctx) =>
      applications.decideApplication(tx, ctx, (req.params as { id: string }).id, req.body as applications.DecisionInput, deps.config.webOrigin)));

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
    limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 }, departmentId: uuid, projectId: uuid,
    // v2 Faz 3 (D108+): türetilmiş durum süzgeci (Tümü/Onayda/Yürürlükte/90 gün içinde biten/Eksik alan); imza süzgeci istemcide kalır.
    status: { type: 'string', enum: ['ALL', 'IN_APPROVAL', 'ACTIVE', 'ENDING_90', 'INCOMPLETE'] } } } } }, async (req) => scoped(req, 'contract.read', async (tx, ctx) => {
    const { limit = 100, offset = 0, departmentId = null, status = 'ALL', projectId = null } = req.query as { limit?: number; offset?: number; departmentId?: string; status?: intake.StatusFilter; projectId?: string };
    // İmza durumu satır başına türetilir; sayfa boyutu bu maliyeti sınırlar (D89).
    // Görev 7 inceleme (I5): proje süzgeci de sunucuda (proje detayının Sözleşmeler sekmesi tek istekle).
    const deptSql = `($1::uuid IS NULL OR EXISTS (SELECT 1 FROM contract_families f WHERE f.id = cv.family_id AND f.department_id = $1))
      AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM contract_families f WHERE f.id = cv.family_id AND f.project_id = $2))`;
    let total: number;
    let r: { rows: { id: string; family_id: string }[] };
    let info: Awaited<ReturnType<typeof intake.listInfo>>;
    if (status === 'ALL') {
      total = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM contract_versions cv WHERE cv.superseded_by_id IS NULL AND ${deptSql}`, [departmentId, projectId])).rows[0]!.n;
      r = await tx.query<{ id: string; family_id: string }>(
        `SELECT cv.id, cv.family_id FROM contract_versions cv WHERE cv.superseded_by_id IS NULL AND ${deptSql} ORDER BY cv.created_at DESC, cv.id LIMIT $3 OFFSET $4`, [departmentId, projectId, limit, offset]);
      info = await intake.listInfo(tx, r.rows.map((x) => x.family_id));
    } else {
      // Durum saklanmaz: süzgeç türetilmiş durumla, sayfalamadan önce uygulanır.
      const all = (await tx.query<{ id: string; family_id: string }>(
        `SELECT cv.id, cv.family_id FROM contract_versions cv WHERE cv.superseded_by_id IS NULL AND ${deptSql} ORDER BY cv.created_at DESC, cv.id`, [departmentId, projectId])).rows;
      info = await intake.listInfo(tx, all.map((x) => x.family_id));
      const matched = all.filter((x) => { const i = info.get(x.family_id); return i ? intake.matchesFilter(status, i) : false; });
      total = matched.length;
      r = { rows: matched.slice(offset, offset + limit) };
    }
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
        ...v2Fields(info.get(row.family_id)),
      });
    }
    return { items, total };
  }));

  app.get('/api/v1/contract-options', { schema: { tags: ['contracts'] } }, async (req) => scoped(req, 'contract.read', (tx) => invoices.contractOptions(tx)));
  app.post('/api/v1/contracts', {
    schema: { tags: ['contracts'], body: { type: 'object', required: ['title', 'documentVersionId', 'stage', 'signatureMethod', 'parties'], additionalProperties: false,
      properties: { title: text(300), documentVersionId: uuid, supplierId: { type: ['string', 'null'], format: 'uuid' }, stage, signatureMethod: sigMethod, departmentId: optDepartment,
        originalCustodyRequired: { type: 'boolean', default: false }, effectiveDate: { type: ['string', 'null'], format: 'date' },
        parties: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['role', 'displayName'], additionalProperties: false,
          properties: { role: { type: 'string', enum: ['BUYER', 'SUPPLIER', 'OTHER'] }, displayName: text(300),
            legalEntityId: { type: ['string', 'null'], format: 'uuid' }, supplierId: { type: ['string', 'null'], format: 'uuid' } } } } } } },
  }, async (req, reply) => reply.status(201).send(await scoped(req, 'contract.manage', (tx, ctx) => contracts.createContract(tx, ctx, req.body as any))));

  // --- Sözleşme ekleme akışı (v2 Faz 3, Görev 4: R1–R5, R9, R10) --------------------------------------------------------
  const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
  const intakeDate = { type: 'string', format: 'date' } as const;
  // Persona K1: anyOf[{integer},{null}] ile ajv tür zorlaması null'ı 0'a çeviriyordu (boş ihbar 422, boş vade 0 kaydı).
  // Tür dizisi ['integer','null'] veride null tuttuğu için zorlama yapılmaz; yalnız alanlar ucunda kullanılır (diğer uçlar değişmez).
  const nullNum = (schema: { type: 'integer'; minimum: number; maximum: number }) => ({ ...schema, type: ['integer', 'null'] });
  app.post('/api/v1/contract-drafts', { schema: { tags: ['contracts'], body: { type: 'object', required: ['documentVersionId'], additionalProperties: false,
    properties: { documentVersionId: uuid, projectId: nullable(uuid), templateVersionId: nullable(uuid), departmentId: optDepartment } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'contract.manage', (tx, ctx) => intake.createDraft(tx, ctx, req.body as any, { aiModelId: contractAi.contractAiModelId(deps.config.ai) }))));
  app.put('/api/v1/contracts/:id/fields', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
    projectId: uuid, departmentId: uuid, supplierId: nullable(uuid), contractType: nullable({ type: 'string', enum: ['SERVICE', 'HARDWARE', 'MAINTENANCE', 'NDA', 'CONSULTING', 'OTHER'] }),
    ownerUserId: nullable(uuid), signedOn: nullable(intakeDate), indefinite: { type: 'boolean' }, templateVersionId: nullable(uuid),
    contractNo: nullable({ type: 'string', maxLength: 100 }), governingCourt: nullable({ type: 'string', maxLength: 200 }), kvkkClause: { type: ['boolean', 'null'] },
    priceEscalation: nullable({ type: 'string', maxLength: 1000 }),
    currency: { type: 'string', pattern: '^[A-Z]{3}$' }, valueType: { type: 'string', enum: ['FIXED', 'CEILING', 'UNPRICED'] },
    amount: nullable({ type: 'string', pattern: '^\\d{1,18}(\\.\\d{1,2})?$' }), limitBasis: { type: 'string', enum: ['NET', 'GROSS'] },
    startDate: nullable(intakeDate), endDate: nullable(intakeDate), autoRenewal: { type: 'boolean' }, renewalMonths: nullNum({ type: 'integer', minimum: 1, maximum: 120 }),
    noticeAmount: nullNum({ type: 'integer', minimum: 0, maximum: 3650 }), noticeUnit: nullable({ type: 'string', enum: ['DAY', 'MONTH'] }),
    paymentDays: nullNum({ type: 'integer', minimum: 0, maximum: 365 }), paymentTerms: { type: 'string', maxLength: 2000 }, sourceRef: { type: 'string', minLength: 3, maxLength: 300 },
    fxDifference: nullable({ type: 'string', enum: ['ALLOWED', 'NOT_ALLOWED'] }), nonWorkingDay: { type: 'string', enum: ['PREVIOUS_WORKING_DAY', 'AS_IS'] },
    // v2 Faz 4 (R6): yapay zekâ önerilerine kararlar (aynı işlemde).
    aiDecisions: { type: 'array', maxItems: 40, items: { type: 'object', required: ['extractionId', 'decision'], additionalProperties: false,
      properties: { extractionId: uuid, decision: { type: 'string', enum: ['CONFIRMED', 'CORRECTED', 'REJECTED'] } } } },
  } } } }, async (req) => scoped(req, 'contract.manage', (tx, ctx) => intake.updateFields(tx, ctx, (req.params as { id: string }).id, req.body as intake.FieldsInput)));
  app.get('/api/v1/contracts/:id/v2', { schema: { tags: ['contracts'], params: idParams } }, async (req) =>
    scoped(req, 'contract.read', (tx, ctx) => intake.getContractV2(tx, ctx, (req.params as { id: string }).id)));
  // --- Sözleşme alan okuması (v2 Faz 4, Görev 4: R3–R6, R11) ---------------------------------------------------------------
  app.get('/api/v1/contracts/:id/extractions', { schema: { tags: ['contracts'], params: idParams } }, async (req) =>
    scoped(req, 'contract.read', (tx, ctx) => contractAi.getExtractions(tx, ctx, (req.params as { id: string }).id)));
  // "Yeniden oku": bekleyen işi yeniden yönlendirir, başarısız işe yeni deneme açar; çalışmış/kuyruktaki iş yeni ücret yaratmaz.
  app.post('/api/v1/contracts/:id/extractions', { schema: { tags: ['contracts'], params: idParams } }, async (req) =>
    scoped(req, 'contract.ai.request', (tx, ctx) => contractAi.requestContractExtraction(tx, ctx, (req.params as { id: string }).id,
      { force: true, modelId: contractAi.contractAiModelId(deps.config.ai) })));
  // --- Sözleşme incelemesi (v2 Faz 4, Görev 5: R7–R10). Yapay zekâ ön incelemesidir, hukuki görüş değildir; puan onay vermez, engellemez. ---
  app.get('/api/v1/contracts/:id/reviews', { schema: { tags: ['contracts'], params: idParams } }, async (req) =>
    scoped(req, 'contract.review.read', (tx, ctx) => contractAi.getContractReviews(tx, ctx, (req.params as { id: string }).id)));
  // "İncele" / "Yeniden incele": çalışmış iş yeni ücret yaratmaz; başarısız iş yeni deneme açar.
  app.post('/api/v1/contracts/:id/reviews', { schema: { tags: ['contracts'], params: idParams } }, async (req) =>
    scoped(req, 'contract.ai.request', (tx, ctx) => contractAi.requestContractReview(tx, ctx, (req.params as { id: string }).id,
      { force: true, modelId: contractAi.contractAiModelId(deps.config.ai) })));
  // --- Sözleşme hatırlatıcıları (v2 Faz 3, Görev 6: R7) -------------------------------------------------------------------
  app.get('/api/v1/contracts/:id/reminders', { schema: { tags: ['contracts'], params: idParams } }, async (req) =>
    scoped(req, 'contract.read', (tx, ctx) => reminders.getReminders(tx, ctx, (req.params as { id: string }).id)));
  // Görev 7 inceleme (I4): ailenin sürümlerine (doğrudan ya da sözleşmeye bağlı sipariş üzerinden) tahsis edilmiş faturalar; limit ucuyla aynı veri.
  // v2 Faz 7 (Ruling 3): Faz 3 ucu genişletildi — tahsisli kalemler aynen + bağlı faturalar, eşleşme durumu ve kullanım (R4).
  app.get('/api/v1/contracts/:id/invoices', { schema: { tags: ['contracts'], params: idParams } }, async (req) =>
    scoped(req, 'contract.read', (tx) => invoiceMatching.contractInvoices(tx, (req.params as { id: string }).id)));
  // v2 Faz 5 (R7): Yönetim > E-posta kutusu (yalnız Yönetici, yalnız okuma). Üretimde belirteçli bağlantı maskelenir.
  app.get('/api/v1/admin/email-outbox', { schema: { tags: ['admin'], querystring: { type: 'object', additionalProperties: false, properties: {
    status: { type: 'string', enum: ['QUEUED', 'NOT_CONFIGURED', 'SENT', 'FAILED'] }, relatedType: { type: 'string', minLength: 1, maxLength: 100 },
    limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0, maximum: 1_000_000 } } } } }, async (req) =>
    scoped(req, 'email.outbox.read', (tx) => emailOutbox.listOutbox(tx, req.query as emailOutbox.OutboxQuery,
      { channel: mail, maskTokens: deps.config.env === 'production' })));
  // --- v2 Faz 6 Görev 3: risk soru setleri ve ayar ---------------------------------------------------------------------
  app.get('/api/v1/risk/question-sets', { schema: { tags: ['risk'] } }, async (req) =>
    scoped(req, 'risk.read', async (tx, ctx) => ({ ...(await riskQuestions.listSets(tx)), can: { manage: can(ctx.roles, 'risk.questions.manage') } })));
  app.get('/api/v1/risk/question-sets/:id', { schema: { tags: ['risk'], params: idParams } }, async (req) =>
    scoped(req, 'risk.read', (tx) => riskQuestions.getSet(tx, (req.params as { id: string }).id)));
  app.post('/api/v1/risk/question-sets', { schema: { tags: ['risk'], body: { type: 'object', required: ['code', 'name', 'questions'], additionalProperties: false, properties: {
    code: { type: 'string', maxLength: 100 }, name: { type: 'string', maxLength: 500 }, scopeNote: nullable({ type: 'string', maxLength: 5000 }),
    questions: { type: 'array', maxItems: 200, items: { type: 'object', required: ['code', 'text', 'weight'], additionalProperties: false, properties: {
      code: { type: 'string', maxLength: 100 }, text: { type: 'string', maxLength: 5000 }, weight: { type: ['string', 'number'] },
      riskAnswer: { type: 'string', enum: ['YES', 'NO'] }, guidance: nullable({ type: 'string', maxLength: 5000 }) } } } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'risk.questions.manage', (tx, ctx) => riskQuestions.createSet(tx, ctx, req.body as riskQuestions.QuestionSetInput))));
  app.post('/api/v1/risk/question-sets/:id/publish', { schema: { tags: ['risk'], params: idParams } }, async (req) =>
    scoped(req, 'risk.questions.manage', (tx, ctx) => riskQuestions.publishSet(tx, ctx, (req.params as { id: string }).id)));
  app.get('/api/v1/settings/risk', { schema: { tags: ['settings'] } }, async (req) => scoped(req, 'risk.cycle.manage', (tx) => riskQuestions.getRiskSettings(tx)));
  app.put('/api/v1/settings/risk', { schema: { tags: ['settings'], body: { type: 'object', required: ['dueDays'], additionalProperties: false, properties: { dueDays: { type: 'number' } } } } }, async (req) =>
    scoped(req, 'risk.cycle.manage', (tx, ctx) => riskQuestions.putRiskSettings(tx, ctx, req.body as { dueDays: unknown })));
  // --- v2 Faz 6 Görev 4: yıllık risk değerlendirmesi ---------------------------------------------------------------------
  {
    const year = { type: 'integer', minimum: 2000, maximum: 2100 } as const;
    const crit = { anyOf: [{ type: 'integer', enum: [1, 3, 5] }, { type: 'null' }] } as const;
    const method = { type: 'string', enum: ['ON_SITE', 'ONLINE', 'DESK'] } as const;
    const id = (req: FastifyRequest) => (req.params as { id: string }).id;
    app.get('/api/v1/risk/assessments', { schema: { tags: ['risk'], querystring: { type: 'object', additionalProperties: false, properties: {
      year, status: { type: 'string', enum: ['OPEN', 'COMPLETED', 'CANCELLED'] }, level: { type: 'integer', minimum: 1, maximum: 5 }, departmentId: uuid,
      overdue: { type: 'boolean' } } } } }, async (req) =>
      scoped(req, 'risk.read', (tx, ctx) => riskAssessments.listAssessments(tx, ctx, req.query as any)));
    app.get('/api/v1/risk/matrix', { schema: { tags: ['risk'], querystring: { type: 'object', additionalProperties: false, properties: { year } } } }, async (req) =>
      scoped(req, 'risk.read', (tx) => riskAssessments.matrix(tx, (req.query as { year?: number }).year ?? Number(riskAssessments.istanbulToday().slice(0, 4)))));
    app.get('/api/v1/risk/assessments/:id', { schema: { tags: ['risk'], params: idParams } }, async (req) =>
      scoped(req, 'risk.read', (tx, ctx) => riskAssessments.getAssessment(tx, ctx, id(req))));
    app.put('/api/v1/risk/assessments/:id/draft', { schema: { tags: ['risk'], params: idParams, body: { type: 'object', additionalProperties: false, properties: {
      criteria: { type: 'object', maxProperties: 6, additionalProperties: crit },
      questionSetId: { anyOf: [uuid, { type: 'null' }] },
      answers: { type: 'object', maxProperties: 500, additionalProperties: { anyOf: [{ type: 'string', enum: ['YES', 'NO'] }, { type: 'null' }] } },
      manualScore: { anyOf: [{ type: 'string', maxLength: 10 }, { type: 'number' }, { type: 'null' }] },
      manualNote: nullable({ type: 'string', maxLength: 5000 }) } } } }, async (req) =>
      scoped(req, 'risk.assess', (tx, ctx) => riskAssessments.saveDraft(tx, ctx, id(req), req.body as riskAssessments.DraftInput)));
    app.post('/api/v1/risk/assessments/:id/complete', { schema: { tags: ['risk'], params: idParams } }, async (req) =>
      scoped(req, 'risk.assess', (tx, ctx) => riskAssessments.complete(tx, ctx, id(req))));
    app.post('/api/v1/risk/assessments/:id/actions', { schema: { tags: ['risk'], params: idParams, body: { type: 'object', required: ['kind', 'title'], additionalProperties: false, properties: {
      kind: { type: 'string', enum: ['MITIGATION', 'CONTROL'] }, title: { type: 'string', maxLength: 1000 }, description: nullable({ type: 'string', maxLength: 4000 }),
      ownerUserId: { anyOf: [uuid, { type: 'null' }] }, ownerText: nullable({ type: 'string', maxLength: 200 }), dueOn: nullable({ type: 'string', maxLength: 10 }),
      controlMethod: { anyOf: [method, { type: 'null' }] }, supplierVisible: { type: 'boolean' } } } } }, async (req, reply) =>
      reply.status(201).send(await scoped(req, 'risk.assess', (tx, ctx) => riskAssessments.addAction(tx, ctx, id(req), req.body as riskAssessments.ActionInput))));
    // Aksiyon sahibi başka departmanda olabilir (054a): okuma izniyle girer, modül sahibi yalnız durum/not ile sınırlar.
    app.patch('/api/v1/risk/actions/:id', { schema: { tags: ['risk'], params: idParams, body: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
      title: { type: 'string', maxLength: 1000 }, description: nullable({ type: 'string', maxLength: 4000 }), ownerUserId: { anyOf: [uuid, { type: 'null' }] },
      ownerText: nullable({ type: 'string', maxLength: 200 }), dueOn: nullable({ type: 'string', maxLength: 10 }), controlMethod: method, supplierVisible: { type: 'boolean' },
      status: { type: 'string', enum: ['DONE', 'VERIFIED', 'CANCELLED'] }, completionNote: nullable({ type: 'string', maxLength: 2000 }) } } } }, async (req) =>
      scoped(req, 'risk.read', (tx, ctx) => riskAssessments.patchAction(tx, ctx, id(req), req.body as riskAssessments.ActionPatch)));
    app.post('/api/v1/risk/assessments/:id/opinions', { schema: { tags: ['risk'], params: idParams, body: { type: 'object', required: ['body'], additionalProperties: false, properties: {
      body: { type: 'string', maxLength: 4000 } } } } }, async (req, reply) =>
      reply.status(201).send(await scoped(req, 'risk.opinion', (tx, ctx) => riskAssessments.addOpinion(tx, ctx, id(req), (req.body as { body: string }).body))));
    app.put('/api/v1/risk/assessments/:id/department', { schema: { tags: ['risk'], params: idParams, body: { type: 'object', required: ['departmentId'], additionalProperties: false, properties: {
      departmentId: uuid } } } }, async (req) =>
      scoped(req, 'risk.cycle.manage', (tx, ctx) => riskAssessments.setDepartment(tx, ctx, id(req), (req.body as { departmentId: string }).departmentId)));
    app.post('/api/v1/risk/assessments/:id/reviews', { schema: { tags: ['risk'], params: idParams, body: { type: 'object', required: ['period', 'outcome'], additionalProperties: false, properties: {
      period: { type: 'string', maxLength: 10 }, outcome: { type: 'string', enum: ['NO_CHANGE', 'UPDATE'] } } } } }, async (req, reply) =>
      reply.status(201).send(await scoped(req, 'risk.assess', (tx, ctx) => riskAssessments.review(tx, ctx, id(req), req.body as { period: string; outcome: 'NO_CHANGE' | 'UPDATE' }))));
    app.get('/api/v1/suppliers/:id/risk-history', { schema: { tags: ['risk'], params: idParams } }, async (req) =>
      scoped(req, 'risk.read', (tx, ctx) => riskAssessments.supplierHistory(tx, ctx, id(req))));
    app.get('/api/v1/portal/risk', { schema: { tags: ['portal'] } }, async (req) => scoped(req, 'portal.standing', (tx, ctx) => riskAssessments.portalRisk(tx, ctx)));
    // v2 Faz 6 Görev 5 (R6): yılı elle açma (yıl ortasında başlangıç); işçinin 1 Ocak açılışıyla aynı işlev, idempotent.
    app.post('/api/v1/risk/cycles/:year/open', { schema: { tags: ['risk'], params: { type: 'object', required: ['year'], properties: { year } } } }, async (req) =>
      scoped(req, 'risk.cycle.manage', (tx, ctx) => riskCycle.openRiskYearTenantWide(tx, ctx, (req.params as { year: number }).year, riskAssessments.istanbulToday())));
    // v2 Faz 6 Görev 6 (R11/R12): Excel içe aktarımı (yükle → önizleme → uygula/vazgeç) ve kaynak düzende dışa aktarım.
    app.post('/api/v1/risk/imports', { schema: { tags: ['risk'], consumes: ['multipart/form-data'] } }, async (req, reply) => {
      const file = await req.file();
      if (!file) throw new ApiError(400, 'file_required', 'Dosya gerekli.');
      const body = await file.toBuffer();
      return reply.status(201).send(await scoped(req, 'risk.import', (tx, ctx) => riskImport.createImport(tx, ctx, { fileName: file.filename, body })));
    });
    app.get('/api/v1/risk/imports/:id', { schema: { tags: ['risk'], params: idParams } }, async (req) =>
      scoped(req, 'risk.import', (tx, ctx) => riskImport.getImport(tx, ctx, id(req))));
    app.put('/api/v1/risk/imports/:id', { schema: { tags: ['risk'], params: idParams, body: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
      year, teamMapping: { type: 'object', maxProperties: 500, additionalProperties: { anyOf: [uuid, { type: 'null' }] } },
      rows: { type: 'array', maxItems: 5000, items: { type: 'object', required: ['rowNo'], additionalProperties: false, properties: {
        rowNo: { type: 'integer', minimum: 1 }, decision: { type: 'string', enum: ['CREATE', 'SKIP', 'NEW_CANDIDATE'] },
        supplierId: { anyOf: [uuid, { type: 'null' }] }, primary: { type: 'boolean' } } } } } } } }, async (req) =>
      scoped(req, 'risk.import', (tx, ctx) => riskImport.updateImport(tx, ctx, id(req), req.body as riskImport.ImportPatch)));
    app.post('/api/v1/risk/imports/:id/apply', { schema: { tags: ['risk'], params: idParams } }, async (req) =>
      scoped(req, 'risk.import', (tx, ctx) => riskImport.applyImport(tx, ctx, id(req))));
    app.post('/api/v1/risk/imports/:id/discard', { schema: { tags: ['risk'], params: idParams } }, async (req) =>
      scoped(req, 'risk.import', (tx, ctx) => riskImport.discardImport(tx, ctx, id(req))));
    app.get('/api/v1/risk/export.xlsx', { schema: { tags: ['risk'], querystring: { type: 'object', additionalProperties: false, properties: {
      year, period: { type: 'string', pattern: '^[0-9]{4}-[1-4]$' } } } } }, async (req, reply) => {
      const r = await scoped(req, 'risk.export', (tx, ctx) => riskImport.exportRisk(tx, ctx, req.query as { year?: number; period?: string }));
      const ascii = r.fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
      return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.fileName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`)
        .header('cache-control', 'no-store').send(r.buf);
    });
  }
  app.get('/api/v1/settings/contract-reminders', { schema: { tags: ['settings'] } }, async (req) =>
    scoped(req, 'reminder.settings', (tx) => reminders.getSettings(tx)));
  app.put('/api/v1/settings/contract-reminders', { schema: { tags: ['settings'], body: { type: 'object', required: ['offsets'], additionalProperties: false, properties: {
    offsets: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 365 } } } } } }, async (req) =>
    scoped(req, 'reminder.settings', (tx, ctx) => reminders.putSettings(tx, ctx, req.body as { offsets: number[] })));
  const previewQuery = { type: 'object', additionalProperties: false, properties: { useDeputyForHead: { type: 'boolean' },
    extraApproverIds: { type: 'array', maxItems: 10, items: uuid } } } as const;
  app.get('/api/v1/contracts/:id/approval-preview', { schema: { tags: ['contracts'], params: idParams, querystring: previewQuery } }, async (req) =>
    scoped(req, 'contract.read', (tx, ctx) => intake.approvalPreview(tx, ctx, (req.params as { id: string }).id, req.query as any)));
  app.post('/api/v1/contracts/:id/submit', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', additionalProperties: false, properties: {
    useDeputyForHead: { type: 'boolean' }, extraApproverIds: { type: 'array', maxItems: 10, items: uuid }, note: nullable({ type: 'string', maxLength: 2000 }) } } } }, async (req) =>
    scoped(req, 'contract.manage', (tx, ctx) => intake.submitContract(tx, ctx, (req.params as { id: string }).id, (req.body ?? {}) as any)));
  // --- Onay kararı (v2 Faz 3, Görev 5: R4–R6) ----------------------------------------------------------------------------
  app.post('/api/v1/contract-approval-steps/:id/decision', { schema: { tags: ['contracts'], params: idParams, body: { type: 'object', required: ['decision'], additionalProperties: false,
    properties: { decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] }, reason: nullable({ type: 'string', maxLength: 2000 }) } } } }, async (req) =>
    scoped(req, 'contract.approve', (tx, ctx) => contractApprovals.decideStep(tx, ctx, (req.params as { id: string }).id, req.body as any)));
  app.get('/api/v1/contract-approvals/mine', { schema: { tags: ['contracts'] } }, async (req) =>
    scoped(req, 'contract.approve', (tx, ctx) => contractApprovals.myApprovals(tx, ctx)));
  app.post('/api/v1/suppliers/candidates', { schema: { tags: ['suppliers'], body: { type: 'object', required: ['legalName', 'vkn'], additionalProperties: false,
    properties: { legalName: text(300), vkn: { type: 'string', minLength: 1, maxLength: 20 }, contactEmail: nullable({ type: 'string', maxLength: 254 }) } } } }, async (req, reply) => {
    const r = await scoped(req, 'supplier.candidate.create', (tx, ctx) => createCandidateSupplier(tx, ctx, req.body as any));
    return reply.status(r.existing ? 200 : 201).send(r);
  });

  app.get('/api/v1/contract-versions/:id/signature-status', { schema: { tags: ['signatures'], params: idParams } }, async (req, reply) => {
    const s = await scoped(req, 'contract.read', async (tx, ctx) => {
      const status = await contracts.reconcileExpiredExceptions(tx, ctx, (req.params as { id: string }).id);
      const parties = await tx.query(`SELECT id, party_role AS role, display_name AS "displayName" FROM contract_parties WHERE contract_version_id = $1`,
        [(req.params as { id: string }).id]);
      return { ...status, parties: parties.rows, can: {
        review: can(ctx.roles, 'signature.review'), defineRequirement: can(ctx.roles, 'signature.requirement.define'),
        analyze: can(ctx.roles, 'signature.analyze'), custody: can(ctx.roles, 'signature.custody.record'),
        requestException: can(ctx.roles, 'signature.exception.request'), decideException: can(ctx.roles, 'signature.exception.decide'),
        // D95a: ekleyen kesinleştiremez (sunucu da 403 segregation_of_duties döner).
        finalize: can(ctx.roles, 'signature.finalize') && status.contractVersion.createdBy !== ctx.userId, manage: can(ctx.roles, 'contract.manage'),
        finalizeOwnRecord: can(ctx.roles, 'signature.finalize') && status.contractVersion.createdBy === ctx.userId,
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
    contracts.addContractVersion(tx, ctx, (req.params as any).id, ifMatch(req), req.body as any, { aiModelId: contractAi.contractAiModelId(deps.config.ai) }))));

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
  app.get('/api/v1/invoices', { schema: { tags: ['invoices'], querystring: { type: 'object', properties: { departmentId: uuid, match: { type: 'string', enum: ['ALL', 'MATCHED', 'UNMATCHED'] } } } } },
    async (req) => scoped(req, 'invoice.read', async (tx, ctx) => {
      const q = req.query as { departmentId?: string; match?: invoices.MatchFilter };
      return { items: await invoices.listInvoices(tx, q), counts: await invoiceMatching.matchCounts(tx, q),
        can: { match: can(ctx.roles, 'invoice.match'), retryQueue: can(ctx.roles, 'invoice.manage') } };
    }));
  // v2 Faz 7 (R2, R3): eşleştirme kuyruğu, adaylar, elle bağlama ve bağ kaldırma.
  app.post('/api/v1/invoices/match-queue/retry', { schema: { tags: ['invoices'] } }, async (req) =>
    scoped(req, 'invoice.manage', (tx, ctx) => invoiceMatching.retryMatchQueue(tx, ctx)));
  app.get('/api/v1/invoices/:id/match-candidates', { schema: { tags: ['invoices'], params: idParams } }, async (req) =>
    scoped(req, 'invoice.match', (tx, ctx) => invoiceMatching.matchCandidates(tx, ctx, (req.params as { id: string }).id)));
  app.post('/api/v1/invoices/:id/match', { schema: { tags: ['invoices'], params: idParams, body: { type: 'object', required: ['familyId'], additionalProperties: false,
    properties: { familyId: uuid, acknowledgeOutOfRange: { type: 'boolean' }, note: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }] } } } } }, async (req) =>
    scoped(req, 'invoice.match', (tx, ctx) => invoiceMatching.linkInvoice(tx, ctx, (req.params as { id: string }).id, req.body as any)));
  app.delete('/api/v1/invoices/:id/match', { schema: { tags: ['invoices'], params: idParams, body: { type: 'object', required: ['reason'], additionalProperties: false,
    properties: { reason: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'invoice.match', (tx, ctx) => invoiceMatching.unlinkInvoice(tx, ctx, (req.params as { id: string }).id, req.body as any)));
  app.get('/api/v1/invoices/:id', { schema: { tags: ['invoices'], params: idParams } }, async (req) => scoped(req, 'invoice.read', async (tx, ctx) =>
    ({ ...(await invoices.getInvoice(tx, ctx, (req.params as any).id)), can: { manage: can(ctx.roles, 'invoice.manage'), approve: can(ctx.roles, 'invoice.approve'),
      approveException: can(ctx.roles, 'invoice.exception.approve'), match: can(ctx.roles, 'invoice.match') } })));
  app.post('/api/v1/invoices', { schema: { tags: ['invoices'], body: { type: 'object', required: ['companyId', 'supplierId', 'kind', 'invoiceNo', 'issueDate', 'currency', 'lines'], additionalProperties: false,
    properties: { companyId: uuid, supplierId: uuid, kind: { type: 'string', enum: ['INVOICE', 'CREDIT_NOTE', 'ADVANCE'] }, invoiceNo: { type: 'string', minLength: 1, maxLength: 40 },
      ettn: { anyOf: [uuid, { type: 'null' }] }, issueDate: { type: 'string', format: 'date' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' }, documentVersionId: { anyOf: [uuid, { type: 'null' }] },
      erpContractRef: { anyOf: [{ type: 'string', maxLength: 60 }, { type: 'null' }] }, erpOrderRef: { anyOf: [{ type: 'string', maxLength: 60 }, { type: 'null' }] },
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
    properties: { decision: { type: 'string', enum: ['RENEW', 'TERMINATE', 'RENEGOTIATE', 'NEW_PROJECT'] }, rationale: { type: 'string', maxLength: 4000 } } } } }, async (req, reply) =>
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

  app.get('/api/v1/projects', { schema: { tags: ['projects'], querystring: departmentFilter } }, async (req) => scoped(req, 'project.read', async (tx) =>
    ({ items: await sourcing.listProjects(tx, req.query as { departmentId?: string }) })));
  app.post('/api/v1/projects', { schema: { tags: ['projects'], body: { ...projectBody, required: [...projectBody.required, 'companyId'],
    properties: { ...projectBody.properties, departmentId: optDepartment } } } }, async (req, reply) => {
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
    scoped(req, 'approval.decide', (tx, ctx) => sourcing.decidePublish(tx, ctx, (req.params as any).id, req.body as any, { webOrigin: deps.config.webOrigin })));
  app.post('/api/v1/rfq-rounds/:id/close', { schema: { tags: ['rfq'], params: idParams, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
    scoped(req, 'project.publish.approve', (tx, ctx) => sourcing.closeRoundEarly(tx, ctx, (req.params as any).id, (req.body as any).reason)));
  app.post('/api/v1/rfq-questions/:id/answer', { schema: { tags: ['rfq'], params: idParams, body: { type: 'object', required: ['answer'], properties: { answer: { type: 'string', maxLength: 4000 } } } } }, async (req) =>
    scoped(req, 'rfq.answer', (tx, ctx) => sourcing.answerQuestion(tx, ctx, (req.params as any).id, (req.body as any).answer)));
  // v2 Faz 7 (R4): projenin sözleşmelerine bağlı/tahsisli faturalar ve sözleşme başına kullanım.
  app.get('/api/v1/projects/:id/invoices', { schema: { tags: ['projects'], params: idParams } }, async (req) =>
    scoped(req, 'project.read', async (tx, ctx) => {
      if (!can(ctx.roles, 'invoice.read') && !can(ctx.roles, 'contract.read')) throw forbidden('invoice.read');
      return invoiceMatching.projectInvoices(tx, (req.params as { id: string }).id);
    }));
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
  app.get('/api/v1/suppliers/:id/assessments', { schema: { tags: ['evaluation'], params: idParams, querystring: departmentFilter } }, async (req) => scoped(req, 'assessment.read', async (tx, ctx) =>
    ({ items: await evals.supplierAssessments(tx, ctx, (req.params as any).id, req.query as { departmentId?: string }), can: { manage: can(ctx.roles, 'assessment.manage') } })));
  app.post('/api/v1/assessments', { schema: { tags: ['evaluation'], body: { type: 'object', required: ['supplierId', 'templateId', 'scope', 'inherentFactors'], additionalProperties: false,
    properties: { supplierId: uuid, templateId: uuid, scope: { type: 'string', minLength: 3, maxLength: 300 }, reviewDue: optDate, departmentId: optDepartment,
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
    ({ ...(await ai.overview(tx, deps.config.ai)), can: { manage: can(ctx.roles, 'ai.policy.manage') } })));
  // v2 Faz 4 Görev 5 (R10): sözleşme inceleme eşiği (kiracı ayarı; Yönetici değiştirir).
  app.get('/api/v1/ai/contract-settings', { schema: { tags: ['ai'] } }, async (req) => scoped(req, 'ai.read', async (tx, ctx) =>
    ({ ...(await ai.contractSettings(tx)), can: { manage: can(ctx.roles, 'ai.policy.manage') } })));
  app.put('/api/v1/ai/contract-settings', { schema: { tags: ['ai'], body: { type: 'object', required: ['reviewThreshold'], additionalProperties: false,
    properties: { reviewThreshold: { type: 'integer', minimum: 0, maximum: 100 } } } } }, async (req) =>
    scoped(req, 'ai.policy.manage', (tx, ctx) => ai.setContractSettings(tx, ctx, req.body as { reviewThreshold: number })));
  app.put('/api/v1/ai/policy', { schema: { tags: ['ai'], body: { type: 'object', required: ['allowedProviders', 'allowedRegions', 'monthlyBudget', 'budgetCurrency', 'dailyCallLimit', 'allowUpgrade'], additionalProperties: false,
    properties: { allowedProviders: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 60 } }, allowedRegions: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40 } },
      // null önce: tür dönüştürme boş değeri "" veya 0'a çevirmesin (boş = sınırsız).
      monthlyBudget: { anyOf: [{ type: 'null' }, { type: 'string' }] }, budgetCurrency: { type: 'string', pattern: '^[A-Z]{3}$' }, dailyCallLimit: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0 }] },
      allowUpgrade: { type: 'boolean' } } } } }, async (req) => scoped(req, 'ai.policy.manage', (tx, ctx) => ai.setPolicy(tx, ctx, req.body as any)));
  app.delete('/api/v1/ai/policy', { schema: { tags: ['ai'] } }, async (req) => scoped(req, 'ai.policy.manage', (tx, ctx) => ai.deletePolicy(tx, ctx)));
  app.post('/api/v1/ai/runs/:id/retry', { schema: { tags: ['ai'], params: idParams } }, async (req) => scoped(req, 'ai.read', (tx, ctx) =>
    ai.retryRun(tx, ctx, (req.params as any).id, { modelId: contractAi.contractAiModelId(deps.config.ai) })));
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

  // --- v2 Faz 8 (D113): ERP uç noktaları (7 özellik kartı, sır yalnız yazılır, sınama, R3 yazma, çalışmalar) ------------------
  const erpFeatureParams = { type: 'object', required: ['feature'], properties: { feature: { type: 'string', enum: [...ERP_FEATURES] } } } as const;
  const fieldMapSchema = { type: 'object', maxProperties: 20, additionalProperties: { type: 'object', required: ['path', 'transform'], additionalProperties: false,
    properties: { path: { type: 'string', maxLength: 120 }, transform: { type: 'string', maxLength: 20 } } } } as const;
  app.get('/api/v1/integration/endpoints', { schema: { tags: ['integration'] } }, async (req) =>
    scoped(req, 'integration.endpoint.read', (tx, ctx) => erpEndpoints.listEndpoints(tx, ctx, deps.config,
      { manage: can(ctx.roles, 'integration.endpoint.manage'), run: can(ctx.roles, 'integration.endpoint.run') })));
  app.put('/api/v1/integration/endpoints/:feature', { schema: { tags: ['integration'], params: erpFeatureParams, body: { type: 'object', additionalProperties: false, properties: {
    enabled: { type: 'boolean' }, baseUrl: nullableText(500), resourcePath: nullableText(200),
    authType: { anyOf: [{ type: 'string', enum: ['BASIC', 'OAUTH2_CLIENT_CREDENTIALS'] }, { type: 'null' }] },
    username: nullableText(200), clientId: nullableText(200), tokenUrl: nullableText(500),
    secret: { anyOf: [{ type: 'string', minLength: 1, maxLength: 4096 }, { type: 'null' }] },
    schedule: { type: 'object', required: ['mode'], additionalProperties: false, properties: { mode: { type: 'string', enum: ['MANUAL', 'INTERVAL', 'DAILY'] },
      intervalMinutes: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, dailyTime: nullableText(5) } },
    fieldMap: fieldMapSchema, timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 } } } } }, async (req) =>
    scoped(req, 'integration.endpoint.manage', (tx, ctx) => erpEndpoints.updateEndpoint(tx, ctx, deps.config, (req.params as any).feature, req.body as erpEndpoints.EndpointBody)));
  app.post('/api/v1/integration/endpoints/:feature/write-enable', { schema: { tags: ['integration'], params: erpFeatureParams,
    body: { type: 'object', required: ['confirm'], additionalProperties: false, properties: { confirm: { type: 'boolean' } } } } }, async (req) =>
    scoped(req, 'integration.endpoint.manage', (tx, ctx) => erpEndpoints.enableWrite(tx, ctx, deps.config, (req.params as any).feature, (req.body as any).confirm === true)));
  app.delete('/api/v1/integration/endpoints/:feature/write-enable', { schema: { tags: ['integration'], params: erpFeatureParams } }, async (req) =>
    scoped(req, 'integration.endpoint.manage', (tx, ctx) => erpEndpoints.disableWrite(tx, ctx, (req.params as any).feature)));
  app.post('/api/v1/integration/endpoints/:feature/test', { schema: { tags: ['integration'], params: erpFeatureParams } }, async (req) => {
    const feature = (req.params as any).feature as string;
    // Sağlayıcı çağrısı veritabanı işlemi dışında; sonuç ayrı işlemde yazılır. Sır yalnız bu çağrı süresince bellekte.
    const prepared = await scoped(req, 'integration.endpoint.run', (tx, ctx) => erpEndpoints.prepareTest(tx, ctx, deps.config, feature));
    const result = await erpEndpoints.executeTest(prepared);
    return scoped(req, 'integration.endpoint.run', (tx, ctx) => erpEndpoints.recordTest(tx, ctx, feature, prepared.endpointId, result));
  });
  // Gövde isteğe bağlı: { target?: 'READ' | 'WRITE_RETRY' } (modülde denetlenir).
  app.post('/api/v1/integration/endpoints/:feature/run', { schema: { tags: ['integration'], params: erpFeatureParams } }, async (req, reply) =>
    reply.status(202).send(await scoped(req, 'integration.endpoint.run', (tx, ctx) => erpEndpoints.requestRun(tx, ctx, deps.config, (req.params as any).feature, (req.body as any)?.target))));
  app.get('/api/v1/integration/endpoints/:feature/runs', { schema: { tags: ['integration'], params: erpFeatureParams,
    querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }, async (req) =>
    scoped(req, 'integration.endpoint.read', (tx) => erpEndpoints.listRuns(tx, (req.params as any).feature, (req.query as any).limit ?? 20)));
  app.get('/api/v1/integration/runs/:id/errors', { schema: { tags: ['integration'], params: idParams } }, async (req) =>
    scoped(req, 'integration.endpoint.read', (tx) => erpEndpoints.runErrors(tx, (req.params as any).id)));

  app.get('/api/v1/supplier-options', { schema: { tags: ['projects'] } }, async (req) => scoped(req, 'supplier.read', async (tx) => {
    const rows = (await tx.query<{ id: string; legalName: string; status: string; taxIdType: string | null; taxId: string | null; identityReviewRequired: boolean }>(
      `SELECT id, legal_name AS "legalName", status, tax_id_type AS "taxIdType", tax_id AS "taxId", identity_review_required AS "identityReviewRequired", created_at AS "createdAt"
         FROM suppliers WHERE status IN ('ACTIVE','CONDITIONAL','CANDIDATE') ORDER BY legal_name, created_at LIMIT 500`)).rows;
    // Aynı adlı kayıtlar listede ayırt edilsin (D82); tam vergi kimliği dönmez, yalnız son 4 hane.
    const labels = supplierOptionLabels(rows);
    // v2 Faz 5 (R9): adaylar listede kalır ama seçilemez (`eligibleForInvite: false`, nedenli).
    return { items: rows.map((r) => {
      const eligible = canInviteSupplier(r.status as SupplierStatus);
      return { id: r.id, legalName: r.legalName, status: r.status, label: labels.get(r.id)!,
        taxIdTail: taxIdTail(r.taxIdType, r.taxId), identityVerified: !r.identityReviewRequired && !!r.taxId,
        stageLabel: supplierStage(r.status as SupplierStatus).label, eligibleForInvite: eligible, ineligibleReason: eligible ? null : supplierCard.SUPPLIER_NOT_APPROVED_MSG };
    }) };
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

  // --- v2 Faz 5 (D110) Görev 6: tedarikçi portalı — özet, Tekliflerim, Belgelerim, Skorum ve risk, Firma bilgileri -----------------
  // Yalnız SUPPLIER rolü; tedarikçi oturumu yalnız kendi kartını görür (R17). Skor/risk yalnız SECURITY DEFINER işlevlerinden (R15).
  app.get('/api/v1/portal/summary', { schema: { tags: ['portal'] } }, async (req) => scoped(req, 'bid.submit', (tx, ctx) => portal.summary(tx, ctx)));
  app.get('/api/v1/portal/bids', { schema: { tags: ['portal'] } }, async (req) => scoped(req, 'bid.submit', (tx, ctx) => portal.bids(tx, ctx)));
  app.get('/api/v1/portal/documents', { schema: { tags: ['portal'] } }, async (req) => scoped(req, 'portal.documents', (tx, ctx) => portal.documents(tx, ctx)));
  app.post('/api/v1/portal/documents', { schema: { tags: ['portal'], consumes: ['multipart/form-data'] } }, async (req, reply) => {
    // İzin dosya okunmadan önce denetlenir; dosya denetimi ve tarama işlem dışında, depoya yazma işlemden önce (Görev 4 I1), hata olursa silinir.
    await scoped(req, 'portal.documents', async () => undefined);
    const fields: Record<string, string> = {};
    let file: { filename: string; mimetype: string; body: Buffer } | null = null;
    try {
      for await (const part of req.parts({ limits: { fileSize: supplierCard.SUPPLIER_DOC_MAX_BYTES, files: 1, fields: 10, fieldSize: 2000 } })) {
        if (part.type === 'file') file = { filename: part.filename, mimetype: part.mimetype, body: await part.toBuffer() };
        else fields[part.fieldname] = String(part.value ?? '');
      }
    } catch (err: any) {
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') throw unprocessable('file_too_large', 'Dosya 10 MB sınırını aşıyor.');
      throw err;
    }
    if (!file) throw unprocessable('file_required', 'Dosya seçin.');
    const upload = { ...file, fields };
    const prepared = await scoped(req, 'portal.documents', async (_tx, ctx) => portal.preparePortalUpload(upload, ctx.tenantId, scanner));
    await deps.store.put(prepared.storageKey, file.body, prepared.mimeType);
    try {
      return reply.status(201).send(await scoped(req, 'portal.documents', (tx, ctx) => portal.addPortalDocument(tx, ctx, upload, prepared)));
    } catch (err) {
      await deps.store.delete(prepared.storageKey).catch(() => req.log.warn({ key: prepared.storageKey }, 'portal document cleanup failed'));
      throw err;
    }
  });
  app.get('/api/v1/portal/standing', { schema: { tags: ['portal'] } }, async (req) => scoped(req, 'portal.standing', (tx, ctx) => portal.standing(tx, ctx)));
  app.get('/api/v1/portal/profile', { schema: { tags: ['portal'] } }, async (req) => scoped(req, 'portal.profile', (tx, ctx) => portal.profile(tx, ctx)));
  app.put('/api/v1/portal/profile', { schema: { tags: ['portal'], body: { type: 'object', required: ['contactName'], additionalProperties: false, properties: {
    contactName: { type: 'string', maxLength: 200 }, contactPhone: { type: ['string', 'null'], maxLength: 40 }, address: { type: ['string', 'null'], maxLength: 1000 } } } } }, async (req) =>
    scoped(req, 'portal.profile', (tx, ctx) => portal.updateProfile(tx, ctx, req.body as { contactName: string; contactPhone?: string | null; address?: string | null })));
  app.post('/api/v1/portal/profile/change-request', { schema: { tags: ['portal'], body: { type: 'object', required: ['field', 'note'], additionalProperties: false, properties: {
    field: { type: 'string', enum: ['LEGAL_NAME', 'TAX_ID', 'OTHER'] }, note: { type: 'string', maxLength: 1000 } } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'portal.profile', (tx, ctx) => portal.requestChange(tx, ctx, req.body as { field: portal.ChangeField; note: string }))));

  // --- v2 Faz 5 (D110): girişsiz tedarikçi başvurusu (R2–R5) -------------------------------------------------
  // Oturum gerekmez; yalnız 052 SECURITY DEFINER işlevleri çağrılır, yanıtta kiracı kimliği (`internal`) yoktur.
  const publicDeps = (): applications.SubmitDeps => ({ pool: deps.pool, store: deps.store, scanner, channel: mail, webOrigin: deps.config.webOrigin,
    tenantPerHour: deps.config.publicRateLimit?.tenantPerHour });
  const slugParams = { type: 'object', required: ['slug'], properties: { slug: { type: 'string', maxLength: 64 } } } as const;
  app.get('/api/v1/public/applications/:slug/config', { onRequest: publicLimiter.hook('read'), schema: { tags: ['public'], security: [], params: slugParams } }, async (req) =>
    (await applications.loadPublicConfig(deps.pool, (req.params as { slug: string }).slug)).config);
  app.post('/api/v1/public/applications/verify', { onRequest: publicLimiter.hook('token'), schema: { tags: ['public'], security: [],
    body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', maxLength: 200 } } } } },
  async (req) => applications.verifyApplication(deps.pool, (req.body as { token: string }).token));
  const appToken = (req: FastifyRequest) => req.headers['x-application-token'];
  app.get('/api/v1/public/applications/complete-info', { onRequest: publicLimiter.hook('token'), schema: { tags: ['public'], security: [] } }, async (req) =>
    applications.completeInfo(deps.pool, appToken(req)));
  app.post('/api/v1/public/applications/complete', { onRequest: publicLimiter.hook('token'), schema: { tags: ['public'], security: [], consumes: ['multipart/form-data'] } },
    async (req) => applications.completeApplication(publicDeps(), appToken(req), () => applications.readApplicationForm(req.parts({ limits: applications.MULTIPART_LIMITS }))));
  app.post('/api/v1/public/applications/:slug', { onRequest: publicLimiter.hook('apply'), schema: { tags: ['public'], security: [], params: slugParams, consumes: ['multipart/form-data'] } },
    async (req, reply) => {
      const slug = (req.params as { slug: string }).slug;
      const { config, tenantId } = await applications.loadPublicConfig(deps.pool, slug);
      if (!config.enabled || !tenantId) throw new ApiError(404, 'applications_closed', 'Başvuru şu an kabul edilmiyor.');
      const form = await applications.readApplicationForm(req.parts({ limits: applications.MULTIPART_LIMITS }));
      // R4d: tuzak alanı doluysa kayıt açılmaz, dosya yazılmaz; yanıt aynı.
      if (applications.isHoneypot(form)) return reply.status(202).send(await applications.honeypotResponse(mail));
      const input = applications.validateApplication(form, config);
      const docs = await applications.prepareDocuments(form, tenantId, scanner);
      return reply.status(202).send(await applications.submitApplication(publicDeps(), slug, tenantId, req.ip, input, docs));
    });

  // --- v2 Faz 5 (R3): başvuru ayarları ve belge türleri (okuma Yönetici + Satınalma, yazma Yönetici) ------------------
  app.get('/api/v1/settings/supplier-applications', { schema: { tags: ['settings'] } }, async (req) =>
    scoped(req, 'supplier.application.settings.view', async (tx, ctx) => ({ ...(await applications.getSettings(tx)),
      can: { manage: can(ctx.roles, 'supplier.application.settings') } })));
  app.put('/api/v1/settings/supplier-applications', { schema: { tags: ['settings'], body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: {
    enabled: { type: 'boolean' }, publicSlug: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
    categories: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 100 } } } } } }, async (req) =>
    scoped(req, 'supplier.application.settings', (tx, ctx) => applications.putSettings(tx, ctx, req.body as { enabled: boolean; publicSlug?: string | null; categories?: string[] })));
  const docTypeProps = { name: { type: 'string', maxLength: 120 }, required: { type: 'boolean' }, expiryRequired: { type: 'boolean' },
    requiredCategories: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 100 } } } as const;
  app.get('/api/v1/settings/supplier-document-types', { schema: { tags: ['settings'] } }, async (req) =>
    scoped(req, 'supplier.application.settings.view', async (tx, ctx) => ({ ...(await applications.listDocumentTypes(tx)),
      can: { manage: can(ctx.roles, 'supplier.application.settings') } })));
  app.post('/api/v1/settings/supplier-document-types', { schema: { tags: ['settings'], body: { type: 'object', required: ['code', 'name'], additionalProperties: false,
    properties: { code: { type: 'string', maxLength: 40 }, ...docTypeProps } } } }, async (req, reply) =>
    reply.status(201).send(await scoped(req, 'supplier.application.settings', (tx, ctx) => applications.createDocumentType(tx, ctx, req.body as any))));
  // Silme yok: tür `active=false` ile kapanır (belgeler koda bağlıdır; kod değişmez).
  app.put('/api/v1/settings/supplier-document-types/:id', { schema: { tags: ['settings'], params: idParams, body: { type: 'object', additionalProperties: false,
    properties: { ...docTypeProps, active: { type: 'boolean' } } } } }, async (req) =>
    scoped(req, 'supplier.application.settings', (tx, ctx) => applications.updateDocumentType(tx, ctx, (req.params as { id: string }).id, req.body as any)));

  return app;
}

/** 052 SQLSTATE → HTTP. `invalid_application: <neden>` nedeni koddur; bilinmeyen neden genel kodla döner. */
const SP422_MESSAGES: Record<string, string> = {
  documents_missing: 'İstenen belgelerin hepsi yüklenmeli.',
  document_type: 'Belge türü bu başvuruda kabul edilmiyor.',
  file_infected: 'Dosyada virüs bulundu; başvuru kaydedilmedi.',
  file_size: 'Dosya 10 MB sınırını aşıyor.',
  total_size: 'Dosyaların toplamı 40 MB sınırını aşıyor.',
  too_many_files: 'En çok 10 dosya yüklenebilir.',
  valid_until_required: 'Bu belge için geçerlilik tarihi gerekli.',
  categories: 'Seçilen hizmet kategorisi bu başvuru formunda yok.',
  contact_email: 'Geçerli bir e-posta adresi girin.',
  tax_id: 'Vergi kimlik numarası geçersiz.',
};
function publicFunctionError(sqlstate: string, message: string): { status: number; code: string; message: string } | null {
  switch (sqlstate) {
    case 'SP404': return { status: 404, code: 'applications_closed', message: 'Başvuru şu an kabul edilmiyor.' };
    case 'SP409': return { status: 409, code: 'application_exists', message: 'Bu bilgilerle bekleyen bir başvuru var; e-postanızı kontrol edin.' };
    case 'SP410': return { status: 410, code: 'token_invalid', message: 'Bağlantı geçersiz, kullanılmış ya da süresi dolmuş. Gerekirse yeniden başvurun.' };
    case 'SP429': return { status: 429, code: 'rate_limited', message: 'Çok fazla başvuru gönderildi; bir süre sonra tekrar deneyin.' };
    case 'SP422': {
      const reason = /^invalid_application: ([a-z_]+)/.exec(message)?.[1];
      if (reason && SP422_MESSAGES[reason]) return { status: 422, code: reason, message: SP422_MESSAGES[reason]! };
      if (message.startsWith('invalid_contact')) return { status: 422, code: 'invalid_contact', message: 'İletişim bilgileri geçersiz.' };
      return { status: 422, code: 'invalid_application', message: 'Başvuru bilgileri geçersiz; alanları kontrol edin.' };
    }
    default: return null;
  }
}

export type App = Awaited<ReturnType<typeof buildApp>>;
export type { FastifyReply };
