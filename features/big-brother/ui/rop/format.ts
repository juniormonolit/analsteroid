// «Большой брат» — форматирование чисел для таблиц потока B.
const int = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

export const fmtInt = (v: number | null | undefined) => (v == null ? '—' : int.format(v));
export const fmtOne = (v: number | null | undefined) => (v == null ? '—' : one.format(v));
export const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${one.format(v * 100)}%`);
/** Деньги компактно: 1,2 млн / 350 тыс. */
export function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${one.format(v / 1e6)} млн`;
  if (a >= 1e3) return `${int.format(v / 1e3)} тыс`;
  return int.format(v);
}
export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' }) : '—';
