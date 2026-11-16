import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { hasRole, useSession } from '../lib/session.tsx';
import { useResource } from '../lib/useApi.ts';
import { fmtDateTime } from '../lib/format.ts';
import { Empty, ErrorState, Field, Loading, PageHeader } from '../ui/kit.tsx';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ExportsTab } from './GovernancePages.tsx';

// v2 Faz 1 (D93, K-03): Yönetim > Denetim izi. Kayıt başına denetim olayları (GET /audit-events?entityId=, audit.read: Yönetici,
// Denetçi) ve kiracı dışa aktarımı (isteyen Yönetici, onaylayan başka bir Satınalma kullanıcısı, Denetçi okur).

interface AuditEvent { id: string; action: string; entityType: string; entityId: string; reason: string | null; at: string; actorName: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// İşlem kodu kullanıcıya gösterilmez: "<kayıt türü> · <ara nesne> <fiil>" Türkçe olarak kurulur.
const SUBJECT: Record<string, string> = {
  ai: 'Yapay zekâ', approval_policy: 'Onay politikası', assessment: 'Değerlendirme', award: 'Kazanan seçimi', bid: 'Teklif', contract: 'Sözleşme',
  department: 'Departman', disposal: 'İmha', document: 'Belge', einvoice: 'e-Fatura', erp: 'ERP', evaluation: 'Değerlendirme', fx_rate: 'Kur',
  incident: 'Olay', invoice: 'Fatura', legal_hold: 'Hukuki saklama', membership: 'Üyelik', performance: 'Performans', po: 'Sipariş', project: 'Proje',
  questionnaire: 'Anket şablonu', receipt: 'Kabul', recovery: 'Geri kazanım', report: 'Rapor', retention: 'Saklama', rfq: 'Teklif turu',
  savings: 'Tasarruf bazı', signature: 'İmza', sourcing: 'Kaynak istisnası', supplier: 'Tedarikçi', tenant: 'Kiracı', tolerance: 'Tolerans',
};
const OBJECT: Record<string, string> = {
  output: 'çıktı', policy: 'politika', price_revision: 'fiyat revizyonu', guarantee: 'teminat', sla: 'SLA', supplier_party: 'tedarikçi tarafı',
  version: 'sürüm', price_rule: 'fiyat kuralı', batch: 'aktarım paketi', export: 'dışa aktarım', reconciliation: 'mutabakat', departments: 'departmanlar',
  analysis: 'analiz', custody: 'fiziksel asıl', digital_validation: 'e-imza doğrulaması', exception: 'istisna', finalization: 'kesinleştirme',
  requirement: 'gereksinim', review: 'inceleme', bank_change: 'banka değişikliği', candidate: 'aday', identity: 'kimlik',
};
const VERB: Record<string, string> = {
  completed: 'tamamlandı', ignored: 'yok sayıldı', deleted: 'silindi', updated: 'güncellendi', routed: 'yönlendirildi', activated: 'etkinleştirildi',
  drafted: 'taslak kaydedildi', answered: 'yanıtlandı', created: 'oluşturuldu', residual_accepted: 'kalan risk kabul edildi', reviewed_answer: 'yanıt incelendi',
  sent_to_supplier: 'tedarikçiye gönderildi', submitted_by_supplier: 'tedarikçi gönderdi', proposed: 'önerildi', file_read: 'dosyası okundu',
  file_uploaded: 'dosyası yüklendi', scored: 'puanlandı', submitted: 'gönderildi', received: 'alındı', returned: 'iade edildi',
  obligation_added: 'yükümlülük eklendi', obligation_recorded: 'yükümlülük kaydedildi', obligation_retired: 'yükümlülük emekliye ayrıldı',
  approved: 'onaylandı', renewal_decided: 'yenileme kararı verildi', measured: 'ölçüldü', added: 'eklendi', terms_verified: 'koşullar doğrulandı',
  executed: 'uygulandı', rejected: 'reddedildi', checked: 'denetlendi', exported: 'dışa aktarıldı', replayed: 'yeniden gönderildi', applied: 'uygulandı',
  imported: 'içe alındı', action_added: 'faaliyet eklendi', action_done: 'faaliyet tamamlandı', action_verified: 'faaliyet doğrulandı',
  reported: 'bildirildi', allocated: 'tahsis edildi', duplicate_received: 'tekrar alındı', erp_status: 'ERP durumu güncellendi',
  exception_approved: 'istisna onaylandı', released: 'kaldırıldı', set: 'ayarlandı', reviewed: 'incelendi', weights_set: 'ağırlıklar ayarlandı',
  changed: 'değiştirildi', issued: 'verildi', criteria_revised: 'kriterler revize edildi', draft_updated: 'taslak güncellendi', fx_rate_added: 'kur eklendi',
  published: 'yayımlandı', recorded: 'kaydedildi', reversed: 'ters kaydedildi', claimed: 'talep edildi', confirmed: 'doğrulandı', dismissed: 'kapatıldı',
  recovered: 'tahsil edildi', scanned: 'tarandı', settings: 'ayarları değişti', viewed: 'görüntülendi', removed: 'kaldırıldı', closed_early: 'erken kapatıldı',
  publish_requested: 'yayın onayı istendi', question_answered: 'soru yanıtlandı', question_asked: 'soru soruldu', baseline_proposed: 'baz önerildi',
  requested: 'istendi', blocked: 'engellendi', expired: 'süresi doldu', reopened: 'yeniden açıldı', finalized: 'kesinleşti', defined: 'tanımlandı',
  identity_review: 'kimlik incelemesine alındı', resolved: 'çözüldü', merged: 'birleştirildi', resolve: 'eşleştirildi',
  own_company_blocked: 'kendi şirketi olduğu için engellendi', download: 'indirildi', failed: 'hata verdi', ready: 'hazırlandı',
};
export function actionLabel(code: string): string {
  const parts = code.split('.');
  const subject = SUBJECT[parts[0] ?? ''] ?? 'Kayıt';
  const object = parts.slice(1, -1).map((p) => OBJECT[p]).filter(Boolean).join(' ');
  const verb = parts.length > 1 ? VERB[parts[parts.length - 1]!] : undefined;
  return `${subject} · ${[object, verb ?? 'işlem kaydedildi'].filter(Boolean).join(' ')}`;
}

function AuditLookup() {
  const [params, setParams] = useSearchParams();
  const id = params.get('kayit') ?? '';
  const [input, setInput] = useState(id);
  const [invalid, setInvalid] = useState(false);
  const r = useResource<{ items: AuditEvent[] }>(UUID.test(id) ? `/api/v1/audit-events?entityId=${id}` : null);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Kayıt geçmişi</h2></div>
      <div className="panel-body grid gap-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
          e.preventDefault();
          const v = input.trim();
          if (!UUID.test(v)) { setInvalid(true); return; }
          setInvalid(false);
          const p = new URLSearchParams(params); p.set('kayit', v); setParams(p, { replace: true });
        }}>
          <Field label="Kayıt kimliği" hint="Kaydın adresindeki son bölüm; ör. bir sözleşmenin adresi /sozlesmeler/ ile başlar, ardından gelen kimlik buraya yazılır."
            error={invalid ? 'Kayıt kimliği 36 karakterlik biçimde olmalı.' : null}>
            {(p) => <input className="input mono min-w-[22rem] max-[640px]:min-w-0 max-[640px]:w-full" {...p} value={input} onChange={(e) => setInput(e.target.value)} />}
          </Field>
          <Button type="submit" className="mb-4">Göster</Button>
        </form>
        {!UUID.test(id) ? <p className="text-ink-muted">Bir kaydın kimliğini girin; o kayıtta yapılan her işlem kişi, zaman ve gerekçesiyle listelenir.</p>
          // K1: kimlik girildiği ilk çizimde istek henüz başlamamıştır; veri ya da hata gelene kadar yükleniyor gösterilir (boş durum değil).
          : (r.loading || (!r.data && !r.error)) ? <Loading rows={4} /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} />
          : !r.data?.items.length ? <Empty icon="search" title="Bu kayıt için denetim olayı yok">Kimliği kontrol edin; yalnız bu kurumun kayıtları görünür.</Empty>
          : (
            <Table>
              <TableHeader><TableRow className="hover:bg-transparent">
                <TableHead scope="col">Zaman</TableHead><TableHead scope="col">İşlem</TableHead><TableHead scope="col">Kişi</TableHead><TableHead scope="col">Gerekçe</TableHead>
              </TableRow></TableHeader>
              <TableBody>{r.data.items.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="tabular whitespace-nowrap">{fmtDateTime(a.at)}</TableCell>
                  <TableCell>{actionLabel(a.action)}</TableCell>
                  <TableCell>{a.actorName ?? 'Sistem'}</TableCell>
                  <TableCell className="text-ink-muted">{a.reason ?? '—'}</TableCell>
                </TableRow>))}
              </TableBody>
            </Table>
          )}
      </div>
    </section>
  );
}

export function AuditPage() {
  const { me } = useSession();
  const canAudit = hasRole(me, 'ADMIN', 'AUDITOR');
  return (
    <div className="page">
      <PageHeader title="Denetim izi">
        Kayıtta yapılan her işlem kişi, zaman ve gerekçesiyle saklanır; denetim kaydı değiştirilemez. Kiracının bütün verisinin dışa aktarımı da bu sekmeden istenir ve onaylanır.
      </PageHeader>
      <div className="grid gap-6">
        {canAudit ? <AuditLookup /> : <p className="text-ink-muted">Kayıt geçmişini Yönetici ve Denetçi görür. Bu sekmede kiracı dışa aktarımı talepleri durur; onayı Satınalma verir.</p>}
        <section aria-labelledby="export-h" className="grid gap-3">
          <h2 id="export-h">Kiracı dışa aktarımı</h2>
          <ExportsTab />
        </section>
      </div>
    </div>
  );
}
