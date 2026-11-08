import {
  noticeDeadline, occurrences, reminderSchedule, termsDiff, validateTerms, ROLES, addDays,
  type CommercialTerms, type NoticeUnit, type NonWorkingDayRule, type Recurrence,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { audit } from '../audit.ts';
import { closeTasks, openTask } from '../tasks.ts';
import { ApiError, conflict, notFound, unprocessable } from '../errors.ts';

/**
 * Faz 3 kalan: sözleşme koşulları (bedel/tavan, süre, ihbar), hukuk doğrulaması, ihbar son gününe göre uyarılar (T21),
 * yükümlülükler ve yenileme/fesih kararı. Durumlar (doğrulandı mı, eskidi mi, dönem durumu) türetilir.
 */

interface TermsRow {
  id: string; contract_version_id: string; company_id: string; revision: number; currency: string; value_type: CommercialTerms['valueType'];
  amount: string | null; payment_terms: string; start_date: string | null; end_date: string | null; auto_renewal: boolean; renewal_months: number | null;
  notice_amount: number | null; notice_unit: NoticeUnit | null; non_working_day_rule: NonWorkingDayRule; source_ref: string; change_reason: string | null; limit_basis: 'NET' | 'GROSS';
  payment_days: number | null; fx_difference: 'ALLOWED' | 'NOT_ALLOWED' | null;
  entered_by: string; entered_at: Date; verified_by: string | null; verified_at: Date | null; entered_by_name?: string; verified_by_name?: string | null;
}
const TERMS_COLS = `t.id, t.contract_version_id, t.company_id, t.revision, t.currency, t.value_type, t.amount::text, t.payment_terms,
  t.start_date::text, t.end_date::text, t.auto_renewal, t.renewal_months, t.notice_amount, t.notice_unit, t.non_working_day_rule, t.source_ref,
  t.change_reason, t.limit_basis, t.payment_days, t.fx_difference, t.entered_by, t.entered_at, t.verified_by, t.verified_at`;
const toTerms = (r: TermsRow): CommercialTerms => ({
  currency: r.currency, valueType: r.value_type, amount: r.amount, paymentTerms: r.payment_terms, startDate: r.start_date, endDate: r.end_date,
  autoRenewal: r.auto_renewal, renewalMonths: r.renewal_months, noticeAmount: r.notice_amount, noticeUnit: r.notice_unit,
  nonWorkingDay: r.non_working_day_rule, sourceRef: r.source_ref, limitBasis: r.limit_basis, paymentDays: r.payment_days, fxDifference: r.fx_difference,
});
// Takvim günü İstanbul saatine göre (gece yarısı ile 03:00 arasında UTC farklı güne düşer).
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const trDate = (d: string) => d.split('-').reverse().join('.');

async function loadCv(tx: Tx, cvId: string) {
  const cv = (await tx.query<{ id: string; company_id: string; family_id: string; superseded_by_id: string | null; title: string; version_no: number }>(
    `SELECT cv.id, cv.company_id, cv.family_id, cv.superseded_by_id, f.title, cv.version_no FROM contract_versions cv
     JOIN contract_families f ON f.id = cv.family_id WHERE cv.id = $1`, [cvId])).rows[0];
  if (!cv) throw notFound();
  return cv;
}
async function latestTerms(tx: Tx, cvId: string): Promise<TermsRow | null> {
  return (await tx.query<TermsRow>(`SELECT ${TERMS_COLS}, eu.display_name AS entered_by_name, vu.display_name AS verified_by_name FROM contract_terms t
    JOIN users eu ON eu.id = t.entered_by LEFT JOIN users vu ON vu.id = t.verified_by
    WHERE t.contract_version_id = $1 ORDER BY t.revision DESC LIMIT 1`, [cvId])).rows[0] ?? null;
}
async function holidays(tx: Tx): Promise<string[]> {
  return (await tx.query<{ day: string }>(`SELECT day::text FROM tenant_holidays ORDER BY day`)).rows.map((r) => r.day);
}

export interface TermsInput extends CommercialTerms { changeReason?: string | null }

/** Vergi dahil limitte açık taahhüt brüt hesaplanır: KDV oranı girilmemiş açık sipariş satırı varken geçilemez (oransız satır %0 sayılmaz). */
async function assertRatedOpenLines(tx: Tx, cvId: string) {
  const n = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
    WHERE po.contract_version_id = $1 AND po.status = 'OPEN' AND pl.tax_rate IS NULL`, [cvId])).rows[0]!.n;
  if (n) throw unprocessable('tax_rate_missing', `Bu sözleşmenin açık siparişlerinde KDV oranı girilmemiş ${n} satır var; vergi dahil limite geçmeden önce bu siparişler oranla yeniden düzenlenmeli veya kapatılmalı.`);
}

export async function saveTerms(tx: Tx, ctx: TenantContext, cvId: string, body: TermsInput) {
  const cv = await loadCv(tx, cvId);
  if (cv.superseded_by_id) throw conflict('version_superseded', 'Bu sürümün yerine yeni sürüm geldi; koşullar güncel sürüme girilir.');
  const prev = await latestTerms(tx, cvId);
  // Gönderilmezse önceki revizyonun yöntemi korunur (alan unutulunca vergi dahil limit sessizce net'e dönmesin).
  body = { ...body, limitBasis: body.limitBasis ?? prev?.limit_basis ?? 'NET',
    paymentDays: body.paymentDays === undefined ? prev?.payment_days ?? null : body.paymentDays,
    fxDifference: body.fxDifference === undefined ? prev?.fx_difference ?? null : body.fxDifference };
  const err = validateTerms(body);
  if (err) throw unprocessable('invalid_terms', err);
  if (body.limitBasis === 'GROSS' && body.valueType === 'CEILING') await assertRatedOpenLines(tx, cvId);
  if (prev && (body.changeReason ?? '').trim().length < 10) throw unprocessable('reason_required', 'Önemli bedel, süre veya ihbar değişikliği için gerekçe gerekli (en az 10 karakter).');
  const decided = prev && (await tx.query(`SELECT 1 FROM renewal_decisions WHERE terms_id = $1`, [prev.id])).rowCount;
  if (decided) throw conflict('renewal_decided', 'Bu koşullar için yenileme/fesih kararı verildi; değişiklik zeyilname (yeni sürüm) ile yapılır.');
  const revision = (prev?.revision ?? 0) + 1;
  const r = (await tx.query<{ id: string }>(`INSERT INTO contract_terms (tenant_id, company_id, contract_version_id, revision, currency, value_type, amount,
      payment_terms, start_date, end_date, auto_renewal, renewal_months, notice_amount, notice_unit, non_working_day_rule, source_ref, change_reason, entered_by, limit_basis, payment_days, fx_difference)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
    [ctx.tenantId, cv.company_id, cvId, revision, body.currency, body.valueType, body.amount, body.paymentTerms, body.startDate, body.endDate,
      body.autoRenewal, body.renewalMonths, body.noticeAmount, body.noticeUnit, body.nonWorkingDay, body.sourceRef.trim(), body.changeReason?.trim() || null, ctx.userId, body.limitBasis,
      body.paymentDays ?? null, body.fxDifference ?? null])).rows[0]!;
  const diff = termsDiff(prev ? toTerms(prev) : null, body);
  // Önceki revizyonun bekleyen uyarıları geçersiz: yeni revizyon doğrulanınca yeniden planlanır.
  await closeTasks(tx, `notice:${cv.family_id}:`);
  await closeTasks(tx, `terms-verify:${cvId}`);
  await openTask(tx, ctx, {
    companyId: cv.company_id, kind: 'contract_terms_verify', entityType: 'contract_version', entityId: cvId,
    title: `Koşulları doğrula: ${cv.title}`, reason: prev ? `Revizyon ${revision}: ${diff.map((d) => d.label).join(', ') || 'değişiklik'} — ${body.changeReason}` : 'Bedel, süre ve ihbar kuralı girildi; hukuk doğrulaması olmadan uyarılar planlanmaz.',
    nextAction: 'Değerleri kaynak maddeyle karşılaştırıp doğrulayın.', assigneeRole: 'LEGAL', dedupeKey: `terms-verify:${cvId}:${revision}`,
  });
  await audit(tx, ctx, prev ? 'contract.terms_revised' : 'contract.terms_entered', 'contract_version', cvId, { revision, diff }, body.changeReason ?? undefined);
  return { id: r.id, revision, diff };
}

/** Hukuk doğrulaması: giren kişi doğrulayamaz; yalnız en son revizyon. Doğrulanınca ihbar uyarıları planlanır. */
export async function verifyTerms(tx: Tx, ctx: TenantContext, termsId: string) {
  const t = (await tx.query<TermsRow>(`SELECT ${TERMS_COLS} FROM contract_terms t WHERE t.id = $1 FOR UPDATE`, [termsId])).rows[0];
  if (!t) throw notFound();
  if (t.verified_by) throw conflict('already_verified', 'Bu revizyon zaten doğrulandı.');
  if (t.entered_by === ctx.userId) throw new ApiError(403, 'segregation_of_duties', 'Koşulları giren kişi doğrulayamaz (görev ayrılığı).');
  const latest = (await tx.query<{ id: string }>(`SELECT id FROM contract_terms WHERE contract_version_id = $1 ORDER BY revision DESC LIMIT 1`, [t.contract_version_id])).rows[0]!;
  if (latest.id !== t.id) throw conflict('terms_superseded', 'Bu revizyonun yerine yenisi girildi; güncel revizyonu doğrulayın.');
  // Doğrulama anında yeniden: kayıttan sonra oransız sipariş açılmış olabilir.
  if (t.limit_basis === 'GROSS' && t.value_type === 'CEILING') await assertRatedOpenLines(tx, t.contract_version_id);
  await tx.query(`UPDATE contract_terms SET verified_by = $2, verified_at = now() WHERE id = $1`, [termsId, ctx.userId]);
  await closeTasks(tx, `terms-verify:${t.contract_version_id}`);
  const scheduled = await scheduleNotice(tx, ctx, t);
  await audit(tx, ctx, 'contract.terms_verified', 'contract_version', t.contract_version_id, { termsId, revision: t.revision, reminders: scheduled });
  return { verified: true, reminders: scheduled };
}

async function scheduleNotice(tx: Tx, ctx: TenantContext, t: TermsRow) {
  if (t.notice_amount === null || !t.end_date) return [];
  const nd = noticeDeadline(t.end_date, { amount: t.notice_amount, unit: t.notice_unit!, nonWorkingDay: t.non_working_day_rule }, await holidays(tx));
  const out: { offset: number; runAt: string }[] = [];
  for (const s of reminderSchedule(nd.deadline, today())) {
    if (nd.deadline < today() && s.offset !== 30) continue; // son gün geçmişse yalnız en yüksek seviye uyarı
    const runAt = s.due ? new Date() : new Date(`${s.date}T06:00:00+03:00`);
    await tx.query(`INSERT INTO jobs (tenant_id, company_id, kind, idempotency_key, payload, requested_by, run_after)
      VALUES ($1,$2,'contract.notice_reminder',$3,$4,$5,$6) ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING`,
      [ctx.tenantId, t.company_id, `notice:${t.id}:${s.offset}`, { termsId: t.id, offset: s.offset, deadline: nd.deadline }, ctx.userId, runAt]);
    out.push({ offset: s.offset, runAt: runAt.toISOString() });
  }
  return out;
}

/** Worker: ihbar uyarısı. Koşul değiştiyse, sürüm geçersizse veya karar verildiyse iş sessizce eskir. */
export async function processNoticeReminder(tx: Tx, ctx: TenantContext, jobId: string) {
  const j = (await tx.query<{ payload: { termsId: string; offset: number; deadline: string } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0];
  if (!j) throw notFound();
  const { termsId, offset } = j.payload;
  const t = (await tx.query<TermsRow>(`SELECT ${TERMS_COLS} FROM contract_terms t WHERE t.id = $1`, [termsId])).rows[0];
  const finish = (result: Record<string, unknown>) => tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, result]);
  if (!t) return finish({ skipped: 'terms_not_visible' });
  const cv = await loadCv(tx, t.contract_version_id);
  const latest = await latestTerms(tx, t.contract_version_id);
  const decided = (await tx.query(`SELECT 1 FROM renewal_decisions WHERE terms_id = $1`, [termsId])).rowCount;
  if (cv.superseded_by_id || latest?.id !== termsId || !t.verified_by || decided) return finish({ skipped: 'obsolete' });
  // Son gün çalışma anında yeniden hesaplanır: tatil listesi sonradan güncellenmiş olabilir.
  const nd = noticeDeadline(t.end_date!, { amount: t.notice_amount!, unit: t.notice_unit!, nonWorkingDay: t.non_working_day_rule }, await holidays(tx));
  // Birden çok worker veya sırasız işlenen uyarılar: aynı sözleşme ailesi için seri işlenir ve daha acil uyarı geri alınmaz.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`notice:${cv.family_id}`]);
  const open = (await tx.query<{ dedupe_key: string }>(`SELECT dedupe_key FROM tasks WHERE status = 'OPEN' AND dedupe_key LIKE $1`, [`notice:${cv.family_id}:${nd.deadline}:%`])).rows;
  if (open.some((r) => Number(r.dedupe_key.split(':').pop()) < offset)) return finish({ skipped: 'more_urgent_reminder_open', deadline: nd.deadline, offset });
  await closeTasks(tx, `notice:${cv.family_id}:`);
  const left = Math.round((Date.parse(nd.deadline) - Date.parse(today())) / 86_400_000);
  const level = Math.min(offset, Math.max(left, 0));
  await openTask(tx, ctx, {
    companyId: cv.company_id, kind: 'contract_notice', entityType: 'contract_version', entityId: cv.id,
    title: `İhbar son günü ${trDate(nd.deadline)}: ${cv.title}`,
    reason: `${left >= 0 ? `${left} gün kaldı` : `${-left} gün geçti`}. Bitiş ${trDate(t.end_date!)}; ${nd.explanation} Kaynak: ${t.source_ref}.`,
    nextAction: 'Performans ve risk durumuna bakarak yenileme, fesih veya yeniden müzakere kararını ihbar son gününden önce kaydedin.',
    assigneeRole: 'PROCUREMENT_MANAGER', severity: level <= 30 ? 'CRITICAL' : level <= 60 ? 'HIGH' : 'NORMAL',
    dueAt: new Date(`${nd.deadline}T23:59:59+03:00`), dedupeKey: `notice:${cv.family_id}:${nd.deadline}:${offset}`,
  });
  return finish({ deadline: nd.deadline, offset });
}

export async function decideRenewal(tx: Tx, ctx: TenantContext, cvId: string, body: { decision: 'RENEW' | 'TERMINATE' | 'RENEGOTIATE'; rationale: string }) {
  const cv = await loadCv(tx, cvId);
  const t = await latestTerms(tx, cvId);
  if (!t || !t.verified_by) throw conflict('terms_not_verified', 'Yenileme kararı hukukça doğrulanmış koşullara bağlanır.');
  if (body.rationale.trim().length < 10) throw unprocessable('rationale_required', 'Karar gerekçesi gerekli (en az 10 karakter).');
  const d = (await tx.query<{ id: string }>(`INSERT INTO renewal_decisions (tenant_id, company_id, contract_version_id, terms_id, decision, rationale, decided_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.tenantId, cv.company_id, cvId, t.id, body.decision, body.rationale.trim(), ctx.userId])).rows[0]!;
  await closeTasks(tx, `notice:${cv.family_id}:`);
  if (body.decision === 'TERMINATE') {
    // Sözleşmenin bitmesi veri, erişim ve borç ilişkisini kendiliğinden kapatmaz (02 §11).
    const exit: [string, string, string][] = [
      ['data', 'Veri iadesi veya silme teyidi alın', 'SECURITY'], ['access', 'Tedarikçi hesap ve erişimlerini kapatın', 'SECURITY'],
      ['guarantee', 'Teminat iadesi ve garanti sürelerini kontrol edin', 'FINANCE'], ['invoices', 'Açık fatura ve kalan yükümlülükleri kapatın', 'FINANCE'],
    ];
    for (const [k, title, role] of exit) {
      await openTask(tx, ctx, { companyId: cv.company_id, kind: 'contract_exit', entityType: 'contract_version', entityId: cvId, title: `${title}: ${cv.title}`,
        reason: `Fesih kararı verildi${t.end_date ? `; bitiş ${trDate(t.end_date)}` : ''}. Çıkış kontrolü tamamlanmadan sözleşme kapanmış sayılmaz.`,
        nextAction: 'Kanıtıyla tamamlayın.', assigneeRole: role, dueAt: t.end_date ? new Date(`${t.end_date}T23:59:59+03:00`) : null, dedupeKey: `exit:${cvId}:${k}` });
    }
  } else {
    await openTask(tx, ctx, { companyId: cv.company_id, kind: 'contract_renewal', entityType: 'contract_version', entityId: cvId,
      title: `${body.decision === 'RENEW' ? 'Yenileme' : 'Yeniden müzakere'}: ${cv.title}`, reason: body.rationale.trim(),
      nextAction: 'Yeni satınalma projesi veya zeyilname başlatın; yeni koşullar yeniden onaylanır.', assigneeRole: 'BUYER', dedupeKey: `renewal:${cvId}` });
  }
  await audit(tx, ctx, 'contract.renewal_decided', 'contract_version', cvId, { decision: body.decision, termsId: t.id }, body.rationale);
  return { id: d.id, decision: body.decision };
}

// --- Yükümlülükler ----------------------------------------------------------------------------

export interface ObligationInput { title: string; counterparty: 'BUYER' | 'SUPPLIER'; ownerRole: string | null; firstDue: string; recurrence: Recurrence; until: string | null; evidenceRequired: boolean; sourceRef: string }

export async function addObligation(tx: Tx, ctx: TenantContext, cvId: string, b: ObligationInput) {
  const cv = await loadCv(tx, cvId);
  if (cv.superseded_by_id) throw conflict('version_superseded', 'Yükümlülükler güncel sözleşme sürümüne eklenir.');
  if (b.ownerRole && !(ROLES as readonly string[]).includes(b.ownerRole)) throw unprocessable('invalid_role', 'Geçersiz sorumlu rol.');
  if (b.until && b.until < b.firstDue) throw unprocessable('invalid_until', 'Bitiş ilk tarihten önce olamaz.');
  const o = (await tx.query<{ id: string }>(`INSERT INTO contract_obligations (tenant_id, company_id, contract_version_id, title, counterparty, owner_role,
      first_due, recurrence, until, evidence_required, source_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [ctx.tenantId, cv.company_id, cvId, b.title.trim(), b.counterparty, b.ownerRole, b.firstDue, b.recurrence, b.until, b.evidenceRequired, b.sourceRef.trim(), ctx.userId])).rows[0]!;
  await scheduleObligation(tx, ctx, o.id, cv.company_id);
  await audit(tx, ctx, 'contract.obligation_added', 'contract_obligation', o.id, { contractVersionId: cvId, recurrence: b.recurrence });
  return { id: o.id };
}

/** Sıradaki açık dönem için iş: son tarihten 14 gün önce görev açılır (geçmişse hemen). */
async function scheduleObligation(tx: Tx, ctx: TenantContext, obligationId: string, companyId: string) {
  const o = (await tx.query<{ first_due: string; recurrence: Recurrence; until: string | null; retired_at: Date | null }>(
    `SELECT first_due::text, recurrence, until::text, retired_at FROM contract_obligations WHERE id = $1`, [obligationId])).rows[0]!;
  if (o.retired_at) return null;
  const done = new Set((await tx.query<{ due_date: string }>(`SELECT due_date::text FROM obligation_events WHERE obligation_id = $1`, [obligationId])).rows.map((r) => r.due_date));
  const next = occurrences(o.first_due, o.recurrence, '0000-01-01', addDays(today(), 3650), o.until).find((d) => !done.has(d));
  if (!next) return null;
  const runAt = addDays(next, -14) <= today() ? new Date() : new Date(`${addDays(next, -14)}T06:00:00+03:00`);
  await tx.query(`INSERT INTO jobs (tenant_id, company_id, kind, idempotency_key, payload, requested_by, run_after)
    VALUES ($1,$2,'contract.obligation_due',$3,$4,$5,$6) ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING`,
    [ctx.tenantId, companyId, `obl:${obligationId}:${next}`, { obligationId, dueDate: next }, ctx.userId, runAt]);
  return next;
}

export async function processObligationDue(tx: Tx, ctx: TenantContext, jobId: string) {
  const j = (await tx.query<{ payload: { obligationId: string; dueDate: string } }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId])).rows[0]!;
  const finish = (result: Record<string, unknown>) => tx.query(`UPDATE jobs SET status = 'SUCCEEDED', result = $2, updated_at = now() WHERE id = $1`, [jobId, result]);
  const o = (await tx.query<{ id: string; title: string; owner_role: string | null; retired_at: Date | null; contract_version_id: string; company_id: string; source_ref: string }>(
    `SELECT id, title, owner_role, retired_at, contract_version_id, company_id, source_ref FROM contract_obligations WHERE id = $1`, [j.payload.obligationId])).rows[0];
  if (!o || o.retired_at) return finish({ skipped: 'obsolete' });
  if ((await tx.query(`SELECT 1 FROM obligation_events WHERE obligation_id = $1 AND due_date = $2`, [o.id, j.payload.dueDate])).rowCount) return finish({ skipped: 'recorded' });
  const cv = await loadCv(tx, o.contract_version_id);
  await openTask(tx, ctx, {
    companyId: o.company_id, kind: 'contract_obligation', entityType: 'contract_version', entityId: cv.id,
    title: `Yükümlülük ${trDate(j.payload.dueDate)}: ${o.title}`,
    reason: `${cv.title} · ${o.source_ref}${o.owner_role ? '' : ' · Sahipsiz yükümlülük: satınalma yöneticisine düştü.'}`,
    nextAction: 'Yerine getirildiyse kanıtıyla kaydedin; getirilmediyse kaçırıldı olarak işaretleyin.',
    assigneeRole: o.owner_role ?? 'PROCUREMENT_MANAGER', dueAt: new Date(`${j.payload.dueDate}T23:59:59+03:00`), dedupeKey: `obl:${o.id}:${j.payload.dueDate}`,
  });
  return finish({ dueDate: j.payload.dueDate });
}

export async function recordObligation(tx: Tx, ctx: TenantContext, obligationId: string, b: { dueDate: string; outcome: 'FULFILLED' | 'MISSED' | 'WAIVED'; note: string; evidence?: string | null }) {
  const o = (await tx.query<{ id: string; company_id: string; first_due: string; recurrence: Recurrence; until: string | null; evidence_required: boolean; retired_at: Date | null }>(
    `SELECT id, company_id, first_due::text, recurrence, until::text, evidence_required, retired_at FROM contract_obligations WHERE id = $1`, [obligationId])).rows[0];
  if (!o) throw notFound();
  if (!occurrences(o.first_due, o.recurrence, b.dueDate, b.dueDate, o.until).includes(b.dueDate)) throw unprocessable('invalid_period', 'Bu tarih yükümlülüğün bir dönemi değil.');
  if (b.outcome === 'FULFILLED' && o.evidence_required && (b.evidence ?? '').trim().length < 5) throw unprocessable('evidence_required', 'Bu yükümlülük kanıtla kapatılır (belge no, rapor adı veya bağlantı).');
  if (b.note.trim().length < 5) throw unprocessable('note_required', 'Açıklama gerekli.');
  await tx.query(`INSERT INTO obligation_events (tenant_id, company_id, obligation_id, due_date, outcome, note, evidence, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.tenantId, o.company_id, o.id, b.dueDate, b.outcome, b.note.trim(), b.evidence?.trim() || null, ctx.userId]);
  await closeTasks(tx, `obl:${o.id}:${b.dueDate}`);
  const next = await scheduleObligation(tx, ctx, o.id, o.company_id);
  await audit(tx, ctx, 'contract.obligation_recorded', 'contract_obligation', o.id, { dueDate: b.dueDate, outcome: b.outcome });
  return { next };
}

export async function retireObligation(tx: Tx, ctx: TenantContext, obligationId: string, reason: string) {
  if (reason.trim().length < 10) throw unprocessable('reason_required', 'Kaldırma gerekçesi gerekli.');
  const r = await tx.query(`UPDATE contract_obligations SET retired_at = now(), retired_reason = $2 WHERE id = $1 AND retired_at IS NULL RETURNING id`, [obligationId, reason.trim()]);
  if (!r.rowCount) throw conflict('already_retired', 'Yükümlülük bulunamadı veya zaten kaldırıldı.');
  await closeTasks(tx, `obl:${obligationId}:`);
  await audit(tx, ctx, 'contract.obligation_retired', 'contract_obligation', obligationId, {}, reason);
  return { ok: true };
}

// --- Okuma (UX09) -----------------------------------------------------------------------------

export async function getLifecycle(tx: Tx, ctx: TenantContext, cvId: string) {
  const cv = await loadCv(tx, cvId);
  const t = await latestTerms(tx, cvId);
  // Fark: aynı sürümün önceki revizyonu, yoksa ailenin önceki sürümünün son koşulu (zeyilname).
  let prev = t ? (await tx.query<TermsRow>(`SELECT ${TERMS_COLS} FROM contract_terms t WHERE t.contract_version_id = $1 AND t.revision = $2`, [cvId, t.revision - 1])).rows[0] ?? null : null;
  if (!prev && t) prev = (await tx.query<TermsRow>(`SELECT ${TERMS_COLS} FROM contract_terms t JOIN contract_versions cv ON cv.id = t.contract_version_id
      WHERE cv.family_id = $1 AND cv.version_no < $2 ORDER BY cv.version_no DESC, t.revision DESC LIMIT 1`, [cv.family_id, cv.version_no])).rows[0] ?? null;
  const h = await holidays(tx);
  const nd = t && t.notice_amount !== null && t.end_date
    ? noticeDeadline(t.end_date, { amount: t.notice_amount, unit: t.notice_unit!, nonWorkingDay: t.non_working_day_rule }, h) : null;
  const decision = t ? (await tx.query(`SELECT d.decision, d.rationale, d.decided_at AS "decidedAt", u.display_name AS "decidedBy"
      FROM renewal_decisions d JOIN users u ON u.id = d.decided_by WHERE d.terms_id = $1`, [t.id])).rows[0] ?? null : null;
  const obligations = (await tx.query<{ id: string; title: string; counterparty: string; owner_role: string | null; first_due: string; recurrence: Recurrence; until: string | null;
      evidence_required: boolean; source_ref: string; retired_at: Date | null; retired_reason: string | null }>(
    `SELECT id, title, counterparty, owner_role, first_due::text, recurrence, until::text, evidence_required, source_ref, retired_at, retired_reason
     FROM contract_obligations WHERE contract_version_id = $1 ORDER BY created_at`, [cvId])).rows;
  const from = addDays(today(), -120), to = addDays(today(), 365);
  const items = [];
  for (const o of obligations) {
    const ev = (await tx.query<{ due_date: string; outcome: string; note: string; evidence: string | null; recorded_at: Date; name: string }>(
      `SELECT e.due_date::text, e.outcome, e.note, e.evidence, e.recorded_at, u.display_name AS name FROM obligation_events e JOIN users u ON u.id = e.recorded_by
       WHERE e.obligation_id = $1 ORDER BY e.due_date`, [o.id])).rows;
    const dates = new Set([...occurrences(o.first_due, o.recurrence, from, to, o.until, 60), ...ev.map((e) => e.due_date)]);
    items.push({
      id: o.id, title: o.title, counterparty: o.counterparty, ownerRole: o.owner_role, recurrence: o.recurrence, until: o.until, firstDue: o.first_due,
      evidenceRequired: o.evidence_required, sourceRef: o.source_ref, retired: !!o.retired_at, retiredReason: o.retired_reason,
      periods: [...dates].sort().map((d) => {
        const e = ev.find((x) => x.due_date === d);
        // Dönem durumu türetilir: kayıt yoksa son tarihe göre yaklaşan/gecikmiş.
        return { dueDate: d, state: e ? e.outcome : d < today() ? 'OVERDUE' : 'UPCOMING', note: e?.note ?? null, evidence: e?.evidence ?? null, recordedBy: e?.name ?? null, recordedAt: e?.recorded_at ?? null };
      }),
    });
  }
  return {
    contract: { id: cv.id, title: cv.title, versionNo: cv.version_no, superseded: !!cv.superseded_by_id },
    terms: t && { id: t.id, revision: t.revision, ...toTerms(t), changeReason: t.change_reason, enteredBy: t.entered_by_name, enteredAt: t.entered_at,
      enteredByMe: t.entered_by === ctx.userId, verifiedBy: t.verified_by_name, verifiedAt: t.verified_at },
    diff: t ? termsDiff(prev ? toTerms(prev) : null, toTerms(t)) : [],
    notice: nd && { ...nd, reminders: reminderSchedule(nd.deadline, today()), daysLeft: Math.round((Date.parse(nd.deadline) - Date.parse(today())) / 86_400_000) },
    holidaysConfigured: h.length, decision, obligations: items,
  };
}
