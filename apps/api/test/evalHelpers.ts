// v2 Faz 1 (D93/D95): inceleyen güvenlik kullanıcısı bölüm kullanıcısıdır; değerlendirme onun departmanında (Bilgi Teknolojileri) açılır
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { makeHarness } from './harness.ts';

type H = Awaited<ReturnType<typeof makeHarness>>;
const lowFactors = { dataSensitivity: 'LOW', accessLevel: 'LOW', criticality: 'LOW', substitutability: 'LOW', subcontractorDependence: 'LOW' };

/** Güvenlik anketi şablonu (yayımlı): kritik "uzak erişimde MFA" + kanıtlı yedekleme + iki normal kontrol. */
export async function securityTemplate(h: H) {
  const t = await h.call('security', 'POST', '/api/v1/questionnaire-templates', { body: { code: `GUV-${randomUUID().slice(0, 6)}`, name: 'BT hizmeti güvenlik anketi (sentetik)', category: 'BT erişimli hizmet',
    questions: [
      { controlId: 'ERS-01', reference: 'ISO/IEC 27036-2 tedarikçi erişimi (eşleme uzman onayı bekliyor)', text: 'Uzak ve ayrıcalıklı erişimde MFA uygulanıyor mu?', critical: true, evidenceRequired: false },
      { controlId: 'YDK-01', reference: 'ISO/IEC 27002 yedekleme kontrolü', text: 'Yedekten geri dönüş yılda en az bir kez test ediliyor mu?', critical: false, evidenceRequired: false },
      { controlId: 'OLY-01', reference: 'Sözleşme olay bildirim maddesi', text: 'Olay bildirim süresi sözleşmede belirli mi?', critical: false, evidenceRequired: false },
      { controlId: 'VER-01', reference: 'KVKK veri işleme', text: 'Alt işleyen listesi paylaşıldı mı?', critical: false, evidenceRequired: false },
    ] } });
  expect(t.status).toBe(201);
  expect((await h.call('legal2', 'POST', `/api/v1/questionnaire-templates/${t.body.id}/publish`)).status).toBe(200);
  return t.body.id as string;
}

/** Değerlendirme: verilen yanıtlarla (varsayılan hepsi "evet"), inceleme ve tamamlama. Yanıtı satınalma girer, güvenlik inceler. */
export async function reviewedAssessment(h: H, supplierId: string, templateId: string, responses: Record<string, string> = {}, factors = lowFactors) {
  const a = await h.call('buyer', 'POST', '/api/v1/assessments', { body: { supplierId, templateId, scope: 'Uzak erişimli sunucu bakımı (sentetik)', inherentFactors: factors,
    departmentId: h.world.departments.bt } });
  expect(a.status).toBe(201);
  const d = (await h.call('buyer', 'GET', `/api/v1/assessments/${a.body.id}`)).body;
  for (const q of d.questions as { id: string; controlId: string }[]) {
    expect((await h.call('buyer', 'PUT', `/api/v1/assessments/${a.body.id}/answers/${q.id}`, { body: { response: responses[q.controlId] ?? 'YES' } })).status).toBe(200);
    expect((await h.call('security', 'POST', `/api/v1/assessments/${a.body.id}/answers/${q.id}/review`, { body: { review: 'ACCEPTED' } })).status).toBe(200);
  }
  expect((await h.call('security', 'POST', `/api/v1/assessments/${a.body.id}/complete`)).status).toBe(200);
  return a.body.id as string;
}
