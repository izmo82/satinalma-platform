// v2 Faz 8 (Oracle ERP) Görev 1: özellik kataloğu, uç nokta yapılandırma doğrulaması, alan eşlemesi,
// yazma açma kuralı, zamanlama, sır arındırma ve elle değer uzlaştırması. Saf kurallar; G/Ç yok.
// Para decimal string'dir (`^-?\d+(\.\d{1,4})?$`); yuvarlanmaz, uymayan satır reddedilir.

export const ERP_FEATURES = ['SUPPLIER', 'COST_CENTER', 'REQUISITION', 'CONTRACT_HEADER', 'PURCHASE_ORDER', 'INVOICE', 'PAYMENT_STATUS'] as const;
export type ErpFeature = (typeof ERP_FEATURES)[number];

export const ERP_TRANSFORMS = ['NONE', 'TRIM', 'UPPER', 'DATE_YMD', 'DECIMAL'] as const;
export type ErpTransform = (typeof ERP_TRANSFORMS)[number];
export type ErpFieldType = 'text' | 'money' | 'date';
export type FieldMapEntry = { path: string; transform: ErpTransform };
export type FieldMap = Record<string, FieldMapEntry>;

export type ErpFeatureDef = {
  label: string;
  direction: 'IN' | 'OUT' | 'BOTH';
  reads: boolean;
  writes: boolean;
  stage: 1 | 2;
  appFields: { key: string; label: string; required: boolean; type: ErpFieldType }[];
  ebsDefaultMap: FieldMap;
  manualFallback: string;
};

const m = (path: string, transform: ErpTransform = 'NONE'): FieldMapEntry => ({ path, transform });

// R2 (yön ve aşama) + R6 (kapalıyken elle yol). EBS varsayılan eşlemesi öneridir (R8); sürüme bağlı sabit değildir.
export const ERP_FEATURE_CATALOG: Record<ErpFeature, ErpFeatureDef> = {
  SUPPLIER: {
    label: 'Tedarikçi ana verisi', direction: 'BOTH', reads: true, writes: true, stage: 1,
    appFields: [
      { key: 'taxId', label: 'Vergi kimlik no (VKN)', required: true, type: 'text' },
      { key: 'erpSupplierCode', label: 'ERP tedarikçi kodu', required: true, type: 'text' },
      { key: 'legalName', label: 'Unvan', required: false, type: 'text' },
    ],
    ebsDefaultMap: { taxId: m('TAX_REGISTRATION_NUM', 'TRIM'), erpSupplierCode: m('SEGMENT1', 'TRIM'), legalName: m('VENDOR_NAME', 'TRIM') },
    manualFallback: 'Tedarikçi kartındaki "ERP tedarikçi kodu" alanına Satınalma elle yazar; kaynağı "Elle" görünür.',
  },
  COST_CENTER: {
    label: 'Departman / masraf merkezi', direction: 'IN', reads: true, writes: false, stage: 1,
    appFields: [
      { key: 'code', label: 'Masraf merkezi kodu', required: true, type: 'text' },
      { key: 'name', label: 'Masraf merkezi adı', required: true, type: 'text' },
      { key: 'active', label: 'Etkin', required: false, type: 'text' },
    ],
    ebsDefaultMap: { code: m('FLEX_VALUE', 'TRIM'), name: m('DESCRIPTION', 'TRIM'), active: m('ENABLED_FLAG', 'UPPER') },
    manualFallback: 'Departmanda "Masraf merkezi kodu" alanını Yönetici elle girer; departman ana kaynağı Entra kalır.',
  },
  REQUISITION: {
    label: 'Satınalma talebi', direction: 'OUT', reads: false, writes: true, stage: 2,
    appFields: [
      { key: 'projectNo', label: 'Proje no', required: true, type: 'text' },
      { key: 'description', label: 'Açıklama', required: true, type: 'text' },
      { key: 'amount', label: 'Tutar', required: true, type: 'money' },
      { key: 'currency', label: 'Para birimi', required: true, type: 'text' },
      { key: 'erpReference', label: 'ERP referans no', required: false, type: 'text' },
    ],
    ebsDefaultMap: {
      projectNo: m('SEGMENT_REFERENCE'), description: m('DESCRIPTION'), amount: m('AMOUNT', 'DECIMAL'),
      currency: m('CURRENCY_CODE', 'UPPER'), erpReference: m('REQUISITION_NUMBER', 'TRIM'),
    },
    manualFallback: 'Proje detayında Satınalma "ERP\'ye elle iletildi" işaretler ve ERP referans no girer.',
  },
  CONTRACT_HEADER: {
    label: 'Sözleşme başlığı', direction: 'OUT', reads: false, writes: true, stage: 2,
    appFields: [
      { key: 'contractNo', label: 'Sözleşme no', required: true, type: 'text' },
      { key: 'supplierTaxId', label: 'Tedarikçi VKN', required: true, type: 'text' },
      { key: 'startDate', label: 'Başlangıç tarihi', required: true, type: 'date' },
      { key: 'title', label: 'Başlık', required: false, type: 'text' },
      { key: 'endDate', label: 'Bitiş tarihi', required: false, type: 'date' },
      { key: 'amount', label: 'Tutar', required: false, type: 'money' },
      { key: 'currency', label: 'Para birimi', required: false, type: 'text' },
      { key: 'erpReference', label: 'ERP referans no', required: false, type: 'text' },
    ],
    ebsDefaultMap: {
      contractNo: m('SEGMENT1', 'TRIM'), supplierTaxId: m('TAX_REGISTRATION_NUM', 'TRIM'), startDate: m('START_DATE', 'DATE_YMD'),
      title: m('COMMENTS', 'TRIM'), endDate: m('END_DATE', 'DATE_YMD'), amount: m('AMOUNT_AGREED', 'DECIMAL'),
      currency: m('CURRENCY_CODE', 'UPPER'), erpReference: m('PO_HEADER_ID', 'TRIM'),
    },
    manualFallback: 'Sözleşme detayında Satınalma "ERP\'ye elle iletildi" işaretler ve ERP referans no girer.',
  },
  PURCHASE_ORDER: {
    label: 'Sipariş', direction: 'IN', reads: true, writes: false, stage: 1,
    appFields: [
      { key: 'poNo', label: 'Sipariş no', required: true, type: 'text' },
      { key: 'supplierTaxId', label: 'Tedarikçi VKN', required: true, type: 'text' },
      { key: 'amount', label: 'Tutar', required: true, type: 'money' },
      { key: 'currency', label: 'Para birimi', required: true, type: 'text' },
      { key: 'orderDate', label: 'Sipariş tarihi', required: false, type: 'date' },
    ],
    ebsDefaultMap: {
      poNo: m('SEGMENT1', 'TRIM'), supplierTaxId: m('TAX_REGISTRATION_NUM', 'TRIM'), amount: m('AMOUNT', 'DECIMAL'),
      currency: m('CURRENCY_CODE', 'UPPER'), orderDate: m('CREATION_DATE', 'DATE_YMD'),
    },
    manualFallback: 'Faturada Satınalma sipariş referansını elle girer (salt okunur akış; uygulama sipariş yazmaz).',
  },
  INVOICE: {
    label: 'Fatura', direction: 'IN', reads: true, writes: false, stage: 1,
    appFields: [
      { key: 'invoiceNo', label: 'Fatura no', required: true, type: 'text' },
      { key: 'supplierTaxId', label: 'Tedarikçi VKN', required: true, type: 'text' },
      { key: 'invoiceDate', label: 'Fatura tarihi', required: true, type: 'date' },
      { key: 'totalAmount', label: 'Toplam tutar', required: true, type: 'money' },
      { key: 'currency', label: 'Para birimi', required: true, type: 'text' },
      { key: 'taxAmount', label: 'KDV tutarı', required: false, type: 'money' },
      { key: 'poNo', label: 'Sipariş no', required: false, type: 'text' },
    ],
    ebsDefaultMap: {
      invoiceNo: m('INVOICE_NUM', 'TRIM'), supplierTaxId: m('TAX_REGISTRATION_NUM', 'TRIM'), invoiceDate: m('INVOICE_DATE', 'DATE_YMD'),
      totalAmount: m('INVOICE_AMOUNT', 'DECIMAL'), currency: m('INVOICE_CURRENCY_CODE', 'UPPER'),
      taxAmount: m('TAX_AMOUNT', 'DECIMAL'), poNo: m('PO_NUMBER', 'TRIM'),
    },
    manualFallback: 'Mevcut elle giriş ve e-Fatura yükleme (D98) aynen çalışır.',
  },
  PAYMENT_STATUS: {
    label: 'Ödeme durumu', direction: 'IN', reads: true, writes: false, stage: 1,
    appFields: [
      { key: 'invoiceNo', label: 'Fatura no', required: true, type: 'text' },
      { key: 'supplierTaxId', label: 'Tedarikçi VKN', required: true, type: 'text' },
      { key: 'status', label: 'Ödeme durumu', required: true, type: 'text' },
      { key: 'paidAmount', label: 'Ödenen tutar', required: false, type: 'money' },
      { key: 'paymentDate', label: 'Ödeme tarihi', required: false, type: 'date' },
    ],
    ebsDefaultMap: {
      invoiceNo: m('INVOICE_NUM', 'TRIM'), supplierTaxId: m('TAX_REGISTRATION_NUM', 'TRIM'), status: m('PAYMENT_STATUS_FLAG', 'UPPER'),
      paidAmount: m('AMOUNT_PAID', 'DECIMAL'), paymentDate: m('CHECK_DATE', 'DATE_YMD'),
    },
    manualFallback: 'Fatura detayında Satınalma ödeme durumunu (Ödendi/Kısmi/Ödenmedi/Bilinmiyor) ve tarihi bilgi olarak girer; uygulama ödeme yapmaz.',
  },
};

// ---------- Uç nokta yapılandırması ----------

export const ERP_AUTH_TYPES = ['BASIC', 'OAUTH2_CLIENT_CREDENTIALS'] as const;
export type ErpAuthType = (typeof ERP_AUTH_TYPES)[number];
export type ErpSchedule = { mode: 'MANUAL' | 'INTERVAL' | 'DAILY'; intervalMinutes?: number; dailyTime?: string };

export type EndpointInput = {
  feature: ErpFeature;
  baseUrl: string;
  authType: ErpAuthType;
  username?: string;
  clientId?: string;
  tokenUrl?: string;
  /** Sır (parola / istemci sırrı) kayıtlı ya da bu istekte verildi mi. Değerin kendisi buraya gelmez. */
  secretSet: boolean;
  schedule: ErpSchedule;
  sourcePath: string;
  fieldMap: FieldMap;
};
export type ErpError = { field: string; code: string };

const FIELD_PATH_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const SOURCE_SEGMENT_RE = /^[A-Za-z0-9_.~-]+$/;
const DAILY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isValidFieldPath = (p: unknown): p is string => typeof p === 'string' && p.length >= 1 && p.length <= 120 && FIELD_PATH_RE.test(p);

function isValidSourcePath(p: unknown): boolean {
  if (typeof p !== 'string' || p.length < 1 || p.length > 200) return false;
  const segs = (p.startsWith('/') ? p.slice(1) : p).split('/');
  return segs.every((s) => s !== '' && s !== '.' && s !== '..' && SOURCE_SEGMENT_RE.test(s));
}

function ipv4ToInt(s: string): number | null {
  const p = s.split('.');
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  return ((Number(p[0]) << 24) | (Number(p[1]) << 16) | (Number(p[2]) << 8) | Number(p[3])) >>> 0;
}

function hostAllowed(hostname: string, allowed: string[]): boolean {
  const strip = (x: string) => x.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const h = strip(hostname);
  const ip = ipv4ToInt(h);
  for (const raw of allowed) {
    const a = strip(raw);
    if (!a) continue;
    if (a.includes('/')) {
      const [net, bitsS] = a.split('/');
      const n = ipv4ToInt(net ?? '');
      // Kapalı kal: yalnız 1–32 arası ondalık önek; /0, boş ve bozuk önek eşleşmez.
      if (ip === null || n === null || !/^\d{1,2}$/.test(bitsS ?? '')) continue;
      const bits = Number(bitsS);
      if (bits < 1 || bits > 32) continue;
      const mask = (0xffffffff << (32 - bits)) >>> 0;
      if (((ip & mask) >>> 0) === ((n & mask) >>> 0)) return true;
    } else if (a === h) return true;
  }
  return false;
}

// Adres doğrulaması (R12): geçerli URL, http/https, kullanıcı bilgisi yok, listede, üretimde yalnız https.
function checkUrl(field: string, value: unknown, opts: { allowedHosts: string[]; production: boolean }, errors: ErpError[]): void {
  if (typeof value !== 'string' || value.trim() === '') { errors.push({ field, code: 'required' }); return; }
  let u: URL;
  try { u = new URL(value); } catch { errors.push({ field, code: 'invalid_url' }); return; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') { errors.push({ field, code: 'scheme_invalid' }); return; }
  if (u.username || u.password) { errors.push({ field, code: 'userinfo_not_allowed' }); return; }
  if (u.protocol === 'http:' && opts.production) { errors.push({ field, code: 'https_required' }); return; }
  if (!hostAllowed(u.hostname, opts.allowedHosts)) errors.push({ field, code: 'host_not_allowed' });
}

export function validateEndpointConfig(input: EndpointInput, opts: { allowedHosts: string[]; production: boolean }): { ok: true } | { ok: false; errors: ErpError[] } {
  const errors: ErpError[] = [];
  const def = (ERP_FEATURES as readonly string[]).includes(input.feature) ? ERP_FEATURE_CATALOG[input.feature] : undefined;
  if (!def) return { ok: false, errors: [{ field: 'feature', code: 'invalid' }] };

  const baseErrs: ErpError[] = [];
  checkUrl('baseUrl', input.baseUrl, opts, baseErrs);
  errors.push(...baseErrs);

  // R4: kimlik doğrulama alanları. Kullanıcı adı ve istemci kimliği sır sayılmaz; parola/sır yalnız "ayarlı mı" olarak gelir.
  if (!(ERP_AUTH_TYPES as readonly string[]).includes(input.authType)) errors.push({ field: 'authType', code: 'invalid' });
  else if (input.authType === 'BASIC') {
    if (!input.username?.trim()) errors.push({ field: 'username', code: 'required' });
    if (!input.secretSet) errors.push({ field: 'secret', code: 'required' });
  } else {
    if (!input.clientId?.trim()) errors.push({ field: 'clientId', code: 'required' });
    checkUrl('tokenUrl', input.tokenUrl, opts, errors);
    if (!input.secretSet) errors.push({ field: 'secret', code: 'required' });
  }

  // R7: yazan akışlar olay güdümlüdür; zamanlama yalnız okuyan özelliklerde denetlenir.
  if (def.reads) {
    const s = input.schedule;
    if (!s || !['MANUAL', 'INTERVAL', 'DAILY'].includes(s.mode)) errors.push({ field: 'schedule.mode', code: 'invalid' });
    else if (s.mode === 'INTERVAL') {
      if (!Number.isInteger(s.intervalMinutes) || (s.intervalMinutes as number) < 15 || (s.intervalMinutes as number) > 1440) errors.push({ field: 'schedule.intervalMinutes', code: 'out_of_range' });
    } else if (s.mode === 'DAILY') {
      if (typeof s.dailyTime !== 'string' || !DAILY_RE.test(s.dailyTime)) errors.push({ field: 'schedule.dailyTime', code: 'invalid' });
    }
  }

  if (!isValidSourcePath(input.sourcePath)) errors.push({ field: 'sourcePath', code: 'invalid' });

  // R8: yalnız katalogdaki uygulama alanları; yol ve dönüşüm sabit kümeden.
  const known = new Set(def.appFields.map((f) => f.key));
  for (const [key, entry] of Object.entries(input.fieldMap ?? {})) {
    if (!known.has(key)) { errors.push({ field: `fieldMap.${key}`, code: 'unknown_field' }); continue; }
    if (!entry || !isValidFieldPath(entry.path)) errors.push({ field: `fieldMap.${key}.path`, code: 'invalid' });
    if (!entry || !(ERP_TRANSFORMS as readonly string[]).includes(entry.transform)) errors.push({ field: `fieldMap.${key}.transform`, code: 'invalid' });
    else {
      // Tutar alanı DECIMAL, tarih alanı DATE_YMD dönüşümü olmadan eşlenemez (yuvarlama/biçim kaçağı olmasın).
      const t = def.appFields.find((f) => f.key === key)?.type;
      if ((t === 'money' && entry.transform !== 'DECIMAL') || (t === 'date' && entry.transform !== 'DATE_YMD')) errors.push({ field: `fieldMap.${key}.transform`, code: 'transform_required' });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Zorunlu olup eşlenmemiş (ya da yolu geçersiz) uygulama alanları. Boş değilse özellik açılamaz (422 mapping_incomplete). */
export function missingMappings(feature: ErpFeature, map: FieldMap): string[] {
  return ERP_FEATURE_CATALOG[feature].appFields
    .filter((f) => f.required && !(Object.hasOwn(map, f.key) && isValidFieldPath(map[f.key]?.path)))
    .map((f) => f.key);
}

// ---------- Alan eşlemesi uygulama ----------

const DECIMAL_RE = /^-?\d+(\.\d{1,4})?$/;

function getPath(record: unknown, path: string): unknown {
  let cur: unknown = record;
  for (const seg of path.split('.')) {
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') return undefined;
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function validYmd(y: number, mo: number, d: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Eşlemeyi tek kayda uygular. Tutar yuvarlanmaz; uymayan değer null + hata olur. `feature` verilirse eksik zorunlu alan da hata sayılır. */
export function applyFieldMap(map: FieldMap, record: unknown, feature?: ErpFeature): { values: Record<string, string | null>; errors: ErpError[] } {
  const values: Record<string, string | null> = {};
  const errors: ErpError[] = [];
  for (const [key, entry] of Object.entries(map)) {
    const raw = isValidFieldPath(entry.path) ? getPath(record, entry.path) : undefined;
    if (raw === undefined || raw === null || raw === '') { values[key] = null; continue; }
    if (typeof raw === 'object') { values[key] = null; errors.push({ field: key, code: 'invalid_value' }); continue; }
    let s = String(raw);
    if (typeof raw === 'number' && !Number.isFinite(raw)) { values[key] = null; errors.push({ field: key, code: 'invalid_value' }); continue; }
    // Özellik verilmişse tutar/tarih alanı eşlemedeki dönüşümden bağımsız olarak DECIMAL/DATE_YMD denetiminden geçer.
    const ft = feature ? ERP_FEATURE_CATALOG[feature].appFields.find((f) => f.key === key)?.type : undefined;
    const transform: ErpTransform = ft === 'money' ? 'DECIMAL' : ft === 'date' ? 'DATE_YMD' : entry.transform;
    switch (transform) {
      case 'TRIM': s = s.trim(); break;
      case 'UPPER': s = s.trim().toUpperCase(); break;
      case 'DECIMAL':
        if (!DECIMAL_RE.test(s)) { values[key] = null; errors.push({ field: key, code: 'invalid_decimal' }); continue; }
        break;
      case 'DATE_YMD': {
        const mt = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ].*)?$/.exec(s.trim());
        if (!mt || !validYmd(Number(mt[1]), Number(mt[2]), Number(mt[3]))) { values[key] = null; errors.push({ field: key, code: 'invalid_date' }); continue; }
        s = `${mt[1]}-${mt[2]}-${mt[3]}`;
        break;
      }
      default: break;
    }
    values[key] = s === '' ? null : s;
  }
  if (feature) {
    for (const f of ERP_FEATURE_CATALOG[feature].appFields) {
      if (f.required && values[f.key] == null && !errors.some((e) => e.field === f.key)) errors.push({ field: f.key, code: 'required_missing' });
    }
  }
  return { values, errors };
}

// ---------- Yazma açma (R3) ----------

const DAY_MS = 24 * 60 * 60 * 1000;

export function canEnableWrite(input: { enabled: boolean; lastTestOkAt: string | null; now: string; confirmed: boolean; providerReal: boolean; production: boolean }):
  { ok: true } | { ok: false; reason: 'feature_disabled' | 'test_required' | 'confirmation_required' | 'mock_in_production' } {
  if (!input.enabled) return { ok: false, reason: 'feature_disabled' };
  if (input.production && !input.providerReal) return { ok: false, reason: 'mock_in_production' };
  const now = Date.parse(input.now);
  const last = input.lastTestOkAt ? Date.parse(input.lastTestOkAt) : NaN;
  if (!Number.isFinite(now) || !Number.isFinite(last) || last > now || now - last > DAY_MS) return { ok: false, reason: 'test_required' };
  if (!input.confirmed) return { ok: false, reason: 'confirmation_required' };
  return { ok: true };
}

// ---------- Zamanlama (R7) ----------

const istanbulParts = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};

/** `slot` idempotency anahtarının parçasıdır. DAILY: İstanbul gününün tarihi; saat gelmeden due=false. */
export function isDue(schedule: ErpSchedule, lastSlot: string | null, now: Date): { due: boolean; slot: string } {
  if (schedule.mode === 'INTERVAL' && Number.isInteger(schedule.intervalMinutes) && (schedule.intervalMinutes as number) > 0) {
    const slot = `I:${Math.floor(now.getTime() / ((schedule.intervalMinutes as number) * 60000))}`;
    return { due: slot !== lastSlot, slot };
  }
  if (schedule.mode === 'DAILY' && typeof schedule.dailyTime === 'string' && DAILY_RE.test(schedule.dailyTime)) {
    const { date, hm } = istanbulParts(now);
    const slot = `D:${date}`;
    return { due: hm >= schedule.dailyTime && slot !== lastSlot, slot };
  }
  return { due: false, slot: 'manual' };
}

// ---------- Sır arındırma ----------

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Hata iletisinden sırları, Authorization/Basic/Bearer değerlerini, URL kullanıcı bilgisini ve sorgu sırlarını `***` yapar (≤500). */
export function redactSecrets(message: string, secrets: string[]): string {
  let out = String(message);
  const forms = new Set<string>();
  for (const s of secrets) {
    if (!s) continue;
    for (const f of [s, encodeURIComponent(s), b64(s), b64(s).replace(/=+$/, ''), JSON.stringify(s).slice(1, -1)]) if (f) forms.add(f);
  }
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join('***');
  out = out
    .replace(/((?:proxy-)?authorization["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, '$1***')
    .replace(/((?:set-)?cookie["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, '$1***')
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[^\s,;"']+/gi, '$1***')
    .replace(/("(?:password|passwd|secret|client_secret|token|access_token|refresh_token|api_?key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"***"')
    .replace(/\b(basic|bearer)\s+[A-Za-z0-9._~+/=-]{3,}/gi, '$1 ***')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, '$1***@')
    .replace(/((?:password|passwd|pwd|client_secret|secret|access_token|refresh_token|token|api[_-]?key)=)[^&\s"']+/gi, '$1***');
  return out.slice(0, 500);
}

// ---------- Elle değer uzlaştırma (R6) ----------

export type ErpValueSource = 'ERP' | 'MANUAL';

/** ERP okuması elle girilen değeri sessizce ezmez: farklıysa CONFLICT_MANUAL (hata kaydına "elle girilen değerle çelişiyor"). */
export function reconcileManual(current: { value: string | null; source: ErpValueSource | null }, incoming: string | null): 'SET' | 'SAME' | 'CONFLICT_MANUAL' {
  const inc = incoming?.trim() ? incoming.trim() : null;
  if (inc === null) return 'SAME';
  const cur = current.value?.trim() ? current.value.trim() : null;
  if (cur === null) return 'SET';
  if (cur === inc) return 'SAME';
  // Kaynağı bilinmeyen dolu değer elle girilmiş sayılır: asla ezilmez.
  return current.source === 'ERP' ? 'SET' : 'CONFLICT_MANUAL';
}
