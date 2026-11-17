// v2 Faz 6 izleme: Raporlar'daki yıllık risk kartının yer tutucusu. Kart tembel yüklenirken ve veri gelene dek aynı yükseklikte durur
// (düzen kayması yok). Ayrı dosyada: tembel parçaya (RiskPages) girmez.
import { Loading } from '../ui/kit.tsx';

/** Kart gövdesinin sabit en küçük yüksekliği (1440 ve 390'da ölçülen yüklü kart gövdesi kadar). */
export const RISK_CARD_BODY = 'min-h-[var(--risk-card-body)] [--risk-card-body:276px] max-[899px]:[--risk-card-body:516px]';

export function RiskReportPlaceholder() {
  const year = new Date().getFullYear();
  return (
    <section className="panel mb-4" aria-labelledby="rr-h" aria-busy="true">
      <div className="panel-head"><h2 id="rr-h">Yıllık risk matrisi ({year})</h2></div>
      <div className={`panel-body ${RISK_CARD_BODY}`}><Loading rows={2} /></div>
    </section>
  );
}
