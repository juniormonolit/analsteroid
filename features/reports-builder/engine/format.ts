// Форматирование значений отчётов — ЕДИНСТВЕННЫЙ источник правды.
//
// До появления движка одни и те же fmtMln/fmtPct/fmtDateRu жили в трёх файлах
// (lib/jobs/dailyMoscowReport, lib/jobs/dailyGroupReport,
// features/manager-card/engine/managerReportText) и уже разошлись: «% выполнения»
// в отчёте МОСКВА целый (87%), в отчёте КОВАЛЕНКО — с десятой (87,3%). Разница
// не случайная (в ручном отчёте владельца отдела так и было), но раньше она
// жила как «в этом файле другая функция» — здесь это ЯВНЫЙ формат pct0/pct1.
//
// Файл намеренно без импортов: движок должен запускаться и в Next, и напрямую
// через node --experimental-strip-types (см. scripts/assert-report-engine.ts).

/** Прочерк вместо значения: нет плана, нет знаменателя, нет данных. */
export const DASH = '—';

export type ValueFormat =
  /** 11,3 млн */
  | 'mln'
  /** 11,30 млн — две десятых, для сверок и расхождений */
  | 'mln2'
  /** 1 234 567 ₽ */
  | 'rub'
  /** авто: млн / тыс / ₽ по величине — личный отчёт менеджера */
  | 'money'
  /** 87% — считается из доли {num, den} */
  | 'pct0'
  /** 87,3% — считается из доли {num, den} */
  | 'pct1'
  /** 87% — процент уже посчитан (так отдаёт каталог метрик) */
  | 'pctv0'
  /** 87,3% — процент уже посчитан */
  | 'pctv1'
  /** 12 */
  | 'count'
  /** 12,3 */
  | 'dec1'
  /** 12,34 */
  | 'dec2';

/**
 * Доля, из которой считается процент. Знаменатель отдельным полем, а не
 * готовым числом, потому что «нет плана» и «план не выполнен» — разные вещи:
 * den <= 0 даёт прочерк, а не 0% и не Infinity.
 */
export interface Ratio {
  num: number;
  den: number | null;
}

export type MetricValue = number | Ratio | null;

export function isRatio(v: MetricValue): v is Ratio {
  return typeof v === 'object' && v !== null && 'num' in v;
}

// ── Числа ──────────────────────────────────────────────────────────────────────────

/** Десятичная запятая вместо точки — во всех отчётах владельца так. */
function comma(v: number, decimals: number): string {
  return v.toFixed(decimals).replace('.', ',');
}

export function fmtMln(v: number, decimals = 1): string {
  return `${comma(v / 1e6, decimals)} млн`;
}

export function fmtRub(v: number): string {
  // toLocaleString('ru-RU') разделяет разряды неразрывным пробелом (U+00A0);
  // в чате Битрикса он ведёт себя непредсказуемо при переносе — меняем на обычный.
  return `${Math.round(v).toLocaleString('ru-RU').replace(/\u00A0/g, ' ')} ₽`;
}

/** Личный отчёт: мелкие суммы в млн выглядят как «0,0 млн», поэтому шкала. */
export function fmtMoney(v: number): string {
  if (Math.abs(v) >= 1_000_000) return fmtMln(v);
  if (Math.abs(v) >= 1_000) return `${Math.round(v / 1000)} тыс`;
  return `${Math.round(v)} ₽`;
}

export function fmtPct0(num: number, den: number | null): string {
  if (den === null || den <= 0) return DASH;
  return `${Math.round((num / den) * 100)}%`;
}

export function fmtPct1(num: number, den: number | null): string {
  if (den === null || den <= 0) return DASH;
  return `${comma((num / den) * 100, 1)}%`;
}

/** Готовый процент (уже посчитан снаружи), например repeatSharePct. */
export function fmtPct1Value(v: number | null): string {
  return v === null ? DASH : `${comma(v, 1)}%`;
}

export function formatValue(value: MetricValue, format: ValueFormat): string {
  if (format === 'pct0' || format === 'pct1') {
    // Доля обязана прийти знаменателем: «нет плана» и «план не выполнен» —
    // разные ответы, и различить их можно только по den.
    if (!isRatio(value)) return DASH;
    return format === 'pct0' ? fmtPct0(value.num, value.den) : fmtPct1(value.num, value.den);
  }
  if (value === null) return DASH;
  const n = isRatio(value) ? value.num : value;
  switch (format) {
    case 'mln': return fmtMln(n);
    case 'mln2': return fmtMln(n, 2);
    case 'rub': return fmtRub(n);
    case 'money': return fmtMoney(n);
    case 'pctv0': return `${Math.round(n)}%`;
    case 'pctv1': return fmtPct1Value(n);
    case 'count': return String(Math.round(n));
    case 'dec1': return comma(n, 1);
    case 'dec2': return comma(n, 2);
  }
}

// ── Даты ───────────────────────────────────────────────────────────────────────────

/** YYYY-MM-DD → DD.MM.YYYY */
export function fmtDateRu(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

export function weekdayRu(dateStr: string): string {
  return WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}
