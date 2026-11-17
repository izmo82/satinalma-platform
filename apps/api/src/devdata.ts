// SENTETİK test/demo verisi. Gerçek kişi, firma, vergi kimliği veya imza içermez.
// Vergi kimlikleri kontrol basamağı geçerli sentetik değerlerdir; e-posta alan adı example.test.
import type pg from 'pg';
import { syntheticVkn } from '@sp/domain';
import { ZipStreamWriter } from './zip.ts';

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
  /** v2 (D93): kiracı başına üç departman. Bölüm kullanıcıları (techEval, security, buyer) Bilgi Teknolojileri'nde. */
  departments: { bt: string; ik: string; tc: string };
  departmentsB: { bt: string; ik: string; tc: string };
}

/** v2 (D93): her demo kiracısında oluşturulan departmanlar. */
export const DEMO_DEPARTMENTS = { bt: 'Bilgi Teknolojileri', ik: 'İnsan Kaynakları', tc: 'Tıbbi Cihaz' } as const;

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
    const departmentsOf = async (tenantId: string) => {
      const d = async (name: string) => (await c.query<{ id: string }>(`INSERT INTO departments (tenant_id, name) VALUES ($1,$2) RETURNING id`, [tenantId, name])).rows[0]!.id;
      return { bt: await d(DEMO_DEPARTMENTS.bt), ik: await d(DEMO_DEPARTMENTS.ik), tc: await d(DEMO_DEPARTMENTS.tc) };
    };
    const departments = await departmentsOf(tenantA);
    const departmentsB = await departmentsOf(tenantB);
    // v2 (D93/D95): üyelikler v2 rol kodlarıyla; bölüm kullanıcısının departmanları üyelikte.
    const member = async (tenantId: string, userId: string, roles: string[], companies: string[], departmentIds: string[] = []) => {
      await c.query(`INSERT INTO memberships (tenant_id, user_id, roles, company_ids, department_ids) VALUES ($1,$2,$3,$4,$5)`, [tenantId, userId, roles, companies, departmentIds]);
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
    // Eski rol (v1) → v2: BUYER+REQUESTER → PROCUREMENT+DEPARTMENT_USER; MASTER_DATA/LEGAL/PROCUREMENT_MANAGER/FINANCE → PROCUREMENT;
    // SECURITY/TECH_EVALUATOR → DEPARTMENT_USER; TENANT_ADMIN → ADMIN. Kullanıcılar ve şirket kapsamları aynen korunur.
    await member(tenantA, users.buyer.id, ['PROCUREMENT', 'DEPARTMENT_USER'], [companyA1.id], [departments.bt]);
    await member(tenantA, users.masterData.id, ['PROCUREMENT'], [companyA1.id, companyA2.id]);
    await member(tenantA, users.legal.id, ['PROCUREMENT'], [companyA1.id, companyA2.id]);
    await member(tenantA, users.legal2.id, ['PROCUREMENT'], [companyA1.id]);
    await member(tenantA, users.finance.id, ['PROCUREMENT'], [companyA1.id]);
    await member(tenantA, users.security.id, ['DEPARTMENT_USER'], [companyA1.id], [departments.bt]);
    // Yönetici: şirket belgelerine otomatik erişimi yok (şirket kapsamı boş).
    await member(tenantA, users.tenantAdmin.id, ['ADMIN'], []);
    await member(tenantA, users.auditor.id, ['AUDITOR'], [companyA1.id]);
    await member(tenantB, users.buyerB.id, ['PROCUREMENT'], [companyB1.id]);
    await member(tenantA, users.multi.id, ['PROCUREMENT'], [companyA2.id]);
    await member(tenantB, users.multi.id, ['PROCUREMENT'], [companyB1.id]);
    await member(tenantA, users.techEval.id, ['DEPARTMENT_USER'], [companyA1.id], [departments.bt]);
    await member(tenantA, users.finance2.id, ['PROCUREMENT'], [companyA1.id]);
    await supplierMember(users.supplier1.id, suppliers.s1);
    await supplierMember(users.supplier2.id, suppliers.s2);
    await supplierMember(users.supplier3.id, suppliers.s3);
    await c.query('COMMIT');
    return { tenantA, tenantB, companyA1, companyA2, companyB1, users, suppliers, departments, departmentsB };
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
  /** UBL-TR başlık alanları (D81); null verilirse belgeye yazılmaz (kural denetimi testleri için). */
  profileId?: string | null; currency?: string; lineCount?: number | null; exchangeRate?: string | null;
}): Buffer {
  const cur = o.currency ?? 'TRY';
  const lineCount = o.lineCount === undefined ? (o.lines ?? []).length : o.lineCount;
  const profileId = o.profileId === undefined ? 'TICARIFATURA' : o.profileId;
  // Özel iletişim vergisi (ÖİV, 4080): KDV dışı vergi örneği; KDV matrahına girer.
  const oiv = (amt: string) => `<cac:TaxSubtotal><cbc:TaxAmount currencyID="${cur}">${amt}</cbc:TaxAmount><cbc:Percent>10</cbc:Percent><cac:TaxCategory><cac:TaxScheme><cbc:TaxTypeCode>4080</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
  const sellerId = o.sellerVkn ? `<cac:PartyIdentification><cbc:ID schemeID="VKN">${o.sellerVkn}</cbc:ID></cac:PartyIdentification>` : '';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>
  ${profileId ? `<cbc:ProfileID>${profileId}</cbc:ProfileID>` : ''}
  <cbc:ID>${o.invoiceNo}</cbc:ID>
  <cbc:UUID>${o.ettn}</cbc:UUID>
  <cbc:IssueDate>${o.issueDate ?? '2026-10-20'}</cbc:IssueDate>
  ${o.typeCode ? `<cbc:InvoiceTypeCode>${o.typeCode}</cbc:InvoiceTypeCode>` : ''}
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  ${lineCount !== null ? `<cbc:LineCountNumeric>${lineCount}</cbc:LineCountNumeric>` : ''}
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
  ${o.exchangeRate ? `<cac:PricingExchangeRate><cbc:SourceCurrencyCode>${cur}</cbc:SourceCurrencyCode><cbc:TargetCurrencyCode>TRY</cbc:TargetCurrencyCode><cbc:CalculationRate>${o.exchangeRate}</cbc:CalculationRate></cac:PricingExchangeRate>` : ''}
  ${o.taxTotal ? `<cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${o.taxTotal}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="${cur}">${o.taxTotal}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>${o.oivTotal ? oiv(o.oivTotal) : ''}</cac:TaxTotal>` : ''}
  ${o.withholding ? `<cac:WithholdingTaxTotal><cbc:TaxAmount currencyID="${cur}">${o.withholding}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="${cur}">${o.withholding}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:TaxTypeCode>9015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:WithholdingTaxTotal>` : ''}
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="${cur}">${o.amount ?? '12000.00'}</cbc:PayableAmount></cac:LegalMonetaryTotal>
  ${(o.lines ?? []).map((l, i) => `<cac:InvoiceLine><cbc:ID>${i + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="${l.unitCode}">${l.qty}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="${cur}">${l.net}</cbc:LineExtensionAmount><cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${l.tax}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="${cur}">${l.tax}</cbc:TaxAmount><cbc:Percent>${l.rate}</cbc:Percent><cac:TaxCategory><cac:TaxScheme><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>${l.oiv ? oiv(l.oiv) : ''}</cac:TaxTotal><cac:Item><cbc:Name>${l.name}</cbc:Name></cac:Item><cac:Price><cbc:PriceAmount currencyID="${cur}">${l.price}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`).join('\n  ')}
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

/** "1250000.00" → "1.250.000,00" (tr-TR yazımı; kayan nokta yok). */
function trAmount(dec: string): string {
  const [i, f = '00'] = dec.split('.');
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${f.padEnd(2, '0').slice(0, 2)}`;
}
const trDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Sentetik sözleşme seçenekleri; `null` verilen alan belgeye yazılmaz (okunamayan alan sınaması için). */
export interface SyntheticContractOpts {
  title?: string | null; contractType?: string | null; contractNo?: string | null; supplierName?: string | null; supplierVkn?: string | null;
  /** ISO tarih (YYYY-AA-GG); belgeye gün.ay.yıl yazılır. */
  signedOn?: string | null; startDate?: string | null; endDate?: string | null;
  /** Ondalık dize ("1250000.00"); belgeye tr-TR yazılır. */
  amount?: string | null; currency?: string | null;
  noticePeriodDays?: number | null; paymentTermDays?: number | null; autoRenewal?: boolean | null; limitBasis?: 'NET' | 'GROSS' | null;
  guarantee?: string | null; slaPenalty?: string | null; kvkkClause?: string | null; governingCourt?: string | null; priceEscalation?: string | null;
  /** 2. sayfadaki maddeler; verilmezse standart maddeler. */
  clauses?: { heading: string; body: string }[];
  /** 1. sayfa sonuna eklenecek etiketsiz satırlar (ör. istem enjeksiyonu sınaması). */
  extraLines?: string[];
}

/**
 * v2 Faz 4: etiketli satırlı SENTETİK sözleşme PDF'i (gerçek sözleşme değildir). 1. sayfa künye ("Sözleşme Bedeli: 1.250.000,00 TRY" …),
 * 2. sayfa maddeler. Test sağlayıcısı (test-fixture) ve doğruluk düzeneği bu etiketleri okur. Yazı tipi aksanları düşürür (ş→s).
 */
export function syntheticContractPdf(o: SyntheticContractOpts = {}): Buffer {
  const v = <T>(x: T | null | undefined, d: T) => (x === undefined ? d : x);
  const title = v(o.title, 'Yillik Bakim Hizmet Sozlesmesi (SENTETIK)');
  const lines: string[] = ['SENTETIK TEST BELGESI - gercek sozlesme degildir', ''];
  const put = (label: string, value: string | null) => { if (value !== null) lines.push(`${label}: ${value}`); };
  put('Sözleşme Başlığı', title);
  put('Sözleşme Türü', v(o.contractType, 'Hizmet'));
  put('Sözleşme No', v(o.contractNo, 'SNT-2026-0001'));
  put('Tedarikçi Unvanı', v(o.supplierName, 'Anadolu Endustriyel Bakim Ltd. Sti. (SENTETIK)'));
  put('Yüklenici VKN', v(o.supplierVkn, null));
  const d = (x: string | null) => (x === null ? null : trDate(x));
  put('İmza Tarihi', d(v(o.signedOn, '2026-12-15')));
  put('Başlangıç Tarihi', d(v(o.startDate, '2027-01-01')));
  put('Bitiş Tarihi', d(v(o.endDate, '2027-12-31')));
  const amount = v(o.amount, '1250000.00');
  put('Sözleşme Bedeli', amount === null ? null : `${trAmount(amount)} ${v(o.currency, 'TRY') ?? ''}`.trim());
  const n = v(o.noticePeriodDays, 30);
  put('İhbar Süresi', n === null ? null : `${n} gun`);
  const pt = v(o.paymentTermDays, null);
  put('Ödeme Vadesi', pt === null ? null : `${pt} gun`);
  const ar = v(o.autoRenewal, null);
  put('Yenileme', ar === null ? null : ar ? 'Sozlesme otomatik olarak yenilenir.' : 'Sozlesme yenilenmez.');
  const lb = v(o.limitBasis, null);
  put('Limit Esası', lb === null ? null : lb === 'NET' ? 'KDV haric' : 'KDV dahil');
  put('Teminat', v(o.guarantee, null));
  put('Cezai Şart', v(o.slaPenalty, null));
  put('KVKK', v(o.kvkkClause, null));
  put('Yetkili Mahkeme', v(o.governingCourt, null));
  put('Fiyat Farkı', v(o.priceEscalation, null));
  lines.push(...(o.extraLines ?? []));
  const clauses = o.clauses ?? [
    { heading: 'Madde 1 - Konu', body: 'Yuklenici bakim hizmetini bu sozlesmeye gore verir.' },
    { heading: 'Madde 2 - Bedel ve Odeme', body: 'Bedel fatura tarihinden itibaren 30 gun icinde odenir.' },
    { heading: 'Madde 3 - Fesih', body: 'Taraflar 30 gun onceden yazili bildirimle feshedebilir.' },
  ];
  const page2 = ['Taraflar', 'ALICI: Ornek Holding Uretim A.S.        TEDARIKCI: Anadolu Endustriyel Bakim Ltd.', ''];
  for (const c of clauses) page2.push(c.heading, c.body, '');
  return syntheticPdf([lines, page2]);
}

/** v2 Faz 4: paragraflardan SENTETİK .docx (Faz 3 şablon denetimi gibi yalnız `word/document.xml`); şablon metni sınamaları için. */
export async function syntheticDocx(paragraphs: string[]): Promise<Buffer> {
  const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${x(p)}</w:t></w:r></w:p>`).join('');
  const chunks: Buffer[] = [];
  const z = new ZipStreamWriter({ write: async (c) => { chunks.push(c); } });
  await z.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`));
  await z.finish();
  return Buffer.concat(chunks);
}

/**
 * v2 Faz 4 (R2): test sağlayıcısının katalog satırı. Migration'da DEĞİL; yalnız NODE_ENV≠production seed'inde ve test kurulumunda
 * platform sahibi rolüyle eklenir. Görevler AI06/AI14/AI15, bölge `local`, tarife CALL 0.010000 USD ("test tarifesi").
 * `model_id` = AI_MODEL_ID: sözleşme görevleri yalnız bu kimlikli satıra yönlenir.
 */
export async function ensureTestAiCatalog(owner: pg.Pool, modelId: string): Promise<string> {
  if (process.env.NODE_ENV === 'production') throw new Error('test AI catalog row is forbidden in production');
  await owner.query(`INSERT INTO ai_models (provider, model_id, model_version, tasks, capabilities, approved_regions, trains_on_customer_data, price, verified_at, enabled)
    VALUES ('test-fixture', $1, 'test-fixture', ARRAY['AI06','AI14','AI15'], '{"structuredOutput":true,"vision":true}', ARRAY['local'], false,
      '{"unit":"CALL","call":"0.010000","input":null,"output":null,"page":null,"currency":"USD"}', NULL, true)
    ON CONFLICT (provider, model_id, model_version) DO NOTHING`, [modelId]);
  return (await owner.query<{ id: string }>(`SELECT id FROM ai_models WHERE provider = 'test-fixture' AND model_id = $1 AND model_version = 'test-fixture'`, [modelId])).rows[0]!.id;
}

/** Demo kiracı politikası: yalnız test-fixture, bölge local, aylık 5.00 USD. Var olan politika değiştirilmez. */
export async function ensureTestAiPolicy(owner: pg.Pool, tenantId: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('test AI policy is forbidden in production');
  await owner.query(`INSERT INTO ai_tenant_policies (tenant_id, allowed_providers, allowed_regions, monthly_budget, budget_currency, daily_call_limit, allow_upgrade)
    VALUES ($1, ARRAY['test-fixture'], ARRAY['local'], 5.00, 'USD', NULL, false) ON CONFLICT (tenant_id) DO NOTHING`, [tenantId]);
}
