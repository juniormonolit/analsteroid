// Форматирование чисел раздела «Реализация» (ru-RU, неразрывные пробелы).
// Правило DS «Числа» (задача #8126, находка 15): минус — «−» (U+2212), деньги в
// таблицах — полные «31 970 000 ₽», крупные итоги (KPI) — «355,1 млн ₽» (1 знак).
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const DASH = '—';
const bad = (v: number | null | undefined): v is null | undefined => v === null || v === undefined || Number.isNaN(v);
/** Дефис-минус из Intl → типографский минус. */
const minus = (s: string) => s.replace(/^-/, '−');

export const fmtInt = (v: number | null | undefined) => (bad(v) ? DASH : minus(nf0.format(v)));
export const fmtRub = (v: number | null | undefined) => (bad(v) ? DASH : `${minus(nf0.format(Math.round(v)))} ₽`);
/** «355,1 млн ₽» — для KPI-плашек; меньше миллиона — полной суммой. */
export const fmtMlnRub = (v: number | null | undefined) => {
  if (bad(v)) return DASH;
  if (Math.abs(v) < 1e6) return fmtRub(v);
  return `${minus(nf1.format(v / 1e6))} млн ₽`;
};
export const fmt1 = (v: number | null | undefined) => (bad(v) ? DASH : minus(nf1.format(v)));
export const fmtPct = (v: number | null | undefined) => (bad(v) ? DASH : `${minus(nf1.format(v))} %`);
export function fmtDate(v: string | null | undefined): string {
  if (!v) return DASH;
  const s = v.length === 10 ? v : new Date(new Date(v).getTime() + 3 * 3600_000).toISOString();
  return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
}
export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return DASH;
  const s = new Date(new Date(v).getTime() + 3 * 3600_000).toISOString();
  return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(2, 4)} ${s.slice(11, 16)}`;
}
/**
 * Техническое имя из 1С/Битрикса → человеческое (находка 13):
 * «Менеджер2913 (Королькова)» → «Королькова (Менеджер2913)»; пустое/«- - 3404» → null.
 */
export function humanName(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  if (!s || /^[-\s\d]*$/.test(s)) return null;
  const m = s.match(/^([A-Za-zА-Яа-яЁё]+\d+)\s*\((.+)\)$/);
  if (m) return `${m[2].trim()} (${m[1]})`;
  return s;
}
