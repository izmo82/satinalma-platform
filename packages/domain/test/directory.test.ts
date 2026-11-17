import { describe, expect, it } from 'vitest';
import { inScope, normalizeDepartmentName, planMembershipDepartments, validateApprover } from '../src/directory.ts';
import { can } from '../src/roles.ts';

describe('normalizeDepartmentName', () => {
  it('kırpar, boşlukları teke indirir, tr-TR küçültür', () => {
    expect(normalizeDepartmentName('  BİLGİ   Teknolojileri ')).toBe('bilgi teknolojileri');
    expect(normalizeDepartmentName('IŞIK')).toBe('ışık');
  });
});

describe('inScope', () => {
  const sfx = 'ou=satinalma,ou=kullanicilar,dc=moment';
  it('DN sonu virgül sınırında eşleşir, büyük/küçük harf duyarsız', () => {
    expect(inScope({ onPremisesDistinguishedName: 'CN=Ali,OU=Satinalma,OU=Kullanicilar,DC=moment' }, sfx)).toBe(true);
    expect(inScope({ onPremisesDistinguishedName: 'OU=Satinalma,OU=Kullanicilar,DC=moment' }, sfx)).toBe(true);
  });
  it('sınır dışı ve boş DN kapsam dışıdır', () => {
    expect(inScope({ onPremisesDistinguishedName: 'CN=Ali,OU=XSatinalma,OU=Kullanicilar,DC=moment' }, sfx)).toBe(false);
    expect(inScope({ onPremisesDistinguishedName: null }, sfx)).toBe(false);
  });
  it('virgül çevresindeki boşluk DN ve sonekte yok sayılır', () => {
    expect(inScope({ onPremisesDistinguishedName: 'CN=Ali, OU=Satinalma , OU=Kullanicilar,DC=moment' }, sfx)).toBe(true);
    expect(inScope({ onPremisesDistinguishedName: 'CN=Ali,OU=Satinalma,OU=Kullanicilar,DC=moment' }, ' OU=Satinalma, OU=Kullanicilar ,  DC=moment ')).toBe(true);
    expect(inScope({ onPremisesDistinguishedName: 'CN=Ali, OU=XSatinalma, OU=Kullanicilar, DC=moment' }, 'OU=Satinalma, OU=Kullanicilar, DC=moment')).toBe(false);
    expect(inScope({ onPremisesDistinguishedName: '  ' }, sfx)).toBe(false);
  });
});

describe('planMembershipDepartments', () => {
  it('eski dizin departmanını çıkarır, yenisini ekler, sırayı korur', () => {
    expect(planMembershipDepartments(['a', 'x'], 'a', 'b')).toEqual(['x', 'b']);
    expect(planMembershipDepartments(['x'], null, null)).toEqual(['x']);
    expect(planMembershipDepartments(['x', 'b'], 'a', 'b')).toEqual(['x', 'b']);
    expect(planMembershipDepartments(['a', 'x'], 'a', null)).toEqual(['x']);
  });
});

describe('validateApprover', () => {
  const active = new Set(['u1', 'u2']);
  it('geçerli atama null döner', () => {
    expect(validateApprover({ kind: 'DEPARTMENT_HEAD', departmentId: 'd1', primaryUserId: 'u1', deputyUserId: 'u2' }, active)).toBeNull();
    expect(validateApprover({ kind: 'PROCUREMENT_LEAD', departmentId: null, primaryUserId: 'u1', deputyUserId: null }, active)).toBeNull();
  });
  it('asıl = vekil hata', () => {
    expect(validateApprover({ kind: 'PROCUREMENT_DIRECTOR', departmentId: null, primaryUserId: 'u1', deputyUserId: 'u1' }, active)).not.toBeNull();
  });
  it('bölüm sorumlusunda departman şart, diğerlerinde yasak', () => {
    expect(validateApprover({ kind: 'DEPARTMENT_HEAD', departmentId: null, primaryUserId: 'u1', deputyUserId: null }, active)).not.toBeNull();
    expect(validateApprover({ kind: 'PROCUREMENT_LEAD', departmentId: 'd1', primaryUserId: 'u1', deputyUserId: null }, active)).not.toBeNull();
  });
  it('pasif kullanıcı hata', () => {
    expect(validateApprover({ kind: 'PROCUREMENT_LEAD', departmentId: null, primaryUserId: 'u9', deputyUserId: null }, active)).not.toBeNull();
    expect(validateApprover({ kind: 'PROCUREMENT_LEAD', departmentId: null, primaryUserId: 'u1', deputyUserId: 'u9' }, active)).not.toBeNull();
  });
});

describe('dizin izinleri', () => {
  it('rol dağılımı', () => {
    expect(can(['ADMIN'], 'directory.manage')).toBe(true);
    expect(can(['AUDITOR'], 'directory.read')).toBe(true);
    expect(can(['AUDITOR'], 'directory.manage')).toBe(false);
    expect(can(['PROCUREMENT'], 'approver.read')).toBe(true);
    expect(can(['PROCUREMENT'], 'approver.manage')).toBe(false);
    expect(can(['ADMIN'], 'role.assign')).toBe(true);
    expect(can(['PROCUREMENT'], 'role.assign')).toBe(false);
  });
});

describe('normalizeDepartmentName (tr-TR katlama, SQL ile aynı olmalı)', () => {
  it('İ/I ve boşluk türleri', () => {
    expect(normalizeDepartmentName('İnsan Kaynakları')).toBe('insan kaynakları');
    expect(normalizeDepartmentName('ISIK')).toBe('ısık');
    expect(normalizeDepartmentName('Satın alma\t\tBirimi')).toBe('satın alma birimi');
    expect(normalizeDepartmentName('Satın alma')).toBe('satın alma');
    expect(normalizeDepartmentName('﻿Ar Ge　')).toBe('ar ge');
    expect(normalizeDepartmentName('ŞİRKET ÇAĞRI ÖZEL ÜRÜN')).toBe('şirket çağrı özel ürün');
  });
});
