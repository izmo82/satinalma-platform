import { createHash } from 'node:crypto';
import {
  cmp, COMPLIANCE_CHECKS, dec, mul, add, str, supplierStage, trAmount,
  type CheckKey, type ComplianceRule, type ProjectMethod, type RuleResult, type SupplierStatus,
} from '@sp/domain';
import type { TenantContext, Tx } from '../db.ts';
import { listInfo } from './contractIntake.ts';
import { familyUsage } from './invoiceMatching.ts';
import { coiSummary } from './projectCompletion.ts';
import { currentRisk } from './riskAssessments.ts';
import { PROMPT_VERSIONS } from '../ai/prompts.ts';
import { isTestProvider, TEST_PROVIDER_LABEL } from '../ai/testProvider.ts';

/**
 * v2 Faz 7 (D112) Görev 6: uyum denetiminin kontrolleri (R7–R9). Her DATA anahtarı deterministik bir SQL + kod kontrolüdür; sonuç,
 * bulgu (Türkçe) ve kanıt (kayıt kimlikleri) döner. Karşılaştırma günü projenin tamamlanma günüdür (bugün değil): aynı veriyle ikinci
 * koşu aynı sonucu verir. Faz 4 `contract_reviews` ya da Faz 6 `risk_assessments` tablosu yoksa ya da kayıt yoksa ilgili kural NO_DATA.
 * Kanıt kuralında model yalnız belgenin kuralı karşılayıp karşılamadığını alıntıyla önerir; alıntı belge metninde birebir bulunmazsa
 * (Faz 4 `checkEvidenceOutput`, kod) öneri sayılmaz. Puan ve hüküm `compliance.ts`'te kodla hesaplanır.
 */

export interface CheckOutcome { result: RuleResult; finding: string; evidence: Record<string, unknown>[] }
export const NO_PHASE_DATA = 'Veri yok (Faz 4/6 kaydı bulunamadı)';

export interface AuditContract {
  familyId: string; code: string; title: string; status: string; statusLabel: string; signedOn: string | null; amount: string | null;
  currency: string | null; valueType: string | null; legacy: boolean; approvedChain: boolean;
}
export interface AuditProject {
  id: string; code: string; title: string; companyId: string; departmentId: string | null; currency: string; budget: string | null;
  ownerUserId: string; completedOn: string; method: ProjectMethod; amount: string | null;
  award: { id: string; versionNo: number; total: string; rationale: string; decidedAt: string | null; decidedOn: string | null; evaluationId: string } | null;
  winners: { supplierId: string; name: string; status: string; bidIds: string[] }[];
  /** Kapsamdaki sözleşmeler: projeye bağlı, taslak/eksik/ret dışındakiler (onayda olanlar dahil). */
  contracts: AuditContract[];
}

const CONCLUDED = new Set(['APPROVED', 'EXPIRED', 'LEGACY']);
const OUT_OF_SCOPE = new Set(['DRAFT', 'INCOMPLETE', 'REJECTED']);

/** Denetimin proje gerçekleri (yöntem R7, tutar = onaylı kazanan toplamı ya da bütçe, kazananlar, sözleşmeler). */
export async function loadAuditProject(tx: Tx, projectId: string): Promise<AuditProject | null> {
  const p = (await tx.query<{ id: string; code: string; title: string; company_id: string; department_id: string | null; currency: string; budget: string | null;
      owner_user_id: string; completed_on: string | null }>(
    `SELECT id, code, title, company_id, department_id, currency, budget::text AS budget, owner_user_id, completed_on::text AS completed_on
     FROM projects WHERE id = $1`, [projectId])).rows[0];
  if (!p || !p.completed_on) return null;
  // R7: `projects.procurement_method` yok (bu sürümde); yöntem onaylı/kullanılmış tek kaynak istisnasından türetilir.
  const single = (await tx.query(`SELECT 1 FROM sourcing_exceptions WHERE project_id = $1 AND kind = 'SINGLE_SOURCE' AND status IN ('APPROVED','USED') LIMIT 1`,
    [projectId])).rowCount;
  const a = (await tx.query<{ id: string; version_no: number; total: string; rationale: string; decided_at: Date | null; decided_on: string | null; evaluation_id: string }>(
    `SELECT id, version_no, total::text AS total, rationale, decided_at, (decided_at AT TIME ZONE 'Europe/Istanbul')::date::text AS decided_on, evaluation_id
     FROM awards WHERE project_id = $1 AND status = 'APPROVED' ORDER BY version_no DESC LIMIT 1`, [projectId])).rows[0] ?? null;
  const winners = a ? (await tx.query<{ supplier_id: string; name: string; status: string; bid_ids: string[] }>(
    `SELECT l.supplier_id, s.legal_name AS name, s.status, array_agg(DISTINCT l.bid_id::text ORDER BY l.bid_id::text) AS bid_ids
     FROM award_lines l JOIN suppliers s ON s.id = l.supplier_id WHERE l.award_id = $1 GROUP BY l.supplier_id, s.legal_name, s.status ORDER BY s.legal_name, l.supplier_id`,
    [a.id])).rows : [];
  const fams = (await tx.query<{ id: string; code: string; title: string; signed_on: string | null; intake_flow: boolean; amount: string | null; currency: string | null;
      value_type: string | null; approved_chain: boolean }>(
    `SELECT f.id, f.code, f.title, f.signed_on::text AS signed_on, f.intake_flow, t.amount::text AS amount, t.currency, t.value_type,
       EXISTS (SELECT 1 FROM contract_approval_chains c WHERE c.family_id = f.id AND c.outcome = 'APPROVED') AS approved_chain
     FROM contract_families f
     LEFT JOIN LATERAL (SELECT v.id FROM contract_versions v WHERE v.family_id = f.id AND v.superseded_by_id IS NULL ORDER BY v.version_no DESC LIMIT 1) cv ON true
     LEFT JOIN LATERAL (SELECT x.* FROM contract_terms x WHERE x.contract_version_id = cv.id ORDER BY x.revision DESC LIMIT 1) t ON true
     WHERE f.project_id = $1 ORDER BY f.code, f.id`, [projectId])).rows;
  const info = await listInfo(tx, fams.map((f) => f.id));
  const contracts = fams.map((f): AuditContract => {
    const s = info.get(f.id);
    return { familyId: f.id, code: f.code, title: f.title, status: s?.status ?? 'INCOMPLETE', statusLabel: s?.statusLabel ?? 'Eksik alan', signedOn: f.signed_on,
      amount: f.value_type === 'UNPRICED' ? null : f.amount, currency: f.currency, valueType: f.value_type, legacy: !f.intake_flow && !f.approved_chain && s?.status === 'LEGACY',
      approvedChain: f.approved_chain };
  }).filter((c) => !OUT_OF_SCOPE.has(c.status));
  return {
    id: p.id, code: p.code, title: p.title, companyId: p.company_id, departmentId: p.department_id, currency: p.currency, budget: p.budget,
    ownerUserId: p.owner_user_id, completedOn: p.completed_on, method: single ? 'SINGLE_SOURCE' : 'INVITED_BIDS',
    amount: a?.total ?? p.budget ?? null,
    award: a ? { id: a.id, versionNo: a.version_no, total: a.total, rationale: a.rationale, decidedAt: a.decided_at ? a.decided_at.toISOString() : null, decidedOn: a.decided_on,
      evaluationId: a.evaluation_id } : null,
    winners: winners.map((w) => ({ supplierId: w.supplier_id, name: w.name, status: w.status, bidIds: w.bid_ids })),
    contracts,
  };
}

const outcome = (result: RuleResult, finding: string, evidence: Record<string, unknown>[] = []): CheckOutcome => ({ result, finding, evidence });
/** Birden çok öğenin (kazanan, sözleşme) sonucu: biri karşılanmadıysa FAIL; değilse biri veri yoksa NO_DATA; hepsi karşılandıysa PASS. */
function combine(parts: { result: 'PASS' | 'FAIL' | 'NO_DATA'; text: string }[], evidence: Record<string, unknown>[]): CheckOutcome {
  const result: RuleResult = parts.some((x) => x.result === 'FAIL') ? 'FAIL' : parts.some((x) => x.result === 'NO_DATA') ? 'NO_DATA' : 'PASS';
  return outcome(result, parts.map((x) => x.text).join(' '), evidence);
}
const money = (v: string, cur: string) => `${trAmount(v)} ${cur}`;
const trDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
async function tableExists(tx: Tx, name: string) {
  return (await tx.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`])).rows[0]!.ok;
}
const NO_AWARD = 'Onaylı kazanan kararı yok.';
const NO_CONTRACT = 'Projeye bağlı kapsamda sözleşme yok.';

type Params = Record<string, number | string>;

/** DATA kural anahtarlarının kontrolleri (R7). `ctx` yalnız beyan özetinin okunması için (kimlik gösterimi). */
export async function runDataCheck(tx: Tx, key: CheckKey, params: Params, project: AuditProject, ctx?: TenantContext): Promise<CheckOutcome> {
  switch (key) {
    case 'MIN_BIDS': {
      const minBids = Number(params.minBids ?? COMPLIANCE_CHECKS.MIN_BIDS.defaultParams.minBids);
      const round = (await tx.query<{ id: string; round_no: number }>(
        `SELECT id, round_no FROM rfq_rounds WHERE project_id = $1 AND status = 'CLOSED' ORDER BY round_no DESC LIMIT 1`, [project.id])).rows[0];
      if (!round) return outcome('NO_DATA', 'Kapanmış teklif turu yok.');
      // Geçerli teklif: son kapanan turda tedarikçi başına SUBMITTED teklif.
      const bids = (await tx.query<{ supplier_id: string; name: string; bid_id: string; version_no: number }>(
        `SELECT DISTINCT ON (b.supplier_id) b.supplier_id, s.legal_name AS name, b.id AS bid_id, b.version_no
         FROM bids b JOIN suppliers s ON s.id = b.supplier_id WHERE b.round_id = $1 AND b.status = 'SUBMITTED'
         ORDER BY b.supplier_id, b.version_no DESC`, [round.id])).rows.sort((x, y) => x.name.localeCompare(y.name, 'tr') || x.supplier_id.localeCompare(y.supplier_id));
      const evidence = bids.map((b) => ({ type: 'bid', bidId: b.bid_id, supplierId: b.supplier_id, supplierName: b.name, versionNo: b.version_no, roundNo: round.round_no }));
      const text = `Son kapanan turda (Tur ${round.round_no}) ${bids.length} geçerli teklif var; en az ${minBids} gerekli.`;
      return outcome(bids.length >= minBids ? 'PASS' : 'FAIL', text, evidence);
    }
    case 'LOWEST_OR_JUSTIFIED': {
      if (!project.award) return outcome('NO_DATA', NO_AWARD);
      const ev = (await tx.query<{ snapshot: { comparison?: { bids?: { bidId: string; tco: string | null; supplierName: string }[] } } }>(
        `SELECT snapshot FROM evaluations WHERE id = $1`, [project.award.evaluationId])).rows[0];
      const priced = (ev?.snapshot?.comparison?.bids ?? []).filter((b) => b.tco !== null && b.tco !== undefined);
      const winnerBids = [...new Set(project.winners.flatMap((w) => w.bidIds))];
      const rationale = (project.award.rationale ?? '').trim();
      const evidence: Record<string, unknown>[] = [{ type: 'award', awardId: project.award.id, versionNo: project.award.versionNo, evaluationId: project.award.evaluationId }];
      if (priced.length) {
        const lowest = priced.reduce((a, b) => (cmp(dec(b.tco!), dec(a.tco!)) < 0 ? b : a));
        evidence.push({ type: 'lowestBid', bidId: lowest.bidId, supplierName: lowest.supplierName, tco: lowest.tco });
        const minTco = dec(lowest.tco!);
        const selected = winnerBids.length === 1 && priced.some((b) => b.bidId === winnerBids[0] && cmp(dec(b.tco!), minTco) === 0);
        if (selected) return outcome('PASS', `En düşük teklif (${lowest.supplierName}, ${money(lowest.tco!, project.currency)}) seçildi.`, evidence);
        if (rationale.length >= 10) return outcome('PASS', `En düşük teklif (${lowest.supplierName}) seçilmedi; onaylı kararda gerekçe var: «${rationale.slice(0, 500)}»`, evidence);
        return outcome('FAIL', `En düşük teklif (${lowest.supplierName}) seçilmedi ve onaylı kararda gerekçe yok.`, evidence);
      }
      if (rationale.length >= 10) return outcome('PASS', `Değerlendirmede karşılaştırılabilir toplam yok; onaylı kararda gerekçe var: «${rationale.slice(0, 500)}»`, evidence);
      return outcome('NO_DATA', 'Değerlendirme kaydında karşılaştırılabilir teklif toplamı yok ve kararda gerekçe yok.', evidence);
    }
    case 'WINNER_APPROVED': {
      if (!project.award || !project.winners.length) return outcome('NO_DATA', NO_AWARD);
      const parts = project.winners.map((w) => {
        const st = supplierStage(w.status as SupplierStatus);
        return { result: st?.code === 'APPROVED' ? 'PASS' as const : 'FAIL' as const, text: `${w.name}: ${st?.label ?? w.status}.` };
      });
      return combine(parts, project.winners.map((w) => ({ type: 'supplier', supplierId: w.supplierId, supplierName: w.name, status: w.status })));
    }
    case 'WINNER_RISK_CURRENT': case 'WINNER_RISK_LEVEL': {
      if (!(await tableExists(tx, 'risk_assessments')) || !(await tableExists(tx, 'risk_assessment_revisions'))) return outcome('NO_DATA', NO_PHASE_DATA);
      if (!project.award || !project.winners.length) return outcome('NO_DATA', NO_AWARD);
      const parts: { result: 'PASS' | 'FAIL' | 'NO_DATA'; text: string }[] = [];
      const evidence: Record<string, unknown>[] = [];
      for (const w of project.winners) {
        const r = await currentRisk(tx, w.supplierId, project.completedOn);
        if (!r) { parts.push({ result: 'NO_DATA', text: `${w.name}: ${NO_PHASE_DATA}.` }); continue; }
        evidence.push({ type: 'riskAssessment', supplierId: w.supplierId, supplierName: w.name, assessmentId: r.assessmentId, year: r.year, revisionNo: r.revisionNo, level: r.level });
        if (key === 'WINNER_RISK_LEVEL') {
          const maxLevel = Number(params.maxLevel ?? COMPLIANCE_CHECKS.WINNER_RISK_LEVEL.defaultParams.maxLevel);
          parts.push({ result: r.level <= maxLevel ? 'PASS' : 'FAIL', text: `${w.name}: risk seviyesi ${r.level} (izin verilen en yüksek ${maxLevel}).` });
        } else {
          const months = Number(params.maxAgeMonths ?? COMPLIANCE_CHECKS.WINNER_RISK_CURRENT.defaultParams.maxAgeMonths);
          const c = (await tx.query<{ day: string; limit_day: string }>(
            `SELECT ($1::timestamptz AT TIME ZONE 'Europe/Istanbul')::date::text AS day, ($2::date - make_interval(months => $3))::date::text AS limit_day`,
            [r.revisedAt, project.completedOn, months])).rows[0]!;
          parts.push({ result: c.day >= c.limit_day ? 'PASS' : 'FAIL',
            text: `${w.name}: son risk değerlendirmesi ${trDate(c.day)} (tamamlanma gününden en fazla ${months} ay önce olmalı).` });
        }
      }
      return combine(parts, evidence);
    }
    case 'CONTRACT_CHAIN_APPROVED': {
      if (!project.contracts.length) return outcome('NO_DATA', NO_CONTRACT);
      const parts = project.contracts.map((c) => {
        if ((c.status === 'APPROVED' || c.status === 'EXPIRED') && c.approvedChain) return { result: 'PASS' as const, text: `${c.code}: onay zinciri tamamlandı.` };
        if (c.status === 'LEGACY' || (c.status === 'EXPIRED' && !c.approvedChain)) return { result: 'NO_DATA' as const, text: `${c.code}: eski kayıt sözleşme; onay zinciri sistemde yok.` };
        return { result: 'FAIL' as const, text: `${c.code}: ${c.statusLabel}.` };
      });
      return combine(parts, project.contracts.map((c) => ({ type: 'contract', familyId: c.familyId, code: c.code, status: c.status })));
    }
    case 'CONTRACT_AFTER_AWARD': {
      if (!project.award?.decidedOn) return outcome('NO_DATA', NO_AWARD);
      const scoped = project.contracts.filter((c) => CONCLUDED.has(c.status));
      if (!scoped.length) return outcome('NO_DATA', NO_CONTRACT);
      const decided = project.award.decidedOn;
      const parts = scoped.map((c) => !c.signedOn
        ? { result: 'NO_DATA' as const, text: `${c.code}: imza tarihi girilmemiş.` }
        : { result: c.signedOn >= decided ? 'PASS' as const : 'FAIL' as const, text: `${c.code}: imza ${trDate(c.signedOn)}, kazanan kararı ${trDate(decided)}.` });
      return combine(parts, scoped.map((c) => ({ type: 'contract', familyId: c.familyId, code: c.code, signedOn: c.signedOn, awardDecidedOn: decided })));
    }
    case 'CONTRACT_AMOUNT_MATCHES_AWARD': {
      if (!project.award) return outcome('NO_DATA', NO_AWARD);
      const scoped = project.contracts.filter((c) => CONCLUDED.has(c.status));
      if (!scoped.length) return outcome('NO_DATA', NO_CONTRACT);
      if (scoped.some((c) => c.amount === null)) return outcome('NO_DATA', 'Sözleşme tutarı girilmemiş (ya da fiyatsız sözleşme).');
      const foreign = scoped.filter((c) => (c.currency ?? project.currency) !== project.currency);
      if (foreign.length) return outcome('NO_DATA', `Sözleşme para birimi (${foreign.map((c) => c.currency).join(', ')}) kazanan teklifin para biriminden (${project.currency}) farklı; kur çevrilmedi.`);
      const tol = String(params.tolerancePercent ?? COMPLIANCE_CHECKS.CONTRACT_AMOUNT_MATCHES_AWARD.defaultParams.tolerancePercent);
      const total = add(...scoped.map((c) => dec(c.amount!)));
      const limit = mul(dec(project.award.total), add(dec('1'), mul(dec(tol), dec('0.01'))));
      const text = `Sözleşme tutarı ${money(str(total), project.currency)}; kazanan toplamı ${money(project.award.total, project.currency)}, tolerans %${tol} (sınır ${money(str(limit), project.currency)}).`;
      return outcome(cmp(total, limit) <= 0 ? 'PASS' : 'FAIL', text,
        scoped.map((c) => ({ type: 'contract', familyId: c.familyId, code: c.code, amount: c.amount, currency: c.currency })));
    }
    case 'INVOICES_WITHIN_CONTRACT': {
      const scoped = project.contracts.filter((c) => CONCLUDED.has(c.status));
      if (!scoped.length) return outcome('NO_DATA', NO_CONTRACT);
      const usage = await familyUsage(tx, scoped.map((c) => c.familyId));
      const parts = scoped.map((c) => {
        const u = usage.get(c.familyId);
        if (!u || u.level === 'NO_AMOUNT') return { result: 'NO_DATA' as const, text: `${c.code}: sözleşme tutarı yok; kullanım hesaplanamadı.` };
        const fx = u.foreignCurrency.length ? ` ${u.foreignCurrency.map((x) => x.label).join(' ')}` : '';
        if (u.level === 'OVER') return { result: 'FAIL' as const, text: `${c.code}: faturalar ${money(u.used, u.currency)}, sözleşme ${money(u.amount!, u.currency)}; ${u.warning}.${fx}` };
        return { result: 'PASS' as const, text: `${c.code}: faturalar ${money(u.used, u.currency)}, sözleşme ${money(u.amount!, u.currency)}.${fx}` };
      });
      return combine(parts, scoped.map((c) => { const u = usage.get(c.familyId); return { type: 'usage', familyId: c.familyId, code: c.code, used: u?.used ?? null, amount: u?.amount ?? null, ratio: u?.ratio ?? null, level: u?.level ?? null }; }));
    }
    case 'TEMPLATE_SCORE_ABOVE': {
      if (!(await tableExists(tx, 'contract_reviews'))) return outcome('NO_DATA', NO_PHASE_DATA);
      const scoped = project.contracts.filter((c) => CONCLUDED.has(c.status));
      if (!scoped.length) return outcome('NO_DATA', NO_CONTRACT);
      const threshold = String(params.threshold ?? COMPLIANCE_CHECKS.TEMPLATE_SCORE_ABOVE.defaultParams.threshold);
      const reviews = new Map((await tx.query<{ family_id: string; id: string; score: number }>(
        `SELECT DISTINCT ON (family_id) family_id, id, score FROM contract_reviews WHERE family_id = ANY($1::uuid[]) ORDER BY family_id, created_at DESC, id DESC`,
        [scoped.map((c) => c.familyId)])).rows.map((r) => [r.family_id, r]));
      const parts = scoped.map((c) => {
        const r = reviews.get(c.familyId);
        if (!r) return { result: 'NO_DATA' as const, text: `${c.code}: ${NO_PHASE_DATA}.` };
        return { result: cmp(dec(String(r.score)), dec(threshold)) >= 0 ? 'PASS' as const : 'FAIL' as const, text: `${c.code}: şablon uygunluk puanı ${r.score} (eşik ${threshold}).` };
      });
      return combine(parts, scoped.flatMap((c) => { const r = reviews.get(c.familyId); return r ? [{ type: 'contractReview', familyId: c.familyId, code: c.code, reviewId: r.id, score: r.score }] : []; }));
    }
    case 'COI_COMPLETE': {
      const s = await coiSummary(tx, ctx ?? { userId: '', tenantId: '', roles: [], companyIds: [], departmentIds: [], allDepartments: true, correlationId: '' }, project.id);
      const evidence = s.participants.map((p) => ({ type: 'coi', userId: p.userId, name: p.name, roles: p.roles, kind: p.latest?.kind ?? null, declarationId: p.latest?.id ?? null }));
      if (s.missing.length) {
        const more = s.conflicts.length ? ` Çıkar çatışması bildirenler: ${s.conflicts.map((c) => `${c.name ?? 'Bilinmeyen'} («${c.statement ?? ''}»)`).join('; ')}.` : '';
        return outcome('FAIL', `Beyan vermeyen katılımcılar: ${s.missing.map((m) => m.name ?? 'Bilinmeyen').join(', ')}.${more}`, evidence);
      }
      if (s.conflicts.length) return outcome('FAIL', `Çıkar çatışması bildirildi: ${s.conflicts.map((c) => `${c.name ?? 'Bilinmeyen'} («${c.statement ?? ''}»)`).join('; ')}.`, evidence);
      return outcome('PASS', `Tüm katılımcılar (${s.participants.length}) beyan verdi; çıkar çatışması bildirilmedi.`, evidence);
    }
    case 'WINNER_RESEARCH': case 'OWNERSHIP_RESEARCH':
      return outcome('NO_DATA', 'Bu kontrol kanıt kuralıdır; veri kontrolü olarak çalışmaz.');
  }
}

// --- Kanıt kuralı (EVIDENCE_AI, R8) -------------------------------------------------------------------------------------------

/** Kanıt sorularının sürümü: metin değişirse sürüm değişir (önbellek anahtarına girer). Sorular sabittir (tedarikçi adı vb. girmez). */
export const EVIDENCE_QUESTION_VERSION = 'uyum-kanit-2026-11-v1';
export const EVIDENCE_QUESTIONS: Record<'WINNER_RESEARCH' | 'OWNERSHIP_RESEARCH', { id: string; text: string }[]> = {
  WINNER_RESEARCH: [{ id: 'research', text: 'Kazanan firma araştırması yapılmış mı?' }],
  OWNERSHIP_RESEARCH: [{ id: 'ownership', text: 'Firmanın ortaklık ve sahiplik yapısı araştırılmış mı?' }],
};
export const evidencePurpose = (key: string) => `Uyum denetimi kanıt kuralı: ${key}`;
export const isEvidenceKey = (k: string | null): k is 'WINNER_RESEARCH' | 'OWNERSHIP_RESEARCH' => k === 'WINNER_RESEARCH' || k === 'OWNERSHIP_RESEARCH';

export interface EvidenceDoc { documentVersionId: string; sha256: string; mimeType: string; title: string | null; uploadedAt: string }
/** Kuralın kanıt belgeleri: projeye bu kuralın anahtarı ya da koduyla yüklenmiş, temel denetimden geçmiş, imha edilmemiş sürümler. */
export async function evidenceDocs(tx: Tx, projectId: string, rule: Pick<ComplianceRule, 'code' | 'checkKey'>): Promise<EvidenceDoc[]> {
  return (await tx.query<EvidenceDoc>(
    `SELECT DISTINCT ON (dv.id) dv.id AS "documentVersionId", dv.sha256, dv.mime_type AS "mimeType", d.title, x.created_at::text AS "uploadedAt"
     FROM compliance_evidence x JOIN document_versions dv ON dv.id = x.document_version_id JOIN documents d ON d.id = dv.document_id
     WHERE x.project_id = $1 AND x.check_key = ANY($2::text[]) AND dv.basic_check_status = 'PASSED'
       AND NOT EXISTS (SELECT 1 FROM document_disposals z WHERE z.document_id = dv.document_id)
     ORDER BY dv.id`, [projectId, [rule.checkKey, rule.code].filter(Boolean)])).rows
    .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt) || a.documentVersionId.localeCompare(b.documentVersionId));
}

/** Önbellek anahtarı: sha256(kural kodu | parametreler | belge sha256'ları | model | istem sürümü). */
export function evidenceCacheKey(rule: Pick<ComplianceRule, 'code' | 'params'>, docShas: string[], modelId: string): string {
  const params = JSON.stringify(Object.fromEntries(Object.entries(rule.params).sort(([a], [b]) => a.localeCompare(b))));
  return createHash('sha256').update([rule.code, params, [...docShas].sort().join(','), modelId, `${PROMPT_VERSIONS.AI15}+${EVIDENCE_QUESTION_VERSION}`].join('|')).digest('hex');
}

export interface ManualMark { id: string; ruleCode: string; result: 'PASS' | 'FAIL'; note: string; documentVersionId: string; markedBy: string; markedByName: string | null; markedAt: Date }
export async function latestMarks(tx: Tx, projectId: string): Promise<Map<string, ManualMark>> {
  return new Map((await tx.query<ManualMark>(
    `SELECT DISTINCT ON (m.rule_code) m.id, m.rule_code AS "ruleCode", m.result, m.note, m.document_version_id AS "documentVersionId", m.marked_by AS "markedBy",
       u.display_name AS "markedByName", m.marked_at AS "markedAt"
     FROM compliance_manual_marks m LEFT JOIN users u ON u.id = m.marked_by WHERE m.project_id = $1 ORDER BY m.rule_code, m.marked_at DESC, m.id DESC`, [projectId])).rows
    .map((m) => [m.ruleCode, m]));
}

export interface EvidenceContext {
  /** Sağlayıcı kurulu mu (işçide `hasAiProviders()`); değilse kural "Yapay zekâ bağlı değil" ve elle işaret bekler. */
  aiAvailable: boolean;
  modelId: string;
  marks: Map<string, ManualMark>;
}
/** Önbelleğe yazılan (ve rapora alınan) kanıt sonucu. Önbellek API'den hiç dışa verilmez. */
export interface CachedEvidence {
  satisfied: boolean | null; result: 'PASS' | 'FAIL' | 'NO_DATA'; quotes: { page: number; text: string; documentVersionId: string }[];
  explanation: string; provider: string | null; isTest: boolean; modelId: string | null; flags: string[];
}
export interface EvidenceOutcome extends CheckOutcome { method: 'AI' | 'MANUAL' | null; provider: string | null; isTest: boolean }

const NOT_VERIFIED = 'Kanıt doğrulanamadı: yapay zekâ önerisinin alıntısı belgede birebir bulunamadı ya da belge kuralı açıkça karşılamıyor.';

/** Belge başına en yeni (aynı soru kümesiyle) kanıt okuması; yoksa null. RLS belge görünürlüğü. */
async function readingFor(tx: Tx, documentVersionId: string, key: 'WINNER_RESEARCH' | 'OWNERSHIP_RESEARCH') {
  return (await tx.query<{ id: string; result: { answers: { questionId: string; answer: string; quote: string | null; page: number | null; explanation: string | null; flags: string[] }[] } | null;
      provider: string | null; response_model: string | null }>(
    `SELECT e.id, e.result, m.provider, r.response_model FROM ai_evidence_readings e JOIN ai_runs r ON r.id = e.ai_run_id LEFT JOIN ai_models m ON m.id = r.model_ref
     WHERE e.document_version_id = $1 AND e.purpose = $2 AND e.question_set = $3::jsonb AND r.prompt_version = $4
     ORDER BY e.created_at DESC, e.id DESC LIMIT 1`, [documentVersionId, evidencePurpose(key), JSON.stringify(EVIDENCE_QUESTIONS[key]), PROMPT_VERSIONS.AI15])).rows[0] ?? null;
}

/**
 * R8 kanıt kuralı. Sıra: elle işaret (son işaret geçerli) → kanıt yoksa NO_DATA → sağlayıcı yoksa PENDING "Yapay zekâ bağlı değil" →
 * önbellek (aynı belge/kural/model/istem → aynı sonuç) → belge okumaları (işçi önceden ister ve işler; alıntıları Faz 4 kodu doğrular).
 * Bütün sorular doğrulanmış alıntıyla YES → PASS; doğrulanmış NO → FAIL; aksi NO_DATA "kanıt doğrulanamadı". Okuma yoksa (tamamlanmadı)
 * NO_DATA ve önbelleğe yazılmaz (yeniden koşu yeniden dener).
 */
export async function runEvidenceCheck(tx: Tx, ctx: TenantContext, rule: ComplianceRule, project: AuditProject, ec: EvidenceContext): Promise<EvidenceOutcome> {
  const mark = ec.marks.get(rule.code);
  if (mark) {
    return { result: mark.result, method: 'MANUAL', provider: null, isTest: false,
      finding: `Elle işaretlendi (${mark.markedByName ?? 'Satınalma'}): ${mark.note}`,
      evidence: [{ type: 'manualMark', markId: mark.id, documentVersionId: mark.documentVersionId, markedBy: mark.markedBy, markedAt: mark.markedAt }] };
  }
  const docs = await evidenceDocs(tx, project.id, rule);
  const docEvidence = docs.map((d) => ({ type: 'document', documentVersionId: d.documentVersionId, title: d.title }));
  if (!docs.length) return { result: 'NO_DATA', method: null, provider: null, isTest: false, finding: 'Kanıt belgesi yüklenmemiş.', evidence: [] };
  if (!ec.aiAvailable || !isEvidenceKey(rule.checkKey)) {
    return { result: 'PENDING', method: null, provider: null, isTest: false, finding: 'Yapay zekâ bağlı değil; kanıt belgesine bakarak elle işaretleyin.', evidence: docEvidence };
  }
  const pdfs = docs.filter((d) => d.mimeType === 'application/pdf');
  if (!pdfs.length) return { result: 'PENDING', method: null, provider: null, isTest: false, finding: 'Kanıt belgesi yapay zekâyla okunamıyor (yalnız PDF okunur); elle işaretleyin.', evidence: docEvidence };
  const cacheKey = evidenceCacheKey(rule, pdfs.map((d) => d.sha256), ec.modelId);
  const hit = (await tx.query<{ output: CachedEvidence }>(`SELECT output FROM compliance_ai_cache WHERE cache_key = $1`, [cacheKey])).rows[0]?.output;
  const toOutcome = (c: CachedEvidence): EvidenceOutcome => ({
    result: c.result, method: 'AI', provider: c.provider, isTest: c.isTest,
    finding: `${c.isTest ? `${TEST_PROVIDER_LABEL}. ` : ''}${c.explanation}`,
    evidence: [...docEvidence, ...c.quotes.map((q) => ({ type: 'quote', documentVersionId: q.documentVersionId, page: q.page, text: q.text }))],
  });
  if (hit) return toOutcome(hit);
  const questions = EVIDENCE_QUESTIONS[rule.checkKey];
  const readings: { doc: EvidenceDoc; r: NonNullable<Awaited<ReturnType<typeof readingFor>>> }[] = [];
  for (const d of pdfs) {
    const r = await readingFor(tx, d.documentVersionId, rule.checkKey);
    if (r) readings.push({ doc: d, r });
  }
  if (readings.length < pdfs.length) {
    return { result: 'NO_DATA', method: 'AI', provider: null, isTest: false, finding: 'Kanıt belgesi yapay zekâyla okunamadı (okuma tamamlanmadı); yeniden koşun ya da elle işaretleyin.', evidence: docEvidence };
  }
  const quotes: CachedEvidence['quotes'] = [];
  const flags: string[] = [];
  const perQuestion = questions.map((q) => {
    let verdict: 'YES' | 'NO' | 'UNCLEAR' = 'UNCLEAR';
    for (const { doc, r } of readings) {
      const a = r.result?.answers.find((x) => x.questionId === q.id);
      for (const f of a?.flags ?? []) flags.push(`${q.id}:${f}`);
      // Doğrulanmış cevap: Faz 4 checkEvidenceOutput alıntıyı belge sayfa metninde birebir buldu (aksi UNCLEAR + bayrak).
      if (a && (a.answer === 'YES' || a.answer === 'NO') && a.quote && a.page) {
        quotes.push({ page: a.page, text: a.quote, documentVersionId: doc.documentVersionId });
        if (a.answer === 'YES') verdict = 'YES';
        else if (verdict !== 'YES') verdict = 'NO';
      }
    }
    return verdict;
  });
  const result: CachedEvidence['result'] = perQuestion.every((v) => v === 'YES') ? 'PASS' : perQuestion.some((v) => v === 'NO') ? 'FAIL' : 'NO_DATA';
  const provider = readings[0]!.r.provider;
  const cached: CachedEvidence = {
    satisfied: result === 'PASS' ? true : result === 'FAIL' ? false : null, result, quotes,
    explanation: result === 'PASS' ? 'Yapay zekâ önerisi: kanıt belgesi kuralı karşılıyor; alıntı belgede doğrulandı.'
      : result === 'FAIL' ? 'Yapay zekâ önerisi: kanıt belgesi kuralı karşılamıyor; alıntı belgede doğrulandı.' : NOT_VERIFIED,
    provider, isTest: isTestProvider(provider), modelId: readings[0]!.r.response_model, flags: [...new Set(flags)].sort(),
  };
  await tx.query(`INSERT INTO compliance_ai_cache (tenant_id, cache_key, output, provider) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, cache_key) DO NOTHING`,
    [ctx.tenantId, cacheKey, JSON.stringify(cached), provider ?? 'unknown']);
  // Eşzamanlı yazımda ilk kayıt geçerlidir (aynı anahtar aynı sonucu verir).
  const stored = (await tx.query<{ output: CachedEvidence }>(`SELECT output FROM compliance_ai_cache WHERE cache_key = $1`, [cacheKey])).rows[0]?.output ?? cached;
  return toOutcome(stored);
}
