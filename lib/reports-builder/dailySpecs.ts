// Сборка ReportSpec для ежедневных отчётов бота «Аналитик» — «МОСКВА» и
// «КОВАЛЕНКО» (шаг 6 спеки REPORT_CONSTRUCTOR_SPEC.md: три реализации одного
// формата схлопываются в одну).
//
// Модуль чистый и БЕЗ импортов БД. Это не аккуратность ради аккуратности:
// scripts/assert-report-engine.ts импортирует именно его и сравнивает результат
// с дословными копиями старых рендереров. Значит тест проверяет ТОТ САМЫЙ код,
// который исполняется в проде, а не свою параллельную сборку спеки — иначе
// прод и тест могли бы разойтись, а тест остался бы зелёным.
//
// Разница между двумя отчётами — ровно пять параметров ниже. Раньше это были два
// файла по 430 строк, отличавшиеся, среди прочего, точностью процентов, и заметить
// это можно было только чтением обоих целиком.

import { TOTAL, type ReportMetric, type ReportSpec } from '@/features/reports-builder/engine/buildReportText';
import type { MetricValue } from '@/features/reports-builder/engine/format';

/** Суммы по ключу сущности + TOTAL. */
export type Sums = Record<string, number>;

export interface ConversionRow {
  primaryDeals: number;
  primaryReservations: number;
  primarySales: number;
  repeatSales: number;
  ppp: number;
}

export interface DailyReportNumbers {
  dateStr: string;
  entities: { key: string; title: string }[];
  factSales: { day: Sums; week: Sums; month: Sums };
  factShipMonth: Sums;
  /** Плановые окна: день, неделя и месяц — ТЕМП (план на прошедшие рабочие дни). */
  planSales: { day: Sums; week: Sums; mtd: Sums };
  planShipMtd: Sums;
  /** Конверсии за месяц по ПЕРВИЧНЫМ сделкам. */
  conv: Record<string, ConversionRow>;
}

export interface DailySpecConfig {
  /** «Отчет МОСКВА» / «Отчет КОВАЛЕНКО». */
  title: string;
  /** «за 05.08.2026» или «Вторник, 05.08.2026» (просьба владельца отдела). */
  subtitle: 'za' | 'weekday';
  /** % выполнения плана: МОСКВА — целые (87%), КОВАЛЕНКО — с десятой (87,3%). */
  planPctFormat: 'pct0' | 'pct1';
  /** Блоки по каждой сущности (МОСКВА) или только итог (КОВАЛЕНКО). */
  entityBlocks: boolean;
  /** «ИТОГО (ОС+НЦ+ЖБИ)» / «ОБЩЕСТРОЙ». */
  aggregateTitle: string;
  /** Суммы итога: млн или рубли (как в ручном отчёте владельца отдела). */
  aggregateMoney: 'mln' | 'rub';
}

const PERIOD_TITLES = { day: 'ДЕНЬ', week: 'НЕДЕЛЯ', month: 'МЕСЯЦ' } as const;

const CONVERSIONS: { label: string; num: (r: ConversionRow) => number; den: (r: ConversionRow) => number }[] = [
  { label: 'Конверсия в бронь (месяц)', num: r => r.primaryReservations, den: r => r.primaryDeals },
  { label: 'Конверсия в продажу (месяц)', num: r => r.primarySales, den: r => r.primaryDeals },
  { label: 'Конверсия ППП (месяц)', num: r => r.ppp, den: r => r.primarySales },
  { label: '% повторных продаж (месяц)', num: r => r.repeatSales, den: r => r.primarySales + r.repeatSales },
];

function keysOf(n: DailyReportNumbers): string[] {
  return [...n.entities.map(e => e.key), TOTAL];
}

function ratioValues(keys: string[], fact: Sums, plan: Sums): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {};
  for (const k of keys) out[k] = { num: fact[k] ?? 0, den: plan[k] ?? 0 };
  return out;
}

function numberValues(keys: string[], sums: Sums): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {};
  for (const k of keys) out[k] = sums[k] ?? 0;
  return out;
}

function convValues(
  keys: string[],
  conv: Record<string, ConversionRow>,
  num: (r: ConversionRow) => number,
  den: (r: ConversionRow) => number,
): Record<string, MetricValue> {
  const zero: ConversionRow = { primaryDeals: 0, primaryReservations: 0, primarySales: 0, repeatSales: 0, ppp: 0 };
  const out: Record<string, MetricValue> = {};
  for (const k of keys) {
    const row = conv[k] ?? zero;
    out[k] = { num: num(row), den: den(row) };
  }
  return out;
}

/** Шесть строк блока: план/факт/% продаж, пустая строка, то же по отгрузкам. */
function planFactMetrics(
  keys: string[],
  n: DailyReportNumbers,
  money: 'mln' | 'rub',
  pct: 'pct0' | 'pct1',
): ReportMetric[] {
  return [
    { label: 'План продаж', format: money, values: numberValues(keys, n.planSales.mtd) },
    { label: 'Сумма продаж', format: money, values: numberValues(keys, n.factSales.month) },
    { label: '% выполнения', format: pct, values: ratioValues(keys, n.factSales.month, n.planSales.mtd) },
    { label: 'План отгрузок', format: money, gapBefore: true, values: numberValues(keys, n.planShipMtd) },
    { label: 'Сумма отгрузок', format: money, values: numberValues(keys, n.factShipMonth) },
    { label: '% выполнения', format: pct, values: ratioValues(keys, n.factShipMonth, n.planShipMtd) },
  ];
}

export function buildDailyReportSpec(n: DailyReportNumbers, cfg: DailySpecConfig): ReportSpec {
  const keys = keysOf(n);

  const planPct: ReportMetric[] = ([
    ['day', n.planSales.day, n.factSales.day],
    ['week', n.planSales.week, n.factSales.week],
    ['month', n.planSales.mtd, n.factSales.month],
  ] as const).map(([period, plan, fact]) => ({
    label: `% ПЛАНА (${PERIOD_TITLES[period]})`,
    format: cfg.planPctFormat,
    values: ratioValues(keys, fact, plan),
  }));

  const conversions: ReportMetric[] = CONVERSIONS.map(c => ({
    label: c.label,
    format: 'pct1',
    values: convValues(keys, n.conv, c.num, c.den),
  }));

  return {
    title: cfg.title,
    subtitle: cfg.subtitle === 'weekday'
      ? { style: 'weekday', date: n.dateStr }
      : { style: 'za', date: n.dateStr },
    entities: n.entities,
    overview: [planPct, conversions],
    entityBlock: cfg.entityBlocks ? planFactMetrics(keys, n, 'mln', cfg.planPctFormat) : [],
    aggregate: {
      title: cfg.aggregateTitle,
      metrics: planFactMetrics(keys, n, cfg.aggregateMoney, cfg.planPctFormat),
    },
  };
}
