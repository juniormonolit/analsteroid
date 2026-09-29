// Форматирование чисел раздела «Реализация» (ru-RU, неразрывные пробелы).
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const DASH = '—';
export const fmtInt = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? DASH : nf0.format(v));
export const fmtRub = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? DASH : `${nf0.format(Math.round(v))} ₽`);
export const fmtMln = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? DASH : nf2.format(v / 1e6));
export const fmt1 = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? DASH : nf1.format(v));
export const fmtPct = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? DASH : `${nf1.format(v)}%`);
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
