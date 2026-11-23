// Повторы регулярных собраний — чистые функции без БД (клиент и сервер).
// Вхождения разворачиваются на лету: серия хранится одной строкой (миграция 278).
// Даты — YYYY-MM-DD по МСК, время — HH:MM по МСК; дни недели ISO (1 = пн … 7 = вс).
import type { TaskerRecurrence } from '../../types';

const DAY_MS = 86_400_000;
const toMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const toYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number) => toYmd(toMs(ymd) + n * DAY_MS);
/** ISO день недели: 1 = пн … 7 = вс. */
export const isoDow = (ymd: string) => ((new Date(toMs(ymd)).getUTCDay() + 6) % 7) + 1;
const mondayOf = (ymd: string) => addDays(ymd, 1 - isoDow(ymd));
const daysInMonth = (ymd: string) => {
  const [y, m] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export const DOW_SHORT = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const DOW_ACC = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];
const DOW_NOM = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
/** «каждый понедельник», «каждую среду», «каждое воскресенье». */
const EVERY = ['', 'каждый', 'каждый', 'каждую', 'каждый', 'каждую', 'каждую', 'каждое'];
/** «2-й вторник», «2-я среда», «последнее воскресенье» — род по дню недели. */
const GENDER = ['', 'm', 'm', 'f', 'm', 'f', 'f', 'n'] as const;
const NTH = (n: number, dow: number) => {
  const g = GENDER[dow];
  if (n === -1) return g === 'f' ? 'последняя' : g === 'n' ? 'последнее' : 'последний';
  return `${n}-${g === 'f' ? 'я' : g === 'n' ? 'е' : 'й'}`;
};

export interface SeriesShape {
  startDate: string;
  untilDate: string | null;
  recurrence: TaskerRecurrence;
}

/** Попадает ли день в правило (без учёта начала/конца серии и чётности недель). */
function ruleHits(r: TaskerRecurrence, ymd: string): boolean {
  const dow = isoDow(ymd);
  switch (r.kind) {
    case 'weekdays': return dow <= 5;
    case 'weekly':
    case 'biweekly': return r.days.includes(dow);
    case 'monthly_day': return Number(ymd.slice(8, 10)) === r.day;
    case 'monthly_nth': {
      if (dow !== r.weekday) return false;
      const d = Number(ymd.slice(8, 10));
      return r.nth === -1 ? d + 7 > daysInMonth(ymd) : Math.ceil(d / 7) === r.nth;
    }
  }
}

/** Первое вхождение серии (≥ даты начала) — от него же считается чётность «раз в 2 недели». */
export function firstOccurrence(s: SeriesShape): string | null {
  for (let i = 0, d = s.startDate; i < 400; i++, d = addDays(d, 1)) {
    if (s.untilDate && d > s.untilDate) return null;
    if (ruleHits(s.recurrence, d)) return d;
  }
  return null;
}

/** Все вхождения серии в окне [from; to] (включительно). */
export function expandDates(s: SeriesShape, from: string, to: string): string[] {
  const first = firstOccurrence(s);
  if (!first) return [];
  const start = from > first ? from : first;
  const end = s.untilDate && s.untilDate < to ? s.untilDate : to;
  const anchorMon = toMs(mondayOf(first));
  const out: string[] = [];
  for (let d = start, guard = 0; d <= end && guard < 800; d = addDays(d, 1), guard++) {
    if (!ruleHits(s.recurrence, d)) continue;
    if (s.recurrence.kind === 'biweekly') {
      const weeks = Math.round((toMs(mondayOf(d)) - anchorMon) / (7 * DAY_MS));
      if (weeks % 2 !== 0) continue;
    }
    out.push(d);
  }
  return out;
}

/** Ближайшие n вхождений начиная с from. */
export function nextDates(s: SeriesShape, from: string, n: number): string[] {
  const out: string[] = [];
  let cur = from;
  for (let i = 0; i < 8 && out.length < n; i++) {
    const chunk = expandDates(s, cur, addDays(cur, 120));
    out.push(...chunk);
    cur = addDays(cur, 121);
  }
  return out.slice(0, n);
}

/** ISO начала вхождения: дата + время по МСК. */
export function occurrenceStart(ymd: string, time: string): string {
  return new Date(`${ymd}T${time.slice(0, 5)}:00+03:00`).toISOString();
}

export function recurrenceLabel(r: TaskerRecurrence, time?: string): string {
  const at = time ? ` в ${time.slice(0, 5)}` : '';
  const days = (ds: number[]) => [...ds].sort((a, b) => a - b).map(d => DOW_SHORT[d]).join(', ');
  switch (r.kind) {
    case 'weekdays': return `по будням${at}`;
    case 'weekly': return r.days.length === 1 ? `${EVERY[r.days[0]]} ${DOW_ACC[r.days[0]]}${at}` : `еженедельно: ${days(r.days)}${at}`;
    case 'biweekly': return `раз в 2 недели: ${days(r.days)}${at}`;
    case 'monthly_day': return `ежемесячно ${r.day}-го числа${at}`;
    case 'monthly_nth': return `${NTH(r.nth, r.weekday)} ${DOW_NOM[r.weekday]} месяца${at}`;
  }
}

/** Проверка и нормализация правила из запроса. Бросает Error с понятным текстом. */
export function normalizeRecurrence(raw: unknown): TaskerRecurrence {
  const r = (raw ?? {}) as Record<string, unknown>;
  const days = (v: unknown) => {
    const list = Array.isArray(v) ? [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 7))].sort() : [];
    if (!list.length) throw new Error('Выберите хотя бы один день недели');
    return list;
  };
  switch (r.kind) {
    case 'weekdays': return { kind: 'weekdays' };
    case 'weekly': return { kind: 'weekly', days: days(r.days) };
    case 'biweekly': return { kind: 'biweekly', days: days(r.days) };
    case 'monthly_day': {
      const day = Number(r.day);
      if (!Number.isInteger(day) || day < 1 || day > 28) throw new Error('Число месяца — от 1 до 28 (29–31 есть не в каждом месяце)');
      return { kind: 'monthly_day', day };
    }
    case 'monthly_nth': {
      const nth = Number(r.nth);
      const weekday = Number(r.weekday);
      if (![1, 2, 3, 4, -1].includes(nth)) throw new Error('Неделя месяца — 1–4 или «последний»');
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new Error('Не выбран день недели');
      return { kind: 'monthly_nth', nth: nth as 1 | 2 | 3 | 4 | -1, weekday };
    }
    default: throw new Error('Не выбран повтор');
  }
}

const BX_DOW = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/**
 * Правило для calendar.event.add/update. null — Битрикс его через REST не умеет (n-й день недели месяца:
 * BYDAY с номером и BYSETPOS молча отбрасываются — проверено 23.11) → событие «скользящее».
 */
export function toBitrixRrule(r: TaskerRecurrence, untilDate: string | null): Record<string, unknown> | null {
  const until = untilDate ? { UNTIL: untilDate } : {};
  switch (r.kind) {
    case 'weekdays': return { FREQ: 'WEEKLY', INTERVAL: 1, BYDAY: ['MO', 'TU', 'WE', 'TH', 'FR'], ...until };
    case 'weekly': return { FREQ: 'WEEKLY', INTERVAL: 1, BYDAY: r.days.map(d => BX_DOW[d]), ...until };
    case 'biweekly': return { FREQ: 'WEEKLY', INTERVAL: 2, BYDAY: r.days.map(d => BX_DOW[d]), ...until };
    case 'monthly_day': return { FREQ: 'MONTHLY', INTERVAL: 1, BYMONTHDAY: r.day, ...until };
    case 'monthly_nth': return null;
  }
}
