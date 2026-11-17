// v2 Faz 8 (Oracle ERP) Görev 1: özellik kataloğu ve kurallar.
import { describe, expect, it } from 'vitest';
import {
  ERP_FEATURES, ERP_FEATURE_CATALOG, applyFieldMap, canEnableWrite, can, isDue, missingMappings, PERMISSIONS,
  reconcileManual, redactSecrets, validateEndpointConfig, type EndpointInput,
} from '../src/index.ts';

const base = (over: Partial<EndpointInput> = {}): EndpointInput => ({
  feature: 'INVOICE', baseUrl: 'https://erp.example.com:8443/', authType: 'BASIC', username: 'svc', secretSet: true,
  schedule: { mode: 'INTERVAL', intervalMinutes: 60 }, sourcePath: '/webservices/rest/invoices',
  fieldMap: ERP_FEATURE_CATALOG.INVOICE.ebsDefaultMap, ...over,
});
const opts = { allowedHosts: ['erp.example.com', '10.20.0.0/16'], production: true };
const codes = (r: ReturnType<typeof validateEndpointConfig>) => (r.ok ? [] : r.errors.map((e) => `${e.field}:${e.code}`));

describe('katalog (R2)', () => {
  it('7 özellik ve yönler', () => {
    expect([...ERP_FEATURES]).toEqual(['SUPPLIER', 'COST_CENTER', 'REQUISITION', 'CONTRACT_HEADER', 'PURCHASE_ORDER', 'INVOICE', 'PAYMENT_STATUS']);
    const d = Object.fromEntries(ERP_FEATURES.map((f) => [f, ERP_FEATURE_CATALOG[f].direction]));
    expect(d).toEqual({ SUPPLIER: 'BOTH', COST_CENTER: 'IN', REQUISITION: 'OUT', CONTRACT_HEADER: 'OUT', PURCHASE_ORDER: 'IN', INVOICE: 'IN', PAYMENT_STATUS: 'IN' });
  });
  it('yazan özellikler 2. aşama; salt okunur olanlar yazmaz', () => {
    for (const f of ['REQUISITION', 'CONTRACT_HEADER'] as const) {
      expect(ERP_FEATURE_CATALOG[f]).toMatchObject({ writes: true, reads: false, stage: 2 });
    }
    expect(ERP_FEATURE_CATALOG.SUPPLIER).toMatchObject({ reads: true, writes: true, stage: 1 });
    for (const f of ['COST_CENTER', 'PURCHASE_ORDER', 'INVOICE', 'PAYMENT_STATUS'] as const) {
      expect(ERP_FEATURE_CATALOG[f]).toMatchObject({ reads: true, writes: false, stage: 1 });
    }
  });
  it('her özellikte etiket, elle yol metni ve varsayılan eşleme tam', () => {
    for (const f of ERP_FEATURES) {
      const c = ERP_FEATURE_CATALOG[f];
      expect(c.label.length).toBeGreaterThan(2);
      expect(c.manualFallback.length).toBeGreaterThan(10);
      expect(missingMappings(f, c.ebsDefaultMap), f).toEqual([]);
      expect(c.appFields.some((x) => x.required)).toBe(true);
    }
  });
});

describe('validateEndpointConfig (R4, R7, R8, R12)', () => {
  it('geçerli yapılandırma', () => { expect(validateEndpointConfig(base(), opts)).toEqual({ ok: true }); });
  it('listede olmayan host reddedilir; liste boşsa hiçbiri geçmez', () => {
    expect(codes(validateEndpointConfig(base({ baseUrl: 'https://evil.example.org/' }), opts))).toContain('baseUrl:host_not_allowed');
    expect(codes(validateEndpointConfig(base(), { allowedHosts: [], production: false }))).toContain('baseUrl:host_not_allowed');
  });
  it('CIDR listesi IP adresi eşler', () => {
    expect(validateEndpointConfig(base({ baseUrl: 'https://10.20.3.4/' }), opts).ok).toBe(true);
    expect(validateEndpointConfig(base({ baseUrl: 'https://10.21.3.4/' }), opts).ok).toBe(false);
  });
  it('üretimde http reddedilir, geliştirmede 127.0.0.1 http geçer', () => {
    expect(codes(validateEndpointConfig(base({ baseUrl: 'http://erp.example.com/' }), opts))).toContain('baseUrl:https_required');
    expect(validateEndpointConfig(base({ baseUrl: 'http://127.0.0.1:9000/' }), { allowedHosts: ['127.0.0.1'], production: false }).ok).toBe(true);
    expect(codes(validateEndpointConfig(base({ baseUrl: 'ftp://erp.example.com/' }), { ...opts, production: false }))).toContain('baseUrl:scheme_invalid');
  });
  it('adreste kullanıcı bilgisi ve geçersiz adres reddedilir', () => {
    expect(codes(validateEndpointConfig(base({ baseUrl: 'https://u:p@erp.example.com/' }), opts))).toContain('baseUrl:userinfo_not_allowed');
    expect(codes(validateEndpointConfig(base({ baseUrl: 'bu bir adres degil' }), opts))).toContain('baseUrl:invalid_url');
  });
  it('BASIC: kullanıcı adı ve sır; OAUTH2: token adresi, istemci kimliği, sır (R4)', () => {
    expect(codes(validateEndpointConfig(base({ username: '' }), opts))).toContain('username:required');
    expect(codes(validateEndpointConfig(base({ secretSet: false }), opts))).toContain('secret:required');
    const o = base({ authType: 'OAUTH2_CLIENT_CREDENTIALS', username: undefined, clientId: 'cid', tokenUrl: 'https://erp.example.com/oauth/token' });
    expect(validateEndpointConfig(o, opts).ok).toBe(true);
    expect(codes(validateEndpointConfig({ ...o, clientId: '', tokenUrl: 'https://evil.example.org/t' }, opts))).toEqual(expect.arrayContaining(['clientId:required', 'tokenUrl:host_not_allowed']));
    expect(codes(validateEndpointConfig({ ...o, tokenUrl: undefined }, opts))).toContain('tokenUrl:required');
    expect(codes(validateEndpointConfig(base({ authType: 'NTLM' as never }), opts))).toContain('authType:invalid');
  });
  it('zamanlama aralıkları (R7)', () => {
    expect(codes(validateEndpointConfig(base({ schedule: { mode: 'INTERVAL', intervalMinutes: 10 } }), opts))).toContain('schedule.intervalMinutes:out_of_range');
    expect(codes(validateEndpointConfig(base({ schedule: { mode: 'INTERVAL', intervalMinutes: 1441 } }), opts))).toContain('schedule.intervalMinutes:out_of_range');
    expect(codes(validateEndpointConfig(base({ schedule: { mode: 'INTERVAL', intervalMinutes: 15.5 } }), opts))).toContain('schedule.intervalMinutes:out_of_range');
    for (const m of [15, 1440]) expect(validateEndpointConfig(base({ schedule: { mode: 'INTERVAL', intervalMinutes: m } }), opts).ok).toBe(true);
    expect(codes(validateEndpointConfig(base({ schedule: { mode: 'DAILY', dailyTime: '24:00' } }), opts))).toContain('schedule.dailyTime:invalid');
    expect(validateEndpointConfig(base({ schedule: { mode: 'DAILY', dailyTime: '06:00' } }), opts).ok).toBe(true);
    expect(validateEndpointConfig(base({ schedule: { mode: 'MANUAL' } }), opts).ok).toBe(true);
    expect(codes(validateEndpointConfig(base({ schedule: { mode: 'HOURLY' as never } }), opts))).toContain('schedule.mode:invalid');
  });
  it('yazan özellikte zamanlama aranmaz (olay güdümlü)', () => {
    const r = validateEndpointConfig(base({ feature: 'REQUISITION', fieldMap: ERP_FEATURE_CATALOG.REQUISITION.ebsDefaultMap, schedule: { mode: 'INTERVAL', intervalMinutes: 1 } }), opts);
    expect(r.ok).toBe(true);
  });
  it('kaynak yolu ve eşleme yolu (R8)', () => {
    for (const p of ['../x', '/a/../b', 'a b', '/a//b', 'https://evil/x', '']) {
      expect(codes(validateEndpointConfig(base({ sourcePath: p }), opts)), p).toContain('sourcePath:invalid');
    }
    const bad = { ...ERP_FEATURE_CATALOG.INVOICE.ebsDefaultMap, invoiceNo: { path: '../x', transform: 'NONE' as const } };
    expect(codes(validateEndpointConfig(base({ fieldMap: bad }), opts))).toContain('fieldMap.invoiceNo.path:invalid');
    for (const p of ['a..b', '.a', 'a.', 'a-b', 'a[0]', 'x'.repeat(121)]) {
      const m = { ...ERP_FEATURE_CATALOG.INVOICE.ebsDefaultMap, invoiceNo: { path: p, transform: 'NONE' as const } };
      expect(codes(validateEndpointConfig(base({ fieldMap: m }), opts)), p).toContain('fieldMap.invoiceNo.path:invalid');
    }
  });
  it('dönüşüm listesi dışı ve bilinmeyen alan reddedilir', () => {
    const m = { ...ERP_FEATURE_CATALOG.INVOICE.ebsDefaultMap, invoiceNo: { path: 'a.b', transform: 'EVAL' as never }, bogus: { path: 'a', transform: 'NONE' as const } };
    expect(codes(validateEndpointConfig(base({ fieldMap: m }), opts))).toEqual(expect.arrayContaining(['fieldMap.invoiceNo.transform:invalid', 'fieldMap.bogus:unknown_field']));
  });
});

describe('review düzeltmeleri', () => {
  it('I1 tutar/tarih alanı doğru dönüşüm olmadan eşlenemez; katalog alan türü taşır', () => {
    expect(ERP_FEATURE_CATALOG.INVOICE.appFields.find((f) => f.key === 'totalAmount')?.type).toBe('money');
    expect(ERP_FEATURE_CATALOG.INVOICE.appFields.find((f) => f.key === 'invoiceDate')?.type).toBe('date');
    for (const f of ERP_FEATURES) for (const a of ERP_FEATURE_CATALOG[f].appFields) {
      if (/amount$/i.test(a.key)) expect(a.type, `${f}.${a.key}`).toBe('money');
      if (/date$/i.test(a.key)) expect(a.type, `${f}.${a.key}`).toBe('date');
    }
    const m1 = { ...ERP_FEATURE_CATALOG.INVOICE.ebsDefaultMap, totalAmount: { path: 'a', transform: 'NONE' as const }, invoiceDate: { path: 'b', transform: 'TRIM' as const } };
    expect(codes(validateEndpointConfig(base({ fieldMap: m1 }), opts))).toEqual(expect.arrayContaining(['fieldMap.totalAmount.transform:transform_required', 'fieldMap.invoiceDate.transform:transform_required']));
  });
  it('I1 applyFieldMap özellikle verilince NONE eşlemeli tutarı da denetler', () => {
    const mp = { ...ERP_FEATURE_CATALOG.INVOICE.ebsDefaultMap, totalAmount: { path: 't', transform: 'NONE' as const } };
    const r = applyFieldMap(mp, { t: '1.234,50' }, 'INVOICE');
    expect(r.errors).toContainEqual({ field: 'totalAmount', code: 'invalid_decimal' });
  });
  it('I2 CIDR öneki 1–32; /0, boş ve bozuk önek kapalı', () => {
    for (const c of ['10.0.0.0/', '0.0.0.0/0', '10.0.0.0/33', '10.0.0.0/x', '10.0.0.0/-1', '10.0.0.0/008']) {
      expect(validateEndpointConfig(base({ baseUrl: 'https://10.1.2.3/' }), { allowedHosts: [c], production: true }).ok, c).toBe(false);
    }
    expect(validateEndpointConfig(base({ baseUrl: 'https://10.1.2.3/' }), { allowedHosts: ['10.0.0.0/8'], production: true }).ok).toBe(true);
  });
  it('IPv6 izin listesi köşeli parantezle ya da parantezsiz eşler', () => {
    for (const a of ['[::1]', '::1']) expect(validateEndpointConfig(base({ baseUrl: 'https://[::1]:9000/' }), { allowedHosts: [a], production: true }).ok, a).toBe(true);
  });
  it('kaynağı bilinmeyen dolu değer ezilmez', () => { expect(reconcileManual({ value: 'K1', source: null }, 'K2')).toBe('CONFLICT_MANUAL'); });
  it('redact: her şema, Cookie, X-API-Key, JSON alanları ve JSON-kaçışlı sır', () => {
    expect(redactSecrets('Authorization: Negotiate abc123def', [])).not.toContain('abc123');
    expect(redactSecrets('Cookie: sid=zzz999; a=b', [])).not.toContain('zzz999');
    expect(redactSecrets('X-API-Key: k-777-secret', [])).not.toContain('k-777');
    const j = redactSecrets('{"password":"pw\\"1","client_secret":"cs2","token":"t3","secret":"s4"}', []);
    for (const v of ['pw', 'cs2', 't3', 's4']) expect(j).not.toContain(v);
    const sec = 'a"b\\c';
    const out = redactSecrets('body ' + JSON.stringify({ x: sec }), [sec]);
    expect(out).not.toContain(JSON.stringify(sec).slice(1, -1));
  });
  it('prototip anahtarları yok sayılır', () => {
    for (const p of ['__proto__.x', 'a.constructor.name', 'a.prototype']) expect(applyFieldMap({ k: { path: p, transform: 'NONE' } }, { a: {} }).values.k).toBeNull();
  });
});

describe('missingMappings', () => {
  it('INVOICE için invoiceNo eşlenmemişse döner', () => {
    const { invoiceNo: _x, ...rest } = ERP_FEATURE_CATALOG.INVOICE.ebsDefaultMap;
    expect(missingMappings('INVOICE', rest)).toEqual(['invoiceNo']);
    expect(missingMappings('INVOICE', { ...rest, invoiceNo: { path: '', transform: 'NONE' } })).toEqual(['invoiceNo']);
  });
  it('isteğe bağlı alan eksikliği sayılmaz', () => {
    const optional = ERP_FEATURE_CATALOG.INVOICE.appFields.filter((f) => !f.required).map((f) => f.key);
    const m = Object.fromEntries(Object.entries(ERP_FEATURE_CATALOG.INVOICE.ebsDefaultMap).filter(([k]) => !optional.includes(k)));
    expect(missingMappings('INVOICE', m)).toEqual([]);
  });
});

describe('applyFieldMap', () => {
  const map = {
    invoiceNo: { path: 'h.no', transform: 'TRIM' as const },
    totalAmount: { path: 'h.total', transform: 'DECIMAL' as const },
    invoiceDate: { path: 'h.date', transform: 'DATE_YMD' as const },
    currency: { path: 'h.cur', transform: 'UPPER' as const },
  };
  const rec = { h: { no: '  X1 ', total: '1234.50', date: '2026-03-05T10:00:00+03:00', cur: 'try' } };
  it('dönüşümleri uygular', () => {
    expect(applyFieldMap(map, rec)).toEqual({ values: { invoiceNo: 'X1', totalAmount: '1234.50', invoiceDate: '2026-03-05', currency: 'TRY' }, errors: [] });
  });
  it('DECIMAL "1.234,50" ve üstel/boşluklu/5 haneli değeri reddeder, yuvarlamaz', () => {
    for (const v of ['1.234,50', '1e3', ' 12', '12.12345', '--1', 'abc']) {
      const r = applyFieldMap(map, { h: { ...rec.h, total: v } });
      expect(r.errors, v).toEqual([{ field: 'totalAmount', code: 'invalid_decimal' }]);
      expect(r.values.totalAmount).toBeNull();
    }
    expect(applyFieldMap(map, { h: { ...rec.h, total: '-5' } }).errors).toEqual([]);
    expect(applyFieldMap(map, { h: { ...rec.h, total: 1234.5 } }).values.totalAmount).toBe('1234.5');
    expect(applyFieldMap(map, { h: { ...rec.h, total: 1e21 } }).errors).toHaveLength(1);
  });
  it('DATE_YMD geçersiz günü reddeder', () => {
    expect(applyFieldMap(map, { h: { ...rec.h, date: '2026-02-30' } }).errors).toEqual([{ field: 'invoiceDate', code: 'invalid_date' }]);
    expect(applyFieldMap(map, { h: { ...rec.h, date: '05.03.2026' } }).errors).toEqual([{ field: 'invoiceDate', code: 'invalid_date' }]);
  });
  it('eksik değer null; özellik verilirse zorunlu alan eksikliği hata', () => {
    expect(applyFieldMap(map, { h: {} }).values.invoiceNo).toBeNull();
    const r = applyFieldMap(ERP_FEATURE_CATALOG.INVOICE.ebsDefaultMap, {}, 'INVOICE');
    expect(r.errors.every((e) => e.code === 'required_missing')).toBe(true);
    expect(r.errors.map((e) => e.field)).toContain('invoiceNo');
  });
  it('nesne değer ve prototip yolu güvenli', () => {
    expect(applyFieldMap(map, { h: { ...rec.h, no: { a: 1 } } }).errors).toEqual([{ field: 'invoiceNo', code: 'invalid_value' }]);
    const r = applyFieldMap({ x: { path: 'constructor.name', transform: 'NONE' } }, {});
    expect(r.values.x).toBeNull();
    expect(applyFieldMap(map, null).values.invoiceNo).toBeNull();
  });
});

describe('canEnableWrite (R3)', () => {
  const now = '2026-11-17T12:00:00Z';
  const ok = { enabled: true, lastTestOkAt: '2026-11-17T01:00:00Z', now, confirmed: true, providerReal: true, production: true };
  it('hepsi sağlanınca açılır', () => { expect(canEnableWrite(ok)).toEqual({ ok: true }); });
  it('her neden', () => {
    expect(canEnableWrite({ ...ok, enabled: false })).toEqual({ ok: false, reason: 'feature_disabled' });
    expect(canEnableWrite({ ...ok, lastTestOkAt: null })).toEqual({ ok: false, reason: 'test_required' });
    expect(canEnableWrite({ ...ok, lastTestOkAt: '2026-11-16T11:59:59Z' })).toEqual({ ok: false, reason: 'test_required' });
    expect(canEnableWrite({ ...ok, lastTestOkAt: '2026-11-16T12:00:00Z' })).toEqual({ ok: true });
    expect(canEnableWrite({ ...ok, lastTestOkAt: 'bozuk' })).toEqual({ ok: false, reason: 'test_required' });
    expect(canEnableWrite({ ...ok, confirmed: false })).toEqual({ ok: false, reason: 'confirmation_required' });
    expect(canEnableWrite({ ...ok, providerReal: false })).toEqual({ ok: false, reason: 'mock_in_production' });
    expect(canEnableWrite({ ...ok, providerReal: false, production: false })).toEqual({ ok: true });
  });
});

describe('isDue (R7)', () => {
  it('MANUAL hiç zamanlanmaz', () => { expect(isDue({ mode: 'MANUAL' }, null, new Date()).due).toBe(false); });
  it('INTERVAL: aynı dilimde bir kez', () => {
    const s = { mode: 'INTERVAL' as const, intervalMinutes: 30 };
    const a = isDue(s, null, new Date('2026-11-17T10:05:00Z'));
    expect(a.due).toBe(true);
    expect(isDue(s, a.slot, new Date('2026-11-17T10:25:00Z'))).toEqual({ due: false, slot: a.slot });
    const b = isDue(s, a.slot, new Date('2026-11-17T10:31:00Z'));
    expect(b.due).toBe(true);
    expect(b.slot).not.toBe(a.slot);
  });
  it('DAILY 06:00 İstanbul gün sınırı', () => {
    const s = { mode: 'DAILY' as const, dailyTime: '06:00' };
    expect(isDue(s, null, new Date('2026-11-17T02:59:00Z'))).toEqual({ due: false, slot: 'D:2026-11-17' });
    expect(isDue(s, null, new Date('2026-11-17T03:00:00Z'))).toEqual({ due: true, slot: 'D:2026-11-17' });
    expect(isDue(s, 'D:2026-11-17', new Date('2026-11-17T20:59:00Z'))).toEqual({ due: false, slot: 'D:2026-11-17' });
    // 21:00Z = İstanbul 00:00 ertesi gün; 06:00'dan önce, yeni gün dilimi
    expect(isDue(s, 'D:2026-11-17', new Date('2026-11-17T21:00:00Z'))).toEqual({ due: false, slot: 'D:2026-11-18' });
    expect(isDue(s, 'D:2026-11-17', new Date('2026-11-18T03:00:00Z'))).toEqual({ due: true, slot: 'D:2026-11-18' });
  });
});

describe('redactSecrets', () => {
  it('verilen sırları gizler (düz, URL kodlu, base64)', () => {
    const s = 'p@ss w0rd';
    const out = redactSecrets(`hata ${s} ve ${encodeURIComponent(s)} ve ${Buffer.from(s).toString('base64')}`, [s]);
    expect(out).not.toContain(s);
    expect(out).not.toContain(encodeURIComponent(s));
    expect(out).not.toContain(Buffer.from(s).toString('base64'));
    expect(out).toContain('***');
  });
  it('Authorization değerlerini ve Basic/Bearer belirteçlerini gizler', () => {
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz', [])).toBe('Authorization: ***');
    expect(redactSecrets('Authorization: Bearer abc.def.ghi', [])).not.toContain('abc.def');
    expect(redactSecrets('gönderilen Basic xxx reddedildi', [])).not.toContain('xxx');
    expect(redactSecrets('{"authorization":"Bearer tok123"}', [])).not.toContain('tok123');
  });
  it('URL kullanıcı bilgisini ve sorgu sırlarını gizler', () => {
    const o = redactSecrets('GET https://u:p@h.example.com/x?client_secret=abc&a=1 başarısız', []);
    expect(o).not.toContain('u:p');
    expect(o).not.toContain('abc');
    expect(o).toContain('h.example.com');
    expect(o).toContain('a=1');
  });
  it('boş sır listesi öğesi iletiyi bozmaz; en çok 500 karakter', () => {
    expect(redactSecrets('merhaba', [''])).toBe('merhaba');
    expect(redactSecrets('a'.repeat(900), [])).toHaveLength(500);
  });
});

describe('reconcileManual (R6)', () => {
  it('elle değeri ERP ezmez', () => {
    expect(reconcileManual({ value: 'K1', source: 'MANUAL' }, 'K2')).toBe('CONFLICT_MANUAL');
    expect(reconcileManual({ value: 'K1', source: 'MANUAL' }, 'K1')).toBe('SAME');
  });
  it('boşsa atanır; ERP kaynaklı değer güncellenir', () => {
    expect(reconcileManual({ value: null, source: null }, 'K2')).toBe('SET');
    expect(reconcileManual({ value: '', source: 'MANUAL' }, 'K2')).toBe('SET');
    expect(reconcileManual({ value: 'K1', source: 'ERP' }, 'K2')).toBe('SET');
    expect(reconcileManual({ value: 'K1', source: 'ERP' }, 'K1')).toBe('SAME');
  });
  it('ERP boş değer gönderirse değişmez', () => {
    expect(reconcileManual({ value: 'K1', source: 'MANUAL' }, null)).toBe('SAME');
    expect(reconcileManual({ value: 'K1', source: 'ERP' }, null)).toBe('SAME');
  });
});

describe('izinler', () => {
  it('rol eşlemesi', () => {
    expect(PERMISSIONS['integration.endpoint.read']).toEqual(['ADMIN', 'PROCUREMENT', 'AUDITOR']);
    expect(PERMISSIONS['integration.endpoint.manage']).toEqual(['ADMIN']);
    expect(PERMISSIONS['integration.endpoint.run']).toEqual(['ADMIN']);
    expect(PERMISSIONS['erp.manual.record']).toEqual(['PROCUREMENT']);
    expect(PERMISSIONS['department.cost_center']).toEqual(['ADMIN']);
    expect(can(['AUDITOR'], 'integration.endpoint.manage')).toBe(false);
  });
  it('mevcut integration.* girdileri değişmedi', () => {
    expect(PERMISSIONS['integration.ingest']).toEqual(['PROCUREMENT']);
    expect(PERMISSIONS['integration.reconcile']).toEqual(['PROCUREMENT', 'AUDITOR']);
    expect(PERMISSIONS['integration.replay']).toEqual(['PROCUREMENT']);
  });
});
