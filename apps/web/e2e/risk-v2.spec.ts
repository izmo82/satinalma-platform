// v2 Faz 6 (D111) Görev 7: yıllık tedarikçi risk değerlendirmesi web akışı.
// Salt okunur gezinti (1440/1280/390): Tedarikçiler bölüm sekmeleri (eski dört + Risk matrisi), tedarikçi kartı eski sekmeleri + "Yıllık risk",
// değerlendirme formu, Yönetim > Şablonlar (Sözleşme taslakları aynen + Risk soruları), Raporlar kartı, içe aktarım ekranı; axe ve yatay taşma.
// Veri değiştiren uçtan uca akış yalnız 1440'ta: sentetik Excel (kurumun dosya düzeni, tamamen sentetik içerik; gerçek dosya kullanılmaz)
// → 422 başlık hatası → ölçeği belirsiz önizleme + Vazgeç → asıl dosya önizleme/uygula → set yoksa elle sonuçla seviye 2 → sentetik soru seti
// (Yönetici) yayımla → Excel satır 54 değerleri seviye 4: aksiyonsuz "Tamamla" engelli → aksiyon + kontrol → tamamla → matriste
// (bant 40–60, sütun 5) sayı +1 ve hücrede tedarikçi → dışa aktarım dosya adı → çeyreklik "Değişiklik yok" → Departman kullanıcısı başka
// departmanı görmez, katkıcı olarak görüş ekler → portal yalnız seviye/skor/görünür aksiyon.
// Not: yayımlanan sentetik set kiracıda kalır (silme ucu yok); sonraki koşularda "set yok → elle sonuç" adımı set yolundan (seviye 2) yürür.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { riskWorkbook, SOURCE_HEADERS } from '../../api/test/helpers/riskWorkbook.ts';

test.use({ reducedMotion: 'reduce' });

async function login(page: Page, email: string, landing = 'İşlerim') {
  await page.goto('/');
  await page.getByRole('radio', { name: new RegExp(email.replace(/\./g, '\\.')) }).check();
  await page.getByRole('button', { name: 'Oturum aç' }).click();
  await expect(page.getByRole('heading', { name: landing, level: 1 })).toBeVisible();
}
async function logout(page: Page) {
  await page.getByRole('button', { name: 'Çıkış' }).filter({ visible: true }).first().click();
  await expect(page.getByRole('button', { name: 'Oturum aç' })).toBeVisible();
}
async function audit(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${name}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
async function fits(page: Page, name: string) {
  await page.locator('main').first().waitFor();
  const ok = await page.evaluate(() => {
    const m = document.querySelector('main')!;
    return document.documentElement.scrollWidth <= window.innerWidth + 1 && m.scrollWidth <= m.clientWidth + 1;
  });
  expect(ok, `${name}: yatay taşma`).toBe(true);
}
const check = async (page: Page, name: string) => { await audit(page, name); await fits(page, name); };
const inDays = (n: number) => { const d = new Date(Date.now() + n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
async function pickSet(page: Page, name: string) {
  const sel = page.getByLabel('Soru seti');
  const value = await sel.locator('option', { hasText: name }).first().getAttribute('value');
  await sel.selectOption(value!);
}
const xlsx = (name: string, buffer: Buffer) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });

test('risk: bölüm ve kart sekmeleri aynen + yeni ekranlar; taşma ve erişilebilirlik (salt okunur)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, 'alper.satinalma@example.test');
  await expect(page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link')).toHaveCount(7);
  await page.goto('/tedarikciler');
  const section = page.getByRole('navigation', { name: 'Tedarikçiler sekmeleri' });
  await expect(section.getByRole('link')).toHaveText(['Liste', 'Olaylar', 'Anketler', 'Performans ağırlıkları', 'Risk matrisi']);
  await section.getByRole('link', { name: 'Risk matrisi' }).click();
  await expect(page.getByRole('heading', { name: 'Risk matrisi', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Risk 80–100, kritiklik 1, seviye 3/ })).toBeVisible();
  for (const c of ['Açık', 'Gecikmiş', 'Tamamlandı', 'Skorsuz']) await expect(page.getByRole('group', { name: 'Durum süzgeci' }).getByRole('button', { name: new RegExp(`^${c}`) })).toBeVisible();
  await expect(page.getByRole('button', { name: "Excel'e aktar" })).toBeVisible();
  await expect(page.getByRole('link', { name: "Excel'den içe aktar" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yılı başlat' })).toBeVisible();
  await check(page, 'Risk matrisi');

  // Tedarikçi kartı: eski sekmeler aynı adla, varsayılan "Kayıt ve onay"; "Yıllık risk" eklendi.
  await page.goto('/tedarikciler');
  await page.getByRole('link', { name: /Kuzey Teknoloji/ }).filter({ hasNotText: 'doğrulanmadı' }).first().click();
  const tabs = page.getByRole('tablist', { name: 'Tedarikçi' });
  for (const t of ['Kayıt ve onay', 'Belgeler ve geçerlilik', 'Sözleşmeler ve projeler', 'Değerlendirme ve risk', 'Yıllık risk', 'Olaylar', 'Performans karnesi', 'Portal kullanıcıları']) {
    await expect(tabs.getByRole('tab', { name: t, exact: true })).toBeVisible();
  }
  await expect(tabs.getByRole('tab', { name: 'Kayıt ve onay' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Değerlendirme ve risk' }).click();
  await expect(page.getByRole('heading', { name: 'Anket riski (içsel/kalan)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Değerlendirme başlat' }).or(page.getByText('Değerlendirme yok')).first()).toBeVisible();
  await tabs.getByRole('tab', { name: 'Yıllık risk' }).click();
  await expect(page).toHaveURL(/sekme=yillik-risk/);
  await expect(page.getByRole('heading', { name: 'Yıllık risk seviyesi' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Yıllar' })).toBeVisible();
  await check(page, 'Kart Yıllık risk');
  await page.getByRole('link', { name: 'Değerlendirmeyi aç' }).click();
  await expect(page.getByRole('heading', { name: /^Yıllık risk değerlendirmesi · \d{4}$/, level: 1 })).toBeVisible();
  for (const h of ['1. Kritiklik ölçütleri', '2. Risk skoru', '3. Seviye', 'Aksiyon ve denetim planı', 'Görüşler', 'Revizyon geçmişi']) await expect(page.getByRole('heading', { name: h })).toBeVisible();
  await expect(page.getByText(/yöntem khc-it-2100-002-r009\/v1/).first()).toBeVisible();
  await check(page, 'Risk değerlendirmesi');

  // Yönetim > Şablonlar: sözleşme taslakları varsayılan ve aynen; Risk soruları ikinci sekme.
  await page.goto('/yonetim/sablonlar');
  await expect(page.getByRole('heading', { name: 'Şablonlar', level: 1 })).toBeVisible();
  await page.getByRole('navigation', { name: 'Şablon türleri' }).getByRole('link', { name: 'Risk soruları' }).click();
  await expect(page.getByRole('heading', { name: 'Risk soruları', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Risk soru setleri' }).or(page.getByText('Kurumun 26 soruluk şablonu henüz girilmedi.'))).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yeni soru seti' })).toHaveCount(0); // Satınalma yalnız okur
  await expect(page.getByRole('heading', { name: 'Değerlendirme son tarihi' })).toBeVisible();
  await check(page, 'Risk soruları');

  await page.goto('/raporlar');
  await expect(page.getByRole('heading', { name: /^Yıllık risk matrisi \(\d{4}\)$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Risk matrisini aç' })).toBeVisible();
  await check(page, 'Raporlar');

  await page.goto('/tedarikciler/risk/ice-aktar');
  await expect(page.getByRole('heading', { name: "Excel'den içe aktar", level: 1 })).toBeVisible();
  await check(page, 'İçe aktarım');
});

test('risk uçtan uca: içe aktarım, elle sonuç, sentetik set, seviye 4 aksiyon planı, matris, dışa aktarım, çeyreklik, departman ve portal', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'veri değiştirir; yalnız bir projede');
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const YEAR = 2025;
  const A = `E2E Risk Elle ${tag} A.Ş. (SENTETİK)`;
  const B = `E2E Risk Satır54 ${tag} A.Ş. (SENTETİK)`;
  const C = `E2E Risk Tamam ${tag} A.Ş. (SENTETİK)`;
  const D = `E2E Risk Tıbbi ${tag} A.Ş. (SENTETİK)`;
  const H = `E2E Risk Atla ${tag} Ltd. Şti. (SENTETİK)`;
  const KUZEY = 'Kuzey Teknoloji A.Ş. (SENTETİK)';
  const BT = 'Bilgi Teknolojileri';
  const rows = [
    { name: A, services: 'Sentetik hizmet A', criteria: [3, 5, 1, 3, 5, 5], j: null, team: BT }, // satır 5 ölçütleri, skor yok → açık
    { name: B, services: 'Sentetik hizmet B', criteria: [5, 5, 5, 3, 5, 5], j: null, k: 'Ek bir aksiyon planı yokktur. Kritiklik sentetik veride yüksek.', team: BT }, // satır 54 ölçütleri
    { name: C, services: 'Sentetik hizmet C', criteria: [1, 3, 3, 3, 1, 3], j: 0.18, team: BT }, // seviye 1 → tamamlanmış
    { name: D, services: 'Sentetik hizmet D', criteria: [5, 3, 5, 5, 3, 5], j: 0.24, team: 'Tıbbi Cihaz' }, // seviye 3, başka departman
    { name: KUZEY, services: 'Sentetik Kuzey hizmeti', criteria: [3, 3, 3, 5, 3, 3], j: 0.62, team: 'Tıbbi Cihaz' }, // katkıcı senaryosu
    { name: KUZEY, services: 'Sentetik Kuzey ek hizmeti', criteria: [1, 1, 1, 1, 1, 1], j: 0.05, team: 'Tıbbi Cihaz' }, // aynı kart: birleşir
    { name: H, services: 'Sentetik', criteria: [1, 1, 1, 1, 1, 1], j: 0.05, team: BT }, // eşleşmez → atlanır
  ];
  const rowNo = (name: string) => 5 + rows.findIndex((r) => r.name === name);

  await login(page, 'alper.satinalma@example.test');
  await page.goto('/tedarikciler/risk/ice-aktar');
  // 422: başlıklar kaynak düzende değil → beklenen/bulunan başlıklar tabloda.
  const badHeaders = [...SOURCE_HEADERS]; badHeaders[9] = 'Risk Puanı (yanlış)';
  await page.getByLabel('Risk tablosu (.xlsx)').setInputFiles(xlsx('yanlis-baslik.xlsx', await riskWorkbook(rows.slice(0, 1), { period: `${YEAR}-4`, headers: badHeaders })));
  await page.getByRole('button', { name: 'Önizle' }).click();
  await expect(page.getByText('"Risk Tablosu" sayfasının 3. satır başlıkları beklenen düzende değil.')).toBeVisible();
  const cmp = page.getByRole('region', { name: 'Başlık karşılaştırması' });
  await expect(cmp.getByText('Risk Puanı (yanlış)')).toBeVisible();
  await expect(cmp.getByText('Risk Skoru', { exact: true })).toBeVisible();
  // Ölçeği belirsiz (J hem ≤ 1 hem > 1) → satır sorunu; Vazgeç.
  await page.getByLabel('Risk tablosu (.xlsx)').setInputFiles(xlsx('belirsiz.xlsx', await riskWorkbook([
    { name: `E2E Belirsiz 1 ${tag} (SENTETİK)`, criteria: [1, 1, 1, 1, 1, 1], j: 0.5, team: BT },
    { name: `E2E Belirsiz 2 ${tag} (SENTETİK)`, criteria: [1, 1, 1, 1, 1, 1], j: 45, team: BT }], { period: `${YEAR}-4` })));
  await page.getByRole('button', { name: 'Önizle' }).click();
  await expect(page.getByText(/ölçeği belirsiz/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(page.getByLabel('Risk tablosu (.xlsx)')).toBeVisible();

  // Asıl dosya: önizleme.
  await page.getByLabel('Risk tablosu (.xlsx)').setInputFiles(xlsx(`risk-${tag}.xlsx`, await riskWorkbook(rows, { period: `${YEAR}-4` })));
  await page.getByRole('button', { name: 'Önizle' }).click();
  await expect(page.getByRole('table', { name: 'İçe aktarım önizlemesi' })).toBeVisible();
  await expect(page.getByLabel('Değerlendirme yılı')).toHaveValue(String(YEAR));
  await expect(page.getByText('Risk skoru dosyada 0–1 kesir olarak girilmiş; 100 ile çarpılarak okunur.')).toBeVisible();
  const preview = page.getByRole('table', { name: 'İçe aktarım önizlemesi' });
  const row = (name: string, nth = 0) => preview.getByRole('row').filter({ hasText: name }).nth(nth);
  await expect(row(H)).toContainText('atlanır');
  await expect(row(B)).toContainText('Excel notu: Kritiklik sentetik veride yüksek.');
  await expect(row(B)).toContainText('4,59 (sütun 5)');
  await expect(row(KUZEY, 1)).toContainText(/Birincil satırın hizmetlerine eklenecek|Çakışma — atlanır/);
  await expect(page.getByRole('table', { name: 'Ekip eşlemesi' }).getByLabel('Tıbbi Cihaz departmanı')).toHaveValue(/[0-9a-f-]{36}/);
  for (const n of [A, B, C, D]) {
    await page.getByLabel(`Satır ${rowNo(n)} kararı`).selectOption('NEW_CANDIDATE');
    await expect(row(n)).toContainText('Yeni aday kart');
  }
  await expect(page.getByTestId('import-summary')).toContainText(/\d+ değerlendirme açılacak, \d+ tamamlanmış, \d+ atlanacak/);
  await check(page, 'İçe aktarım önizlemesi');
  await page.getByRole('button', { name: 'Uygula', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Uygula' }).click();
  await expect(page.getByText('Uygulandı:')).toBeVisible();
  const idOf = async (name: string) => (await row(name).getByRole('link', { name: 'Değerlendirmeyi aç' }).getAttribute('href'))!.split('/').pop()!;
  const [idA, idB, idC, idD] = [await idOf(A), await idOf(B), await idOf(C), await idOf(D)];
  await expect(row(B)).toContainText('Açık');

  // A: set yoksa elle sonuç (dayanak notu zorunlu) → seviye 2 tamamla; set varsa sentetik setle 0 puan → seviye 2.
  await page.goto(`/tedarikciler/risk/${idA}`);
  await expect(page.getByRole('heading', { name: `Yıllık risk değerlendirmesi · ${YEAR}`, level: 1 })).toBeVisible();
  await expect(page.getByText('Kritiklik 3,22 → sütun 3')).toBeVisible();
  const manual = await page.getByText('Kurumun Tedarikçi Riski Değerlendirme Şablonu henüz girilmedi').isVisible();
  if (manual) {
    await page.getByLabel('Şablon sonucu (0–100)').fill('15');
    await page.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.getByText('Elle girilen sonuç için dayanak notu zorunludur.')).toBeVisible();
    await page.getByLabel('Dayanak notu').fill('Sentetik test: şablon dışında hesaplanan sonuç.');
  } else {
    info.annotations.push({ type: 'not', description: 'Yayımlı set var: A elle sonuç yerine sentetik setle (0 puan) seviye 2.' });
    await pickSet(page, 'E2E sentetik test seti');
    await page.getByRole('radiogroup', { name: 'T1 cevabı' }).getByLabel('Hayır').check();
    await page.getByRole('radiogroup', { name: 'T2 cevabı' }).getByLabel('Hayır').check();
  }
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Taslak kaydedildi.')).toBeVisible();
  await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: '3. Seviye' }) }).getByText('Seviye 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tamamla', exact: true }).click();
  await expect(page.getByText('Değerlendirme tamamlandı; yeni revizyon yazıldı.')).toBeVisible();
  await expect(page.getByText(manual ? /kaynak: Elle girilen şablon sonucu/ : /kaynak: Soru seti/)).toBeVisible();
  await logout(page);

  // Sentetik soru seti (Yönetici): açıkça sentetik, kurum şablonu değil. Aynı kodla her koşu yeni sürüm; önceki yayımlı sürüm emekliye ayrılır.
  await login(page, 'tamer.yonetici@example.test');
  await page.goto('/yonetim/sablonlar?sekme=risk-sorulari');
  await page.getByRole('button', { name: 'Yeni soru seti' }).click();
  await page.getByLabel('Set kodu').fill('E2E-SENTETIK');
  await page.getByLabel('Set adı').fill(`E2E sentetik test seti ${tag}`);
  await page.getByLabel('Soru 1 kodu').fill('T1');
  await page.getByLabel('Soru 1 metni').fill('Test sorusu 1 (sentetik)');
  await page.getByLabel('Ağırlık').first().fill('48');
  await page.getByRole('button', { name: 'Soru ekle' }).click();
  await page.getByLabel('Soru 2 kodu').fill('T2');
  await page.getByLabel('Soru 2 metni').fill('Test sorusu 2 (sentetik)');
  await page.getByLabel('Ağırlık').nth(1).fill('52');
  await expect(page.getByText('Toplam ağırlık: 100')).toBeVisible();
  await page.getByRole('button', { name: 'Taslak olarak kaydet' }).click();
  await expect(page.getByText(/taslak olarak kaydedildi/)).toBeVisible();
  const setRow = page.getByRole('table', { name: 'Risk soru setleri' }).getByRole('row').filter({ hasText: `E2E sentetik test seti ${tag}` });
  await setRow.getByRole('button', { name: 'Yayımla' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yayımla' }).click();
  await expect(setRow.getByText('Yayımlandı')).toBeVisible();
  await logout(page);

  // Matris (bant 40–60, sütun 5) önceki sayı.
  await login(page, 'alper.satinalma@example.test');
  await page.goto(`/tedarikciler/risk?yil=${YEAR}`);
  const cell = page.getByRole('button', { name: /^Risk 40–60, kritiklik 5, seviye 4: \d+ değerlendirme$/ });
  const before = Number(/: (\d+) değerlendirme/.exec((await cell.getAttribute('aria-label'))!)![1]);

  // B: Excel satır 54 değerleri (4,59 → sütun 5) + sentetik set 48 puan → seviye 4; aksiyonsuz tamamlanmaz.
  await page.goto(`/tedarikciler/risk/${idB}`);
  await expect(page.getByText('Kritiklik 4,59 → sütun 5')).toBeVisible();
  await pickSet(page, `E2E sentetik test seti ${tag}`);
  await page.getByRole('radiogroup', { name: 'T1 cevabı' }).getByLabel('Evet').check();
  await page.getByRole('radiogroup', { name: 'T2 cevabı' }).getByLabel('Hayır').check();
  await expect(page.getByText(/Risk skoru 48,00 \/ 100 → bant 40–60/)).toBeVisible();
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Taslak kaydedildi.')).toBeVisible();
  await expect(page.getByText('Seviye 4 — Turuncu').first()).toBeVisible();
  await page.getByRole('button', { name: 'Tamamla', exact: true }).click();
  await expect(page.getByText('Değerlendirme tamamlanamaz; eksikleri giderin.')).toBeVisible();
  await expect(page.getByText('Seviye 4–5 için en az bir aksiyon (azaltım) satırı gerekir.').first()).toBeVisible();
  await expect(page.getByText('Seviye 4–5 için en az bir denetim/kontrol satırı gerekir.').first()).toBeVisible();
  // Aksiyon + kontrol (sorumlu kişi, gelecek tarih).
  const addAction = async (kind: 'Aksiyon (azaltım)' | 'Denetim/kontrol', title: string, visible: boolean) => {
    await page.getByRole('button', { name: 'Aksiyon ekle' }).click();
    const form = page.getByRole('form', { name: 'Yeni aksiyon' });
    await form.getByLabel('Tür').selectOption({ label: kind });
    await form.getByLabel('Başlık', { exact: true }).fill(title);
    if (kind === 'Denetim/kontrol') await form.getByLabel('Yöntem').selectOption({ label: 'Yerinde' });
    await form.getByLabel('Sorumlu kişi').selectOption({ index: 1 });
    await form.getByLabel('Tarih', { exact: true }).fill(inDays(30));
    if (visible) await form.getByLabel(/Tedarikçi görsün/).check();
    await form.getByRole('button', { name: 'Ekle' }).click();
    await expect(page.getByRole('list', { name: 'Aksiyonlar' }).getByText(title)).toBeVisible();
  };
  await addAction('Aksiyon (azaltım)', `Sentetik azaltım aksiyonu ${tag}`, true);
  await addAction('Denetim/kontrol', `Sentetik yerinde denetim ${tag}`, false);
  await page.getByRole('button', { name: 'Tamamla', exact: true }).click();
  await expect(page.getByText('Değerlendirme tamamlandı; yeni revizyon yazıldı.')).toBeVisible();
  await expect(page.getByText(/kaynak: Soru seti/)).toBeVisible();

  // Matriste hücre sayısı +1; tıklayınca hücrenin tedarikçileri.
  await page.goto(`/tedarikciler/risk?yil=${YEAR}`);
  await expect(cell).toHaveAttribute('aria-label', `Risk 40–60, kritiklik 5, seviye 4: ${before + 1} değerlendirme`);
  await cell.click();
  await expect(page.getByRole('list', { name: 'Hücredeki tedarikçiler' }).getByRole('link', { name: B })).toBeVisible();
  // Dışa aktarım: kaynak dosya adı düzeni (geçmiş yıl → yıl-4 dönemi).
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: "Excel'e aktar" }).click();
  expect((await dl).suggestedFilename()).toBe(`BT Tedarikçi Risk Değerlendirme Tablosu ${YEAR}-4.xlsx`);
  await expect(page.getByText(`İndirildi: BT Tedarikçi Risk Değerlendirme Tablosu ${YEAR}-4.xlsx.`, { exact: false })).toBeVisible();
  await check(page, 'Risk matrisi (veri)');

  // Çeyreklik "Değişiklik yok": en eski eksik dönem varsayılan.
  await page.goto(`/tedarikciler/risk/${idC}`);
  await expect(page.getByText('Tamamlandı').first()).toBeVisible();
  await expect(page.getByLabel('Dönem')).toHaveValue(`${YEAR}-1`);
  await page.getByRole('button', { name: 'Değişiklik yok' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Değişiklik yok' }).click();
  await expect(page.getByText(`${YEAR}-1 dönemi "Değişiklik yok" olarak kaydedildi.`)).toBeVisible();
  await expect(page.getByLabel('Dönem')).toHaveValue(`${YEAR}-2`);
  await expect(page.getByRole('list', { name: 'Gözden geçirmeler' })).toContainText(`${YEAR}-1 · Değişiklik yok`);
  await check(page, 'Değerlendirme (tamamlanmış)');
  await logout(page);

  // Departman kullanıcısı (Bilgi Teknolojileri): Tıbbi Cihaz değerlendirmesini görmez; Kuzey'de (BT sözleşmesi yürürlükte) katkıcı → görüş.
  await login(page, 'tolga.teknik@example.test');
  await page.goto(`/tedarikciler/risk?yil=${YEAR}`);
  await expect(page.getByText('Departmanınızın değerlendirmeleri')).toBeVisible();
  const list = page.getByRole('table', { name: 'Risk değerlendirmeleri' });
  await expect(list.getByRole('link', { name: A })).toBeVisible();
  await expect(list.getByRole('link', { name: D })).toHaveCount(0);
  await page.goto(`/tedarikciler/risk/${idD}`);
  await expect(page.getByRole('heading', { name: 'Kayıt bulunamadı veya erişim yetkiniz yok' })).toBeVisible();
  await page.goto(`/tedarikciler/risk?yil=${YEAR}`);
  const kuzeyRow = list.getByRole('row').filter({ hasText: KUZEY });
  await expect(kuzeyRow).toContainText('Katkıcı: salt okunur, görüş eklenir');
  await kuzeyRow.getByRole('link', { name: KUZEY }).click();
  await expect(page.getByText('Salt okunur: bu değerlendirmeyi sorumlu departman yapar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tamamla', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  await page.getByLabel('Görüşünüz').fill(`Sentetik katkıcı görüşü ${tag}`);
  await page.getByRole('button', { name: 'Görüş ekle' }).click();
  await expect(page.getByRole('list', { name: 'Görüşler' })).toContainText(`Sentetik katkıcı görüşü ${tag}`);
  await expect(page.getByRole('list', { name: 'Görüşler' })).toContainText(BT);
  await check(page, 'Katkıcı görünümü');
  await logout(page);

  // Portal (R13): yalnız seviye, risk skoru ve görünür aksiyonlar (başlık, tarih, durum); ölçüt, soru, görüş, sorumlu yok.
  await login(page, 'teklif.kuzey@example.test', 'Teklif davetleri');
  await page.goto('/portal/skorum');
  const riskPanel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Risk durumunuz' }) });
  await expect(riskPanel.getByText(/Seviye [1-5]/).first()).toBeVisible();
  await expect(riskPanel.getByRole('heading', { name: /Risk aksiyonları/ })).toBeVisible();
  const text = await riskPanel.innerText();
  for (const hidden of ['Kritiklik', 'kritiklik', 'Hizmetin İş Süreçlerine Etkisi', 'Test sorusu', 'Görüş', 'Sorumlu']) expect(text).not.toContain(hidden);
  expect(await page.locator('main').innerText()).not.toContain(`Sentetik katkıcı görüşü ${tag}`);
  await check(page, 'Portal risk');
});
