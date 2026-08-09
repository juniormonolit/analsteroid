import type { CalendarUnit } from '@/lib/period';

// Арифметика и подписи бакетов отчёта «По периодам» (задача владельца 09.08).
//
// Отдельный ЧИСТЫЙ модуль (без импортов БД) сознательно: те же функции нужны и
// движку на сервере (features/reports/engine/byPeriods.ts), и странице отчёта в
// браузере (границы бакета для дрилл-дауна). Держать их в движке нельзя — он
// тянет пул Postgres, и такой импорт утащил бы `pg` в клиентский бандл.
//
// Ключ бакета — МСК-календарная дата его НАЧАЛА в виде 'YYYY-MM-DD' (ровно то,
// что отдаёт `to_char(date_trunc(...))` в SQL движка). Вся арифметика — на
// UTC-датах этих строк: время суток в ключе не участвует, поэтому переходов
// через DST здесь нет по построению.

export function ymdToUtc(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function utcToYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Начало бакета, которому принадлежит календарная дата. */
export function bucketStartOf(ymd: string, unit: CalendarUnit): string {
  const d = ymdToUtc(ymd);
  switch (unit) {
    case 'day':
      return ymd;
    case 'week': {
      const dow = (d.getUTCDay() + 6) % 7; // 0 = понедельник, как date_trunc('week') в PG
      d.setUTCDate(d.getUTCDate() - dow);
      return utcToYmd(d);
    }
    case 'month':
      return `${ymd.slice(0, 7)}-01`;
    case 'quarter': {
      const q = Math.floor(d.getUTCMonth() / 3) * 3;
      return `${d.getUTCFullYear()}-${String(q + 1).padStart(2, '0')}-01`;
    }
    case 'year':
      return `${ymd.slice(0, 4)}-01-01`;
  }
}

/** Следующий бакет (для непрерывной шкалы и правой границы окна). */
export function nextBucket(ymd: string, unit: CalendarUnit): string {
  const d = ymdToUtc(ymd);
  switch (unit) {
    case 'day':     d.setUTCDate(d.getUTCDate() + 1); break;
    case 'week':    d.setUTCDate(d.getUTCDate() + 7); break;
    case 'month':   d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'quarter': d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'year':    d.setUTCFullYear(d.getUTCFullYear() + 1); break;
  }
  return utcToYmd(d);
}

/** Предыдущий бакет — база сравнения «к предыдущему периоду». */
export function prevBucket(ymd: string, unit: CalendarUnit): string {
  const d = ymdToUtc(ymd);
  switch (unit) {
    case 'day':     d.setUTCDate(d.getUTCDate() - 1); break;
    case 'week':    d.setUTCDate(d.getUTCDate() - 7); break;
    case 'month':   d.setUTCMonth(d.getUTCMonth() - 1); break;
    case 'quarter': d.setUTCMonth(d.getUTCMonth() - 3); break;
    case 'year':    d.setUTCFullYear(d.getUTCFullYear() - 1); break;
  }
  return utcToYmd(d);
}

/** Тот же бакет годом раньше — база сравнения «к прошлому году» (LFL).
 *
 *  Для дня/месяца/квартала/года — календарный сдвиг на год: «9 августа 2026»
 *  против «9 августа 2025», как человек и ожидает. Для НЕДЕЛИ календарный год
 *  не годится: «понедельник минус год» — это середина недели, такого бакета не
 *  существует. Поэтому неделя сдвигается на 52 недели (364 дня) — понедельник
 *  против понедельника, как LFL считают в рознице. Расплата известна и
 *  осознанна: за 5–6 лет накапливается сдвиг в неделю относительно календаря. */
export function yoyBucket(ymd: string, unit: CalendarUnit): string {
  const d = ymdToUtc(ymd);
  if (unit === 'week') {
    d.setUTCDate(d.getUTCDate() - 364);
    return utcToYmd(d);
  }
  const month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  // 29 февраля високосного года: setUTCFullYear переносит дату на 1 марта, и тогда
  // 29.02 и 01.03 схлопнулись бы в ОДИН бакет сравнения (одно значение на две
  // строки, а 28.02 не сравнивался бы ни с чем). Прижимаем к последнему дню того
  // же месяца — 28 февраля (поймано assert-скриптом на 2028-02-29).
  if (d.getUTCMonth() !== month) d.setUTCDate(0);
  return bucketStartOf(utcToYmd(d), unit);
}

/** Ключ базы сравнения для бакета; null — сравнение выключено. */
export function comparisonBucketOf(
  ymd: string, unit: CalendarUnit, mode: 'prev' | 'yoy' | 'none',
): string | null {
  if (mode === 'none') return null;
  return mode === 'prev' ? prevBucket(ymd, unit) : yoyBucket(ymd, unit);
}

const MONTHS_RU = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const WEEKDAYS_RU = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const ROMAN_Q = ['I', 'II', 'III', 'IV'];

/** Номер ISO-недели (для подписи «нед. 32»). */
function isoWeekNumber(ymd: string): number {
  const d = ymdToUtc(ymd);
  // Четверг той же недели определяет её год и номер (ISO 8601).
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const jan4Thu = new Date(jan4);
  jan4Thu.setUTCDate(jan4.getUTCDate() + 3 - ((jan4.getUTCDay() + 6) % 7));
  return 1 + Math.round((d.getTime() - jan4Thu.getTime()) / (7 * 86_400_000));
}

const dm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;

/** Человеческая подпись бакета (одна на таблицу, экспорты и подписи сравнения). */
export function bucketLabel(ymd: string, unit: CalendarUnit): string {
  const d = ymdToUtc(ymd);
  switch (unit) {
    case 'day':
      return `${dm(ymd)}.${ymd.slice(0, 4)}`;
    case 'week': {
      const end = ymdToUtc(nextBucket(ymd, 'week'));
      end.setUTCDate(end.getUTCDate() - 1);
      return `${dm(ymd)} – ${dm(utcToYmd(end))}.${end.getUTCFullYear()}`;
    }
    case 'month':
      return `${MONTHS_RU[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    case 'quarter':
      return `${ROMAN_Q[Math.floor(d.getUTCMonth() / 3)]} кв. ${d.getUTCFullYear()}`;
    case 'year':
      return String(d.getUTCFullYear());
  }
}

/** Уточнение под подписью: день недели / номер недели / ничего. */
export function bucketSubtitle(ymd: string, unit: CalendarUnit): string | undefined {
  if (unit === 'day') return WEEKDAYS_RU[(ymdToUtc(ymd).getUTCDay() + 6) % 7];
  if (unit === 'week') return `нед. ${isoWeekNumber(ymd)}`;
  return undefined;
}

/** Границы бакета как локальный DateRange (для запросов дрилл-дауна с клиента).
 *  Полдень внутри дня — чтобы календарная дата не съезжала на сутки в поясах
 *  западнее UTC (тот же приём, что periodDateStr в lib/period). */
export function bucketRange(ymd: string, unit: CalendarUnit): { from: Date; to: Date } {
  const startYmd = bucketStartOf(ymd, unit);
  const endYmd = nextBucket(startYmd, unit); // первый день СЛЕДУЮЩЕГО бакета
  const [fy, fm, fd] = startYmd.split('-').map(Number);
  const [ty, tm, td] = endYmd.split('-').map(Number);
  return {
    from: new Date(fy, fm - 1, fd, 0, 0, 0, 0),
    to: new Date(ty, tm - 1, td - 1, 23, 59, 59, 999),
  };
}
