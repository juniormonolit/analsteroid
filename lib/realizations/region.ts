// Регион логиста. Первично — метка в ФИО из 1С: «Глимнурова Эльвина (СПБ) Л106».
// Если метки нет — по номеру логиста (правило префиксов логина): Логист0**/1** —
// СПб, 2** — Москва, 3** — Краснодар; короткие номера (Л1…Л9 = Логист01…09) — СПб.
export type Region = 'СПБ' | 'МСК' | 'КРД' | 'Без региона';
export const REGIONS: Region[] = ['СПБ', 'МСК', 'КРД', 'Без региона'];
export const REGION_LABEL: Record<Region, string> = { 'СПБ': 'Санкт-Петербург', 'МСК': 'Москва', 'КРД': 'Краснодар', 'Без региона': 'Без региона' };

export function regionOf(name: string | null | undefined): Region {
  if (!name) return 'Без региона';
  const label = name.match(/\((СПБ|МСК|КРД)\)/i);
  if (label) return label[1].toUpperCase() as Region;
  const code = name.match(/(?:^|\s)Л(\d+)\s*$/);
  if (!code) return 'Без региона';
  const digits = code[1];
  if (digits.length < 3) return 'СПБ';
  const first = digits[0];
  if (first === '0' || first === '1') return 'СПБ';
  if (first === '2') return 'МСК';
  if (first === '3') return 'КРД';
  return 'Без региона';
}
