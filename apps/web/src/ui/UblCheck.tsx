import { Tag } from './kit.tsx';

// UBL-TR temel kural denetimi (D81): belge, giriş ve fatura ekranında aynı biçimde gösterilir. Onayı engellemez.
export interface UblCheck {
  ruleSet: string; errors: number; warnings: number;
  findings: { rule: string; severity: 'ERROR' | 'WARNING'; message: string; path: string }[];
  billingReferences?: string[];
}

/** Hata bulgusu olan çıkarılmış alanlar (belge sayfasında "doğrulandı" etiketi yerine hata gösterilir). */
export const UBL_FIELD_RULES: Record<string, string[]> = {
  invoice_number: ['INVOICE_NO_FORMAT'], ettn: ['ETTN_FORMAT'], issue_date: ['ISSUE_DATE'], currency: ['CURRENCY', 'CURRENCY_MISMATCH'],
  seller_tax_id: ['SELLER_TAX_ID'], seller_tax_id_type: ['SELLER_TAX_ID'], buyer_tax_id: ['BUYER_TAX_ID'],
};
export const fieldHasUblError = (c: UblCheck | null | undefined, field: string) =>
  !!c?.findings.some((f) => f.severity === 'ERROR' && (UBL_FIELD_RULES[field] ?? []).includes(f.rule));

export function ublTitle(c: UblCheck) {
  if (!c.errors && !c.warnings) return 'UBL-TR temel kuralları geçti';
  return `UBL-TR kontrolü: ${[c.errors && `${c.errors} hata`, c.warnings && `${c.warnings} uyarı`].filter(Boolean).join(', ')}`;
}

export function UblFindings({ c }: { c: UblCheck }) {
  const ruleSet = c.ruleSet.replace(/\s*\(D\d+\)/, '');
  return (
    <>
      {c.findings.length > 0 && (
        <ul className="grid gap-1.5">
          {c.findings.map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <Tag label={f.severity === 'ERROR' ? { text: 'Hata', tone: 'danger', icon: 'x' } : { text: 'Uyarı', tone: 'warn', icon: 'alert' }} />
              <span className="min-w-0">{f.message}</span>
            </li>
          ))}
        </ul>
      )}
      {c.errors > 0 && (
        <p className="mt-2 text-sm">
          <span className="font-semibold">Ne yapmalı:</span> Belge GİB kurallarına uymuyor; elle üretilmiş ya da değiştirilmiş olabilir. Satıcıdan düzeltilmiş e-Faturayı isteyin
          veya belgeyi e-Fatura portalında ETTN ile sorgulayıp teyit edin. Fatura kaydı bu bulgu yüzünden engellenmez; tutar ve vergi kontrolleri ayrıca yapılır.
        </p>
      )}
      {c.billingReferences && c.billingReferences.length > 0 && (
        <p className="mt-2 text-sm text-ink-muted">Belgede atıf yapılan fatura: <span className="mono">{c.billingReferences.join(', ')}</span></p>
      )}
      {c.findings.length > 0 && (
        <details className="mt-2 text-sm text-ink-subtle">
          <summary className="cursor-pointer">Teknik ayrıntı (XML alanları)</summary>
          <ul className="mt-1 grid gap-0.5">{c.findings.map((f, i) => <li key={i} className="mono" style={{ overflowWrap: 'anywhere' }}>{f.rule}: {f.path}</li>)}</ul>
        </details>
      )}
      <p className="mt-2 text-sm text-ink-subtle">{ruleSet}. GİB'in resmî şema denetiminin yerini tutmaz.</p>
    </>
  );
}
