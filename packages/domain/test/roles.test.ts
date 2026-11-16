// v2 Faz 1 (D93/D95): Departman kullanıcısının sözleşme/fatura okuması (analiz-v2 §2.1) eklendi.
import { describe, expect, it } from 'vitest';
import { can, normalizeRoles, PERMISSIONS, REMOVED_PERMISSIONS, SEES_ALL_DEPARTMENTS, V2_ROLES, type Permission } from '../src/roles.js';

const tumIzinler = Object.keys(PERMISSIONS) as Permission[];

describe('normalizeRoles (D93)', () => {
  it('eski kodları v2 rolüne indirger ve tekilleştirir', () => {
    expect(normalizeRoles(['BUYER', 'LEGAL'])).toEqual(['PROCUREMENT']);
    expect(normalizeRoles(['REQUESTER', 'TECH_EVALUATOR'])).toEqual(['DEPARTMENT_USER']);
    expect(normalizeRoles(['TENANT_ADMIN'])).toEqual(['ADMIN']);
    expect(normalizeRoles(['PROCUREMENT'])).toEqual(['PROCUREMENT']);
  });
  it('bilinmeyen kod düşer', () => {
    expect(normalizeRoles(['NOPE'])).toEqual([]);
  });
});

describe('v2 izin tablosu', () => {
  it('kaldırılan izinleri hiçbir v2 rolü kullanamaz', () => {
    for (const p of REMOVED_PERMISSIONS) {
      for (const r of V2_ROLES) expect(can([r], p as Permission), `${r} ${p}`).toBe(false);
    }
  });
  it('AUDITOR yalnız okuma izinlerinde true', () => {
    const okuma = /\.read$|^integration\.reconcile$/;
    for (const p of tumIzinler) {
      expect(can(['AUDITOR'], p), p).toBe(!REMOVED_PERMISSIONS.includes(p) && okuma.test(p));
    }
    expect(can(['AUDITOR'], 'ai.read')).toBe(true);
  });
  it('PROCUREMENT korunan işlevler', () => {
    for (const p of ['signature.finalize', 'contract.terms.verify', 'invoice.manage', 'integration.ingest', 'award.decide', 'project.publish.approve', 'supplier.activate', 'tenant.export.approve'] as const) {
      expect(can(['PROCUREMENT'], p), p).toBe(true);
    }
  });
  it('DEPARTMENT_USER korunan işlevler', () => {
    for (const p of ['project.manage', 'bid.score', 'contract.manage', 'assessment.manage', 'incident.report'] as const) {
      expect(can(['DEPARTMENT_USER'], p), p).toBe(true);
    }
  });
  it('DEPARTMENT_USER kendi departmanının sözleşme ve faturalarını okur; rapor okumaz (analiz-v2 §2.1)', () => {
    expect(can(['DEPARTMENT_USER'], 'contract.read')).toBe(true);
    expect(can(['DEPARTMENT_USER'], 'invoice.read')).toBe(true);
    expect(can(['DEPARTMENT_USER'], 'report.read')).toBe(false);
    expect(can(['DEPARTMENT_USER'], 'invoice.manage')).toBe(false);
  });
  it('ADMIN korunan işlevler', () => {
    for (const p of ['tenant.export.request', 'ai.policy.manage', 'holiday.manage', 'audit.read', 'project.read', 'contract.read', 'invoice.read'] as const) {
      expect(can(['ADMIN'], p), p).toBe(true);
    }
  });
  it('task.read tedarikçi dışında herkese açık', () => {
    expect(can(['SUPPLIER'], 'task.read')).toBe(false);
    for (const r of V2_ROLES.filter((x) => x !== 'SUPPLIER')) expect(can([r], 'task.read')).toBe(true);
  });
  it('eski rol kodlarıyla can hâlâ çalışır', () => {
    expect(can(['BUYER'], 'project.manage')).toBe(true);
    expect(can(['TENANT_ADMIN'], 'audit.read')).toBe(true);
  });
  it('tüm bölümleri görenler', () => {
    expect(SEES_ALL_DEPARTMENTS).toEqual(['ADMIN', 'PROCUREMENT', 'AUDITOR']);
  });
});
