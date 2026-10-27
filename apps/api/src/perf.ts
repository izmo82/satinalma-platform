// Okuma ağırlıklı yük ölçümü (Faz 7). Bağımlılıksız: sabit eşzamanlılıkla süre boyunca istek atar, gecikme yüzdeliklerini yazar.
// Yalnız geliştirme oturumuyla (AUTH_MODE=dev) ve ölçüm kopyasına bağlı bir API'ye karşı çalıştırılır; bkz. docs/runbook.md "Performans".
//   PERF_BASE=http://localhost:4200 PERF_SECONDS=20 PERF_CONCURRENCY=10 npx tsx apps/api/src/perf.ts
const base = process.env.PERF_BASE ?? 'http://localhost:4200';
const seconds = Number(process.env.PERF_SECONDS ?? 20);
const concurrency = Number(process.env.PERF_CONCURRENCY ?? 10);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

async function session(email: string) {
  const t = await (await fetch(`${base}/api/v1/dev/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json() as { token: string };
  const me = await (await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${t.token}` } })).json() as { activeTenantId: string | null; memberships: { tenantId: string; tenantName: string }[] };
  const tenant = me.memberships.find((m) => m.tenantName.startsWith('Örnek Holding'))?.tenantId ?? me.activeTenantId!;
  const headers = { authorization: `Bearer ${t.token}`, 'x-tenant-id': tenant };
  return { headers, get: async <T>(p: string) => (await (await fetch(base + p, { headers })).json()) as T };
}

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;

async function run(name: string, headers: Record<string, string>, paths: string[]) {
  const lat: number[] = []; let errors = 0; let n = 0;
  const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (Date.now() < end) {
      const p = paths[n++ % paths.length]!;
      const t = performance.now();
      try { const r = await fetch(base + p, { headers }); await r.arrayBuffer(); if (r.status >= 400) errors++; } catch { errors++; }
      lat.push(performance.now() - t);
    }
  }));
  lat.sort((a, b) => a - b);
  const row = { senaryo: name, istek: lat.length, hata: errors, 'istek/sn': Math.round(lat.length / seconds), p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)), max: Math.round(lat.at(-1)!) };
  console.log(JSON.stringify(row));
  return row;
}

const buyer = await session('alper.satinalma@example.test');
const finance = await session('ferda.finans@example.test');
const auditor = await session('deniz.denetci@example.test');
const legal = await session('leyla.hukuk@example.test');
const pos = await buyer.get<{ items: { id: string }[] }>('/api/v1/purchase-orders');
const invs = await finance.get<{ items: { id: string }[] }>('/api/v1/invoices');
const tasks = await legal.get<{ items: { entityType: string; entityId: string }[] }>('/api/v1/tasks?view=all');
const cvs = tasks.items.filter((t) => t.entityType === 'contract_version').map((t) => t.entityId);

console.log(`Hedef ${base}, ${seconds} sn, eşzamanlılık ${concurrency}. Gecikmeler milisaniye.`);
const results = [
  await run('İşlerim (satınalmacı)', buyer.headers, ['/api/v1/tasks?view=mine']),
  await run('Fatura listesi', finance.headers, ['/api/v1/invoices']),
  await run('Fatura detayı (kontrol + limit)', finance.headers, invs.items.slice(0, 20).map((i) => `/api/v1/invoices/${i.id}`)),
  await run('Sipariş detayı', buyer.headers, pos.items.slice(0, 20).map((p) => `/api/v1/purchase-orders/${p.id}`)),
  await run('İmza durumu', legal.headers, cvs.slice(0, 10).map((id) => `/api/v1/contract-versions/${id}/signature-status`)),
  await run('Yönetim raporu (yıl)', auditor.headers, [`/api/v1/reports/summary?from=2026-01-01&to=${today}`]),
  await run('ERP mutabakatı (yıl)', finance.headers, [`/api/v1/integration/erp/reconciliation?from=2026-01-01&to=${today}`]),
  await run('İmha adayları', legal.headers, ['/api/v1/retention/candidates']),
];
const worst = results.reduce((a, b) => (b.p95 > a.p95 ? b : a));
console.log(`En yüksek p95: ${worst.senaryo} ${worst.p95} ms (pilot hedefi p95 ≤ 2000 ms; tek makine ölçümü, SLA değildir).`);
