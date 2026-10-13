// «Дашборд тест» — общее для сервера и страницы: периоды «Неделя / Месяц / Год».
// Только чистые функции над датами-строками ГГГГ-ММ-ДД (день по Москве), без БД и React.

export type DashPeriod = 'week' | 'month' | 'year';
export const DASH_PERIODS: DashPeriod[] = ['week', 'month', 'year'];
export function isDashPeriod(v: unknown): v is DashPeriod {
  return v === 'week' || v === 'month' || v === 'year';
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s: string) => new Date(`${s}T00:00:00Z`);

export function addDays(day: string, n: number): string {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

/** Границы периода (обе включительно). offset: 0 — текущий, 1 — предыдущий и т.д.
 *  Неделя — с понедельника по воскресенье, месяц и год — календарные. */
export function periodRange(period: DashPeriod, offset: number, today: string): { from: string; to: string } {
  const t = parse(today);
  if (period === 'week') {
    const dow = (t.getUTCDay() + 6) % 7; // 0 — понедельник
    const from = addDays(today, -dow - 7 * offset);
    return { from, to: addDays(from, 6) };
  }
  if (period === 'month') {
    const total = t.getUTCFullYear() * 12 + t.getUTCMonth() - offset;
    const y = Math.floor(total / 12), m = total % 12;
    return { from: `${y}-${pad(m + 1)}-01`, to: ymd(new Date(Date.UTC(y, m + 1, 0))) };
  }
  const y = t.getUTCFullYear() - offset;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

/** На сколько периодов назад можно уйти, чтобы период ещё задевал первый день с данными. */
export function maxPeriodOffset(period: DashPeriod, today: string, earliest: string): number {
  const cap = period === 'week' ? 520 : period === 'month' ? 120 : 10;
  let n = 0;
  while (n < cap && periodRange(period, n + 1, today).to >= earliest) n++;
  return n;
}

/** В режиме «Год» январь считается с 10 января — в обоих сравниваемых годах (решение владельца
 *  10.10: «январь по году считай всегда с 10 января»; 1–9 января — праздники, сделок почти нет, и
 *  они только искажают январь и итог года). Неделя и месяц считают январь целиком. */
export const YEAR_START_MD = '01-10';
/** Входит ли день (ГГГГ-ММ-ДД) в счёт года. */
export const countsInYear = (day: string) => day.slice(5) >= YEAR_START_MD;

export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/** Подпись периода: «5–11 октября 2026», «28 сентября – 4 октября 2026», «Октябрь 2026», «2026». */
export function periodLabel(period: DashPeriod, from: string, to: string): string {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (period === 'year') return String(fy);
  if (period === 'month') return `${MONTHS_NOM[fm - 1]} ${fy}`;
  if (fy !== ty) return `${fd} ${MONTHS_GEN[fm - 1]} ${fy} – ${td} ${MONTHS_GEN[tm - 1]} ${ty}`;
  if (fm !== tm) return `${fd} ${MONTHS_GEN[fm - 1]} – ${td} ${MONTHS_GEN[tm - 1]} ${ty}`;
  return `${fd}–${td} ${MONTHS_GEN[fm - 1]} ${ty}`;
}

/** Столбцы графика: дни периода (неделя, месяц) или месяцы года. key — ГГГГ-ММ-ДД или ГГГГ-ММ. */
export function periodBuckets(period: DashPeriod, from: string, to: string): string[] {
  const out: string[] = [];
  if (period === 'year') {
    const y = from.slice(0, 4);
    for (let m = 1; m <= 12; m++) out.push(`${y}-${pad(m)}`);
    return out;
  }
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** День недели дня: 0 — понедельник … 6 — воскресенье. */
export function weekdayIndex(day: string): number {
  return (parse(day).getUTCDay() + 6) % 7;
}

/** Понедельник недели, в которую попадает день. */
export function mondayOf(day: string): string {
  return addDays(day, -weekdayIndex(day));
}

/** Разница a − b в днях. */
export function diffDays(a: string, b: string): number {
  return Math.round((parse(a).getTime() - parse(b).getTime()) / 86_400_000);
}

/** Месяц «ГГГГ-ММ», сдвинутый на n месяцев. */
export function addMonths(ym: string, n: number): string {
  const total = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** Обратное к periodRange: на сколько периодов назад от текущего лежит период с этим днём
 *  (0 — текущий; отрицательное — период в будущем). */
export function offsetOfDay(period: DashPeriod, day: string, today: string): number {
  if (period === 'week') return diffDays(mondayOf(today), mondayOf(day)) / 7;
  const months = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
  if (period === 'month') return months(today) - months(day);
  return Number(today.slice(0, 4)) - Number(day.slice(0, 4));
}
