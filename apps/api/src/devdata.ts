// SENTETİK test/demo verisi. Gerçek kişi, firma, vergi kimliği veya imza içermez.
// Vergi kimlikleri kontrol basamağı geçerli sentetik değerlerdir; e-posta alan adı example.test.
import type pg from 'pg';
import { syntheticVkn } from '@sp/domain';

export interface SyntheticWorld {
  tenantA: string;
  tenantB: string;
  companyA1: { id: string; vkn: string; name: string };
  companyA2: { id: string; vkn: string; name: string };
  companyB1: { id: string; vkn: string; name: string };
  users: Record<'buyer' | 'masterData' | 'legal' | 'legal2' | 'finance' | 'security' | 'tenantAdmin' | 'auditor' | 'buyerB' | 'multi'
    | 'techEval' | 'supplier1' | 'supplier2' | 'supplier3' | 'finance2', { id: string; email: string }>;
  /** Tedarikçi portalı için sentetik firmalar: iki aktif, bir aday (BR02). */
  suppliers: { s1: string; s2: string; s3: string };
}

export const DEMO_TENANT_A = 'Örnek Holding (SENTETİK)';

export async function createSyntheticWorld(owner: pg.Pool, suffix = ''): Promise<SyntheticWorld> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const tenant = async (name: string) =>
      (await c.query<{ id: string }>(`INSERT INTO tenants (name, data_region) VALUES ($1, 'TR') RETURNING id`, [name + suffix])).rows[0]!.id;
    const tenantA = await tenant(DEMO_TENANT_A);
    const tenantB = await tenant('Başka Kiracı A.Ş. (SENTETİK)');
    const company = async (tenantId: string, name: string, prefix: string) => {
      const vkn = syntheticVkn(prefix);
      const id = (await c.query<{ id: string }>(
        `INSERT INTO legal_entities (tenant_id, name, country, tax_id_type, tax_id) VALUES ($1,$2,'TR','VKN',$3) RETURNING id`,
        [tenantId, name, vkn])).rows[0]!.id;
      return { id, vkn, name };
    };
    const seed = suffix ? String(Math.abs(hash(suffix)) % 1000).padStart(3, '0') : '000';
    const companyA1 = await company(tenantA, 'Örnek Holding Üretim A.Ş.', `91${seed}0001`);
    const companyA2 = await company(tenantA, 'Örnek Holding Lojistik A.Ş.', `91${seed}0002`);
    const companyB1 = await company(tenantB, 'Başka Kiracı Ticaret A.Ş.', `92${seed}0001`);

    const user = async (key: string, name: string) => {
      const email = `${key}${suffix}@example.test`.toLowerCase();
      const id = (await c.query<{ id: string }>(
        `INSERT INTO users (auth_subject, email, display_name) VALUES ($1,$2,$3) RETURNING id`, [`dev|${email}`, email, name])).rows[0]!.id;
      return { id, email };
    };
    const member = async (tenantId: string, userId: string, roles: string[], companies: string[]) => {
      await c.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids) VALUES ($1,$2,$3,$4)`, [tenantId, userId, roles, companies]);
    };
    const users = {
      buyer: await user('alper.satinalma', 'Alper Yıldız'),
      masterData: await user('mine.anaveri', 'Mine Kaya'),
      legal: await user('leyla.hukuk', 'Leyla Demir'),
      legal2: await user('kerem.hukuk', 'Kerem Aksoy'),
      finance: await user('ferda.finans', 'Ferda Şahin'),
      security: await user('selin.guvenlik', 'Selin Arslan'),
      tenantAdmin: await user('tamer.yonetici', 'Tamer Öztürk'),
      auditor: await user('deniz.denetci', 'Deniz Çelik'),
      buyerB: await user('bora.baskakiraci', 'Bora Koç'),
      multi: await user('ece.cokkiracili', 'Ece Polat'),
      techEval: await user('tolga.teknik', 'Tolga Er'),
      finance2: await user('nur.finansonay', 'Nur Aydın'),
      supplier1: await user('teklif.anadolu', 'Anadolu Bilişim Teklif Sorumlusu'),
      supplier2: await user('teklif.ege', 'Ege Sistem Teklif Sorumlusu'),
      supplier3: await user('teklif.kuzey', 'Kuzey Teknoloji Teklif Sorumlusu'),
    };
    const supplier = async (name: string, prefix: string, status: string) => (await c.query<{ id: string }>(
      `INSERT INTO suppliers (tenant_id, status, country, tax_id_type, tax_id, legal_name, created_by, activated_by, activated_at)
       VALUES ($1,$2,'TR','VKN',$3,$4,$5,$6,$7) RETURNING id`,
      [tenantA, status, syntheticVkn(prefix), name, users.buyer.id, status === 'ACTIVE' ? users.masterData.id : null, status === 'ACTIVE' ? new Date() : null])).rows[0]!.id;
    const suppliers = {
      s1: await supplier('Anadolu Bilişim Hizmetleri A.Ş. (SENTETİK)', `93${seed}0001`, 'ACTIVE'),
      s2: await supplier('Ege Sistem Entegrasyon Ltd. Şti. (SENTETİK)', `93${seed}0002`, 'ACTIVE'),
      s3: await supplier('Kuzey Teknoloji A.Ş. (SENTETİK)', `93${seed}0003`, 'CANDIDATE'),
    };
    const supplierMember = async (userId: string, supplierId: string) => c.query(
      `INSERT INTO memberships (tenant_id, user_id, roles, company_ids, supplier_id) VALUES ($1,$2,ARRAY['SUPPLIER'],'{}',$3)`, [tenantA, userId, supplierId]);
    await member(tenantA, users.buyer.id, ['BUYER', 'REQUESTER'], [companyA1.id]);
    await member(tenantA, users.masterData.id, ['MASTER_DATA'], [companyA1.id, companyA2.id]);
    await member(tenantA, users.legal.id, ['LEGAL'], [companyA1.id, companyA2.id]);
    await member(tenantA, users.legal2.id, ['LEGAL', 'PROCUREMENT_MANAGER'], [companyA1.id]);
    await member(tenantA, users.finance.id, ['FINANCE'], [companyA1.id]);
    await member(tenantA, users.security.id, ['SECURITY'], [companyA1.id]);
    // Kiracı yöneticisi: şirket belgelerine otomatik erişimi yok.
    await member(tenantA, users.tenantAdmin.id, ['TENANT_ADMIN'], []);
    await member(tenantA, users.auditor.id, ['AUDITOR'], [companyA1.id]);
    await member(tenantB, users.buyerB.id, ['BUYER', 'LEGAL', 'MASTER_DATA'], [companyB1.id]);
    await member(tenantA, users.multi.id, ['BUYER'], [companyA2.id]);
    await member(tenantB, users.multi.id, ['BUYER'], [companyB1.id]);
    await member(tenantA, users.techEval.id, ['TECH_EVALUATOR'], [companyA1.id]);
    await member(tenantA, users.finance2.id, ['FINANCE'], [companyA1.id]);
    await supplierMember(users.supplier1.id, suppliers.s1);
    await supplierMember(users.supplier2.id, suppliers.s2);
    await supplierMember(users.supplier3.id, suppliers.s3);
    await c.query('COMMIT');
    return { tenantA, tenantB, companyA1, companyA2, companyB1, users, suppliers };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

function hash(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

export function ublInvoiceXml(o: {
  invoiceNo: string; ettn: string; sellerVkn: string | null; sellerName: string; buyerVkn: string; buyerName: string;
  iban?: string | null; amount?: string;
  /** Satırlar ve beyan edilen toplamlar (yoksa yalnız ödenecek tutar). typeCode IADE ise billingRef özgün fatura no. */
  typeCode?: string; billingRef?: string; issueDate?: string;
  lines?: { name: string; qty: string; unitCode: string; price: string; net: string; rate: string; tax: string; oiv?: string }[];
  taxTotal?: string; withholding?: string; oivTotal?: string;
}): Buffer {
  // Özel iletişim vergisi (ÖİV, 4080): KDV dışı vergi örneği; KDV matrahına girer.
  const oiv = (amt: string) => `<cac:TaxSubtotal><cbc:TaxAmount currencyID="TRY">${amt}</cbc:TaxAmount><cbc:Percent>10</cbc:Percent><cac:TaxCategory><cac:TaxScheme><cbc:TaxTypeCode>4080</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
  const sellerId = o.sellerVkn ? `<cac:PartyIdentification><cbc:ID schemeID="VKN">${o.sellerVkn}</cbc:ID></cac:PartyIdentification>` : '';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>
  <cbc:ID>${o.invoiceNo}</cbc:ID>
  <cbc:UUID>${o.ettn}</cbc:UUID>
  <cbc:IssueDate>${o.issueDate ?? '2026-10-20'}</cbc:IssueDate>
  ${o.typeCode ? `<cbc:InvoiceTypeCode>${o.typeCode}</cbc:InvoiceTypeCode>` : ''}
  ${o.billingRef ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${o.billingRef}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ''}
  <cbc:Note>SENTETİK TEST FATURASI — gerçek işlem değildir.</cbc:Note>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="MERSISNO">0000000000000001</cbc:ID></cac:PartyIdentification>
    ${sellerId}
    <cac:PartyName><cbc:Name>${o.sellerName}</cbc:Name></cac:PartyName>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="VKN">${o.buyerVkn}</cbc:ID></cac:PartyIdentification>
    <cac:PartyName><cbc:Name>${o.buyerName}</cbc:Name></cac:PartyName>
  </cac:Party></cac:AccountingCustomerParty>
  ${o.iban ? `<cac:PaymentMeans><cbc:PaymentMeansCode>42</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>${o.iban}</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>` : ''}
  ${o.taxTotal ? `<cac:TaxTotal><cbc:TaxAmount currencyID="TRY">${o.taxTotal}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="TRY">${o.taxTotal}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>${o.oivTotal ? oiv(o.oivTotal) : ''}</cac:TaxTotal>` : ''}
  ${o.withholding ? `<cac:WithholdingTaxTotal><cbc:TaxAmount currencyID="TRY">${o.withholding}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="TRY">${o.withholding}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:TaxTypeCode>9015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:WithholdingTaxTotal>` : ''}
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="TRY">${o.amount ?? '12000.00'}</cbc:PayableAmount></cac:LegalMonetaryTotal>
  ${(o.lines ?? []).map((l, i) => `<cac:InvoiceLine><cbc:ID>${i + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="${l.unitCode}">${l.qty}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="TRY">${l.net}</cbc:LineExtensionAmount><cac:TaxTotal><cbc:TaxAmount currencyID="TRY">${l.tax}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="TRY">${l.tax}</cbc:TaxAmount><cbc:Percent>${l.rate}</cbc:Percent><cac:TaxCategory><cac:TaxScheme><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>${l.oiv ? oiv(l.oiv) : ''}</cac:TaxTotal><cac:Item><cbc:Name>${l.name}</cbc:Name></cac:Item><cac:Price><cbc:PriceAmount currencyID="TRY">${l.price}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`).join('\n  ')}
</Invoice>`, 'utf8');
}

/** Metin içeren, çok sayfalı geçerli minimal PDF (sentetik). İmza görüntüsü içermez. */
export function syntheticPdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pagesId = objs.length + 1 + pages.length * 2;
  const kids: number[] = [];
  for (const lines of pages) {
    const esc = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[ıİşŞğĞ]/g, (ch) => ({ ı: 'i', İ: 'I', ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G' } as Record<string, string>)[ch]!).replace(/[()\\]/g, '\\$&');
    const body = `BT /F1 12 Tf 60 780 Td 16 TL ${lines.map((l) => `(${esc(l)}) '`).join(' ')} ET`;
    const content = add(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
