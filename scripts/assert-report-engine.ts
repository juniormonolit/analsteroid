/**
 * Assert-скрипт: движок конструктора отчётов воспроизводит три существующих
 * формата БАЙТ-В-БАЙТ (шаг 1 спеки ai_docs/fresh_docs/REPORT_CONSTRUCTOR_SPEC.md).
 *
 * Как устроена проверка. Эталоны — ДОСЛОВНЫЕ КОПИИ старых рендереров, вклеенные
 * ниже (блок «ЭТАЛОНЫ»). Копии, а не импорт, потому что оригиналы лежат внутри
 * async-модулей, которые тянут пул Postgres и вебхук Битрикса: подключиться к
 * ним из assert-скрипта нельзя, а формат проверять надо. Копии помечены
 * источником и правятся только вместе с оригиналом — до шага 4 спеки, когда
 * ботовские джобы переедут на движок и оригиналы исчезнут совсем.
 *
 * Числа синтетические и намеренно злые: нулевые планы (должен быть прочерк, а
 * не 0% и не Infinity), нулевые знаменатели конверсий, отрицательные суммы,
 * миллионы с разделителями разрядов, значения на границе округления.
 *
 * Запуск: node --import ./scripts/ts-resolve-register.mjs scripts/assert-report-engine.ts
 */
import {
  buildReportDocument, buildReportText, TOTAL,
  type ReportMetric, type ReportEntity,
} from '../features/reports-builder/engine/buildReportText.ts';
import {
  buildAnimationPlan, renderPlanAt, renderPlanFull, TIMING,
} from '../features/reports-builder/engine/animation.ts';
import {
  buildPersonalReportText,
  type PersonalBucket, type PersonalReportInput,
} from '../features/reports-builder/engine/personalReport.ts';

let failures = 0;
let passed = 0;

function check(cond: boolean, label: string) {
  if (cond) { passed++; return; }
  failures++;
  console.error(`FAIL ${label}`);
}

function eqText(actual: string, expected: string, label: string) {
  if (actual === expected) { passed++; return; }
  failures++;
  console.error(`\nFAIL ${label}`);
  const a = actual.split('\n');
  const e = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) {
      console.error(`  строка ${i + 1}`);
      console.error(`    эталон: ${JSON.stringify(e[i] ?? null)}`);
      console.error(`    движок: ${JSON.stringify(a[i] ?? null)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ЭТАЛОНЫ — дословные копии рендереров (не рефакторить, это снимок формата)
// ═══════════════════════════════════════════════════════════════════════════════

// ── из lib/jobs/dailyMoscowReport.ts ───────────────────────────────────────────
function fmtMln(v: number, decimals = 1): string {
  return `${(v / 1e6).toFixed(decimals).replace('.', ',')} млн`;
}
function fmtPctInt(fact: number, plan: number): string {
  if (plan <= 0) return '—';
  return `${Math.round((fact / plan) * 100)}%`;
}
function fmtPct1(numerator: number, denominator: number): string {
  if (denominator <= 0) return '—';
  return `${((numerator / denominator) * 100).toFixed(1).replace('.', ',')}%`;
}
function fmtDateRu(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}
const DEPTS = ['ОС', 'НЦ', 'ЖБИ'] as const;
type Dept = (typeof DEPTS)[number];
const DEPT_TITLES: Record<Dept, string> = { 'ОС': 'Общестрой', 'НЦ': 'Нулевой', 'ЖБИ': 'ЖБИ' };
type DeptSums = Record<Dept | 'total', number>;
interface ConversionRow {
  primaryDeals: number; primaryReservations: number;
  primarySales: number; repeatSales: number; ppp: number;
}
type Conversions = Record<Dept | 'total', ConversionRow>;

function mskPlanPercentSection(title: string, fact: DeptSums, plan: DeptSums): string {
  const lines = [`[b]% ПЛАНА (${title}) — ${fmtPctInt(fact.total, plan.total)}[/b]`];
  for (const cat of DEPTS) lines.push(`${DEPT_TITLES[cat]} — ${fmtPctInt(fact[cat], plan[cat])}`);
  return lines.join('\n');
}
function mskConversionSection(title: string, conv: Conversions, num: (r: ConversionRow) => number, den: (r: ConversionRow) => number): string {
  const lines = [`[b]${title} — ${fmtPct1(num(conv.total), den(conv.total))}[/b]`];
  for (const cat of DEPTS) lines.push(`${DEPT_TITLES[cat]} — ${fmtPct1(num(conv[cat]), den(conv[cat]))}`);
  return lines.join('\n');
}
function mskDeptBlock(title: string, planSales: number, factSales: number, planShip: number, factShip: number): string {
  return [
    `[b]${title}[/b]`,
    `План продаж — ${fmtMln(planSales)}`,
    `Сумма продаж — ${fmtMln(factSales)}`,
    `% выполнения — ${fmtPctInt(factSales, planSales)}`,
    '',
    `План отгрузок — ${fmtMln(planShip)}`,
    `Сумма отгрузок — ${fmtMln(factShip)}`,
    `% выполнения — ${fmtPctInt(factShip, planShip)}`,
  ].join('\n');
}

interface MoscowInput {
  dateStr: string;
  factSales: { day: DeptSums; week: DeptSums; month: DeptSums };
  factShipMonth: DeptSums;
  planSales: { day: DeptSums; week: DeptSums; mtd: DeptSums };
  planShipMtd: DeptSums;
  conv: Conversions;
}

function legacyMoscow(i: MoscowInput): string {
  return [
    [
      `[b]Отчет МОСКВА[/b]\n[i]за ${fmtDateRu(i.dateStr)}[/i]`,
      mskPlanPercentSection('ДЕНЬ', i.factSales.day, i.planSales.day),
      mskPlanPercentSection('НЕДЕЛЯ', i.factSales.week, i.planSales.week),
      mskPlanPercentSection('МЕСЯЦ', i.factSales.month, i.planSales.mtd),
    ].join('\n\n'),
    [
      mskConversionSection('Конверсия в бронь (месяц)', i.conv, r => r.primaryReservations, r => r.primaryDeals),
      mskConversionSection('Конверсия в продажу (месяц)', i.conv, r => r.primarySales, r => r.primaryDeals),
      mskConversionSection('Конверсия ППП (месяц)', i.conv, r => r.ppp, r => r.primarySales),
      mskConversionSection('% повторных продаж (месяц)', i.conv, r => r.repeatSales, r => r.primarySales + r.repeatSales),
    ].join('\n\n'),
    DEPTS.map(cat => mskDeptBlock(
      DEPT_TITLES[cat].toUpperCase(),
      i.planSales.mtd[cat], i.factSales.month[cat],
      i.planShipMtd[cat], i.factShipMonth[cat],
    )).join('\n\n'),
    mskDeptBlock(
      'ИТОГО (ОС+НЦ+ЖБИ)',
      i.planSales.mtd.total, i.factSales.month.total,
      i.planShipMtd.total, i.factShipMonth.total,
    ),
  ].join('\n\n————\n');
}

// ── из lib/jobs/dailyGroupReport.ts ────────────────────────────────────────────
function fmtRub(v: number): string {
  return `${Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;
}
function fmtPct1OfPlan(fact: number, plan: number): string {
  if (plan <= 0) return '—';
  return `${((fact / plan) * 100).toFixed(1).replace('.', ',')}%`;
}
const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
function weekdayRu(dateStr: string): string {
  return WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}
const TOTAL_KEY = '__total__';
interface ReportGroup { key: string; title: string }
type Sums = Record<string, number>;

function grpPlanPercentSection(title: string, fact: Sums, plan: Sums, groups: ReportGroup[]): string {
  const lines = [`[b]% ПЛАНА (${title}) — ${fmtPct1OfPlan(fact[TOTAL_KEY], plan[TOTAL_KEY])}[/b]`];
  for (const g of groups) lines.push(`${g.title} — ${fmtPct1OfPlan(fact[g.key], plan[g.key])}`);
  return lines.join('\n');
}
function grpConversionSection(
  title: string, conv: Record<string, ConversionRow>, groups: ReportGroup[],
  num: (r: ConversionRow) => number, den: (r: ConversionRow) => number,
): string {
  const lines = [`[b]${title} — ${fmtPct1(num(conv[TOTAL_KEY]), den(conv[TOTAL_KEY]))}[/b]`];
  for (const g of groups) lines.push(`${g.title} — ${fmtPct1(num(conv[g.key]), den(conv[g.key]))}`);
  return lines.join('\n');
}
function grpTotalsBlock(
  title: string, planSales: number, factSales: number, planShip: number, factShip: number, inRubles: boolean,
): string {
  const money = (v: number) => (inRubles ? fmtRub(v) : fmtMln(v));
  return [
    `[b]${title}[/b]`,
    `План продаж — ${money(planSales)}`,
    `Сумма продаж — ${money(factSales)}`,
    `% выполнения — ${fmtPct1OfPlan(factSales, planSales)}`,
    '',
    `План отгрузок — ${money(planShip)}`,
    `Сумма отгрузок — ${money(factShip)}`,
    `% выполнения — ${fmtPct1OfPlan(factShip, planShip)}`,
  ].join('\n');
}

interface GroupInput {
  header: string;
  totalTitle: string;
  totalsInRubles: boolean;
  dateStr: string;
  groups: ReportGroup[];
  factSales: { day: Sums; week: Sums; month: Sums };
  factShipMonth: Sums;
  planSales: { day: Sums; week: Sums; mtd: Sums };
  planShipMtd: Sums;
  conv: Record<string, ConversionRow>;
}

function legacyGroup(i: GroupInput): string {
  return [
    [
      `[b]${i.header}[/b]\n[i]${weekdayRu(i.dateStr)}, ${fmtDateRu(i.dateStr)}[/i]`,
      grpPlanPercentSection('ДЕНЬ', i.factSales.day, i.planSales.day, i.groups),
      grpPlanPercentSection('НЕДЕЛЯ', i.factSales.week, i.planSales.week, i.groups),
      grpPlanPercentSection('МЕСЯЦ', i.factSales.month, i.planSales.mtd, i.groups),
    ].join('\n\n'),
    [
      grpConversionSection('Конверсия в бронь (месяц)', i.conv, i.groups, r => r.primaryReservations, r => r.primaryDeals),
      grpConversionSection('Конверсия в продажу (месяц)', i.conv, i.groups, r => r.primarySales, r => r.primaryDeals),
      grpConversionSection('Конверсия ППП (месяц)', i.conv, i.groups, r => r.ppp, r => r.primarySales),
      grpConversionSection('% повторных продаж (месяц)', i.conv, i.groups, r => r.repeatSales, r => r.primarySales + r.repeatSales),
    ].join('\n\n'),
    grpTotalsBlock(
      i.totalTitle,
      i.planSales.mtd[TOTAL_KEY], i.factSales.month[TOTAL_KEY],
      i.planShipMtd[TOTAL_KEY], i.factShipMonth[TOTAL_KEY],
      i.totalsInRubles,
    ),
  ].join('\n\n————\n');
}

// ── из features/manager-card/engine/managerReportText.ts ───────────────────────
function fmtMoney(v: number): string {
  if (Math.abs(v) >= 1_000_000) return fmtMln(v);
  if (Math.abs(v) >= 1_000) return `${Math.round(v / 1000)} тыс`;
  return `${Math.round(v)} ₽`;
}
function fmtPct(fact: number, plan: number | null): string {
  if (plan === null || plan <= 0) return '—';
  return `${Math.round((fact / plan) * 100)}%`;
}
function persBucketBlock(title: string, b: PersonalBucket): string {
  const lines = [
    `[b]${title}[/b]`,
    `План продаж — ${b.planSales !== null ? fmtMoney(b.planSales) : '—'}`,
    `Сумма продаж — ${fmtMoney(b.salesAmount)}`,
    `% выполнения — ${fmtPct(b.salesAmount, b.planSales)}`,
    `Продажи — ${b.salesCount} шт`,
    `Брони — ${b.reservationsCount} шт${b.reservationsAmount > 0 ? ` (${fmtMoney(b.reservationsAmount)})` : ''}`,
    `Подтв. брони — ${b.confirmedCount} шт`,
    `Отгружено — ${fmtMoney(b.shipmentsAmount)}${b.planShipments !== null ? ` / план ${fmtMoney(b.planShipments)} (${fmtPct(b.shipmentsAmount, b.planShipments)})` : ''}`,
    `Звонки — ${b.callsOut} исх · ${b.callMinutes} мин`,
  ];
  return lines.join('\n');
}

function legacyPersonal(i: PersonalReportInput): string {
  const header = [
    `[b]Отчет: ${i.name}[/b]`,
    `[i]${i.department ? `${i.department} · ` : ''}за ${fmtDateRu(i.date)}[/i]`,
  ].join('\n');

  const planPct = [
    `[b]% ПЛАНА[/b]`,
    `День — ${fmtPct(i.day.salesAmount, i.day.planSales)}`,
    `Неделя — ${fmtPct(i.week.salesAmount, i.week.planSales)}`,
    `Месяц — ${fmtPct(i.month.salesAmount, i.month.planSales)}`,
  ].join('\n');

  const ex = i.monthExtras;
  const monthDetails = [
    `[b]МЕСЯЦ · ДЕТАЛИ[/b]`,
    `Продажи (перв.) — ${fmtMoney(ex.primarySalesAmount)}`,
    `Продажи (повт.) — ${fmtMoney(ex.repeatSalesAmount)}`,
    `% повторных — ${ex.repeatSharePct !== null ? `${ex.repeatSharePct.toFixed(1).replace('.', ',')}%` : '—'}`,
    `CR сделка → продажа — ${ex.convDealToSalePct !== null ? `${ex.convDealToSalePct.toFixed(1).replace('.', ',')}%` : '—'}`,
  ].join('\n');

  return [
    `${header}\n\n${planPct}`,
    persBucketBlock('ДЕНЬ', i.day),
    persBucketBlock(`НЕДЕЛЯ (с ${fmtDateRu(i.weekFrom).slice(0, 5)})`, i.week),
    `${persBucketBlock('МЕСЯЦ', i.month)}\n\n${monthDetails}`,
  ].join('\n\n————\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// СБОРКА ТОГО ЖЕ ЧЕРЕЗ ДВИЖОК
// ═══════════════════════════════════════════════════════════════════════════════

/** Значения метрики «факт/план» по всем колонкам сразу. */
function ratioValues(keys: string[], fact: Sums, plan: Sums): ReportMetric['values'] {
  const out: ReportMetric['values'] = {};
  for (const k of keys) out[k] = { num: fact[k] ?? 0, den: plan[k] ?? 0 };
  return out;
}
function numberValues(keys: string[], sums: Sums): ReportMetric['values'] {
  const out: ReportMetric['values'] = {};
  for (const k of keys) out[k] = sums[k] ?? 0;
  return out;
}
function convValues(
  keys: string[], conv: Record<string, ConversionRow>,
  num: (r: ConversionRow) => number, den: (r: ConversionRow) => number,
): ReportMetric['values'] {
  const out: ReportMetric['values'] = {};
  for (const k of keys) out[k] = { num: num(conv[k]), den: den(conv[k]) };
  return out;
}

const CONVERSIONS: { label: string; num: (r: ConversionRow) => number; den: (r: ConversionRow) => number }[] = [
  { label: 'Конверсия в бронь (месяц)', num: r => r.primaryReservations, den: r => r.primaryDeals },
  { label: 'Конверсия в продажу (месяц)', num: r => r.primarySales, den: r => r.primaryDeals },
  { label: 'Конверсия ППП (месяц)', num: r => r.ppp, den: r => r.primarySales },
  { label: '% повторных продаж (месяц)', num: r => r.repeatSales, den: r => r.primarySales + r.repeatSales },
];

function engineMoscow(i: MoscowInput): string {
  const entities: ReportEntity[] = DEPTS.map(cat => ({ key: cat, title: DEPT_TITLES[cat] }));
  const keys = [...DEPTS, 'total'];
  const asSums = (s: DeptSums): Sums => ({ ...s, [TOTAL]: s.total });
  const allKeys = [...keys, TOTAL];

  const planPct = (label: string, fact: DeptSums, plan: DeptSums): ReportMetric => ({
    label, format: 'pct0', values: ratioValues(allKeys, asSums(fact), asSums(plan)),
  });

  const money = (label: string, sums: DeptSums, gapBefore?: boolean): ReportMetric => ({
    label, format: 'mln', gapBefore, values: numberValues(allKeys, asSums(sums)),
  });
  const pct = (label: string, fact: DeptSums, plan: DeptSums): ReportMetric => ({
    label, format: 'pct0', values: ratioValues(allKeys, asSums(fact), asSums(plan)),
  });

  const blockMetrics: ReportMetric[] = [
    money('План продаж', i.planSales.mtd),
    money('Сумма продаж', i.factSales.month),
    pct('% выполнения', i.factSales.month, i.planSales.mtd),
    money('План отгрузок', i.planShipMtd, true),
    money('Сумма отгрузок', i.factShipMonth),
    pct('% выполнения', i.factShipMonth, i.planShipMtd),
  ];

  return buildReportText({
    title: 'Отчет МОСКВА',
    subtitle: { style: 'za', date: i.dateStr },
    entities,
    overview: [
      [
        planPct('% ПЛАНА (ДЕНЬ)', i.factSales.day, i.planSales.day),
        planPct('% ПЛАНА (НЕДЕЛЯ)', i.factSales.week, i.planSales.week),
        planPct('% ПЛАНА (МЕСЯЦ)', i.factSales.month, i.planSales.mtd),
      ],
      CONVERSIONS.map(c => ({
        label: c.label, format: 'pct1' as const,
        values: convValues(allKeys, { ...i.conv, [TOTAL]: i.conv.total }, c.num, c.den),
      })),
    ],
    entityBlock: blockMetrics,
    aggregate: { title: 'ИТОГО (ОС+НЦ+ЖБИ)' },
  });
}

function engineGroup(i: GroupInput): string {
  const keys = [...i.groups.map(g => g.key), TOTAL];
  // В движке итоговая колонка называется TOTAL, в старом коде — TOTAL_KEY;
  // значения одни и те же, ключи совпадают по значению строки.
  const money = (label: string, sums: Sums, gapBefore?: boolean): ReportMetric => ({
    label, format: i.totalsInRubles ? 'rub' : 'mln', gapBefore, values: numberValues(keys, sums),
  });
  const pct = (label: string, fact: Sums, plan: Sums): ReportMetric => ({
    label, format: 'pct1', values: ratioValues(keys, fact, plan),
  });

  return buildReportText({
    title: i.header,
    subtitle: { style: 'weekday', date: i.dateStr },
    entities: i.groups.map(g => ({ key: g.key, title: g.title })),
    overview: [
      [
        { label: '% ПЛАНА (ДЕНЬ)', format: 'pct1', values: ratioValues(keys, i.factSales.day, i.planSales.day) },
        { label: '% ПЛАНА (НЕДЕЛЯ)', format: 'pct1', values: ratioValues(keys, i.factSales.week, i.planSales.week) },
        { label: '% ПЛАНА (МЕСЯЦ)', format: 'pct1', values: ratioValues(keys, i.factSales.month, i.planSales.mtd) },
      ],
      CONVERSIONS.map(c => ({
        label: c.label, format: 'pct1' as const,
        values: convValues(keys, i.conv, c.num, c.den),
      })),
    ],
    aggregate: {
      title: i.totalTitle,
      metrics: [
        money('План продаж', i.planSales.mtd),
        money('Сумма продаж', i.factSales.month),
        pct('% выполнения', i.factSales.month, i.planSales.mtd),
        money('План отгрузок', i.planShipMtd, true),
        money('Сумма отгрузок', i.factShipMonth),
        pct('% выполнения', i.factShipMonth, i.planShipMtd),
      ],
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ДАННЫЕ
// ═══════════════════════════════════════════════════════════════════════════════

const deptSums = (os: number, nc: number, gbi: number): DeptSums =>
  ({ 'ОС': os, 'НЦ': nc, 'ЖБИ': gbi, total: os + nc + gbi });

const convRow = (deals: number, res: number, sales: number, repeat: number, ppp: number): ConversionRow =>
  ({ primaryDeals: deals, primaryReservations: res, primarySales: sales, repeatSales: repeat, ppp });

function convTotal(rows: ConversionRow[]): ConversionRow {
  return rows.reduce((a, r) => ({
    primaryDeals: a.primaryDeals + r.primaryDeals,
    primaryReservations: a.primaryReservations + r.primaryReservations,
    primarySales: a.primarySales + r.primarySales,
    repeatSales: a.repeatSales + r.repeatSales,
    ppp: a.ppp + r.ppp,
  }), convRow(0, 0, 0, 0, 0));
}

function moscowCase(name: string, i: MoscowInput) {
  eqText(engineMoscow(i), legacyMoscow(i), `МОСКВА — ${name}`);
}
function groupCase(name: string, i: GroupInput) {
  eqText(engineGroup(i), legacyGroup(i), `КОВАЛЕНКО — ${name}`);
}
function personalCase(name: string, i: PersonalReportInput) {
  eqText(buildPersonalReportText(i), legacyPersonal(i), `Личный — ${name}`);
}

// ── МОСКВА ─────────────────────────────────────────────────────────────────────
const mskConvNormal: Conversions = (() => {
  const os = convRow(180, 50, 31, 12, 9);
  const nc = convRow(74, 22, 15, 3, 4);
  const gbi = convRow(41, 9, 6, 1, 2);
  return { 'ОС': os, 'НЦ': nc, 'ЖБИ': gbi, total: convTotal([os, nc, gbi]) };
})();

moscowCase('обычные числа', {
  dateStr: '2026-08-05',
  factSales: {
    day: deptSums(1_240_000, 830_000, 410_000),
    week: deptSums(5_100_000, 3_020_000, 1_780_000),
    month: deptSums(9_900_000, 6_450_000, 3_120_000),
  },
  factShipMonth: deptSums(8_700_000, 5_900_000, 2_800_000),
  planSales: {
    day: deptSums(930_000, 407_000, 254_000),
    week: deptSums(4_650_000, 2_035_000, 1_270_000),
    mtd: deptSums(11_300_000, 4_884_000, 3_048_000),
  },
  planShipMtd: deptSums(12_400_000, 5_300_000, 3_300_000),
  conv: mskConvNormal,
});

// Нули: план 0 → «—» (а не 0% и не Infinity); знаменатель конверсии 0 → «—».
const mskConvZero: Conversions = {
  'ОС': convRow(0, 0, 0, 0, 0),
  'НЦ': convRow(10, 0, 0, 0, 0),
  'ЖБИ': convRow(0, 5, 0, 3, 1),
  total: convTotal([convRow(0, 0, 0, 0, 0), convRow(10, 0, 0, 0, 0), convRow(0, 5, 0, 3, 1)]),
};
moscowCase('нулевые планы и знаменатели', {
  dateStr: '2026-01-31',
  factSales: { day: deptSums(0, 0, 0), week: deptSums(0, 100_000, 0), month: deptSums(0, 250_000, 0) },
  factShipMonth: deptSums(0, 0, 0),
  planSales: { day: deptSums(0, 0, 0), week: deptSums(0, 0, 0), mtd: deptSums(0, 0, 0) },
  planShipMtd: deptSums(0, 0, 0),
  conv: mskConvZero,
});

// Отрицательные суммы (возвраты) и округление на границе .5 / .05.
moscowCase('отрицательные и границы округления', {
  dateStr: '2026-12-01',
  factSales: {
    day: deptSums(-450_000, 1_050_000, 5_000),
    week: deptSums(-1_250_000, 2_500_000, 1_950_000),
    month: deptSums(1_050_000, 2_250_000, 3_350_000),
  },
  factShipMonth: deptSums(-2_000_000, 0, 1_005_000),
  planSales: {
    day: deptSums(1_000_000, 1_000_000, 1_000_000),
    week: deptSums(2_000_000, 2_000_000, 2_000_000),
    mtd: deptSums(2_000_000, 4_000_000, 6_700_000),
  },
  planShipMtd: deptSums(4_000_000, 1, 2_010_000),
  conv: mskConvNormal,
});

// ── КОВАЛЕНКО (команды Общестроя, итог в рублях) ───────────────────────────────
const TEAMS: ReportGroup[] = [
  { key: 'Команда Осипов', title: 'Осипов' },
  { key: 'Команда Ухановой', title: 'Уханова' },
  { key: 'Команда Руденко', title: 'Руденко' },
  { key: 'Спецназ Монолит', title: 'Подчаший' },
  { key: 'Команда Зианбетовой', title: 'Зианбетова' },
];
function teamSums(vals: number[]): Sums {
  const out: Sums = {};
  TEAMS.forEach((g, idx) => { out[g.key] = vals[idx]; });
  out[TOTAL_KEY] = vals.reduce((a, b) => a + b, 0);
  return out;
}
function teamConv(rows: ConversionRow[]): Record<string, ConversionRow> {
  const out: Record<string, ConversionRow> = {};
  TEAMS.forEach((g, idx) => { out[g.key] = rows[idx]; });
  out[TOTAL_KEY] = convTotal(rows);
  return out;
}

groupCase('обычные числа, итог в рублях', {
  header: 'Отчет КОВАЛЕНКО',
  totalTitle: 'ОБЩЕСТРОЙ',
  totalsInRubles: true,
  dateStr: '2026-08-05',
  groups: TEAMS,
  factSales: {
    day: teamSums([310_000, 205_000, 0, 128_400, 96_000]),
    week: teamSums([1_420_000, 980_000, 355_000, 610_000, 402_000]),
    month: teamSums([3_240_500, 2_115_000, 890_000, 1_477_300, 1_002_400]),
  },
  factShipMonth: teamSums([2_980_000, 1_870_000, 1_120_000, 1_300_000, 950_000]),
  planSales: {
    day: teamSums([280_000, 240_000, 120_000, 150_000, 90_000]),
    week: teamSums([1_400_000, 1_200_000, 600_000, 750_000, 450_000]),
    mtd: teamSums([3_360_000, 2_880_000, 1_440_000, 1_800_000, 1_080_000]),
  },
  planShipMtd: teamSums([3_500_000, 3_000_000, 1_500_000, 1_900_000, 1_100_000]),
  conv: teamConv([
    convRow(62, 18, 11, 4, 3),
    convRow(48, 14, 8, 2, 2),
    convRow(0, 0, 0, 0, 0),
    convRow(37, 9, 5, 1, 1),
    convRow(25, 6, 3, 0, 1),
  ]),
});

groupCase('итог в млн, одна группа, нулевые планы', {
  header: 'Отчет ТЕСТ',
  totalTitle: 'ИТОГО (ОДИН)',
  totalsInRubles: false,
  dateStr: '2026-03-08',
  groups: [TEAMS[0]],
  factSales: { day: { [TEAMS[0].key]: 0, [TOTAL_KEY]: 0 }, week: { [TEAMS[0].key]: 0, [TOTAL_KEY]: 0 }, month: { [TEAMS[0].key]: 12_345_678, [TOTAL_KEY]: 12_345_678 } },
  factShipMonth: { [TEAMS[0].key]: 9_876_543, [TOTAL_KEY]: 9_876_543 },
  planSales: { day: { [TEAMS[0].key]: 0, [TOTAL_KEY]: 0 }, week: { [TEAMS[0].key]: 0, [TOTAL_KEY]: 0 }, mtd: { [TEAMS[0].key]: 0, [TOTAL_KEY]: 0 } },
  planShipMtd: { [TEAMS[0].key]: 10_000_000, [TOTAL_KEY]: 10_000_000 },
  conv: { [TEAMS[0].key]: convRow(0, 0, 0, 0, 0), [TOTAL_KEY]: convRow(0, 0, 0, 0, 0) },
});

// ── Личный отчёт ───────────────────────────────────────────────────────────────
const bucket = (o: Partial<PersonalBucket> = {}): PersonalBucket => ({
  planSales: 1_500_000, salesAmount: 1_230_000, salesCount: 4,
  reservationsCount: 6, reservationsAmount: 450_000, confirmedCount: 3,
  shipmentsAmount: 980_000, planShipments: 1_200_000,
  callsOut: 37, callMinutes: 92, ...o,
});

personalCase('обычные числа', {
  name: 'Иван Иванов',
  department: 'Общестрой',
  date: '2026-08-05',
  weekFrom: '2026-08-03',
  day: bucket({ planSales: 75_000, salesAmount: 62_000, salesCount: 1, reservationsCount: 2, reservationsAmount: 0, confirmedCount: 1, shipmentsAmount: 41_000, planShipments: 60_000, callsOut: 12, callMinutes: 31 }),
  week: bucket({ planSales: 375_000, salesAmount: 410_000, salesCount: 2 }),
  month: bucket(),
  monthExtras: { primarySalesAmount: 900_000, repeatSalesAmount: 330_000, repeatSharePct: 26.8, convDealToSalePct: 12.5 },
});

personalCase('нет отдела, нет планов, нулевые значения', {
  name: 'Пётр Петров',
  department: null,
  date: '2026-02-28',
  weekFrom: '2026-02-23',
  day: bucket({ planSales: null, planShipments: null, salesAmount: 0, salesCount: 0, reservationsCount: 0, reservationsAmount: 0, confirmedCount: 0, shipmentsAmount: 0, callsOut: 0, callMinutes: 0 }),
  week: bucket({ planSales: 0, planShipments: null, salesAmount: 999 }),
  month: bucket({ planSales: null, salesAmount: 1_500, shipmentsAmount: 0 }),
  monthExtras: { primarySalesAmount: 0, repeatSalesAmount: 0, repeatSharePct: null, convDealToSalePct: null },
});

personalCase('отрицательные суммы и шкала млн/тыс/₽', {
  name: 'Анна Смирнова',
  department: 'Нулевой цикл',
  date: '2026-11-30',
  weekFrom: '2026-11-30',
  day: bucket({ salesAmount: -250_000, planSales: 100, shipmentsAmount: 999, planShipments: 1_000_000 }),
  week: bucket({ salesAmount: 1_000_000, planSales: 999_999 }),
  month: bucket({ salesAmount: 12_500_000, planSales: 10_000_000, reservationsAmount: 0 }),
  monthExtras: { primarySalesAmount: 12_000_000, repeatSalesAmount: 500_000, repeatSharePct: 4.0, convDealToSalePct: 0.05 },
});

// ═══════════════════════════════════════════════════════════════════════════════
// АНИМАЦИЯ: собранный текст обязан совпасть с копируемым
// ═══════════════════════════════════════════════════════════════════════════════
// Главный инвариант анимации. Человек читает то, что «печатается», а копирует
// то, что отдаёт движок — если эти два текста разойдутся хоть на пробел, он
// отправит начальству не то, что видел. Проверяем на тех же данных, что и
// эталоны выше.

function animationCase(name: string, spec: Parameters<typeof buildReportDocument>[0]) {
  const doc = buildReportDocument(spec);
  const plan = buildAnimationPlan(doc);

  eqText(renderPlanFull(plan), buildReportText(spec), `Анимация — собранный текст = копируемый (${name})`);

  // Финальный кадр = готовый текст (иначе последнее слово повиснет недорисованным).
  eqText(renderPlanAt(plan, plan.totalMs + 1).join('\n'), buildReportText(spec), `Анимация — финальный кадр (${name})`);

  // Бюджет: пропуска нет, значит потолок обязан соблюдаться всегда.
  check(plan.totalMs <= TIMING.budgetMs + 1, `Анимация — укладывается в ${TIMING.budgetMs / 1000} с (${name}): ${Math.round(plan.totalMs)} мс`);

  // Монотонность: текст только прибавляется, ничего не пропадает и не мигает.
  let prevLines = 0;
  for (let t = 0; t <= plan.totalMs; t += Math.max(1, Math.floor(plan.totalMs / 40))) {
    const lines = renderPlanAt(plan, t);
    check(lines.length >= prevLines, `Анимация — строки не убывают (${name}, t=${t})`);
    prevLines = lines.length;
  }

  // Нулевой момент: ничего, кроме первого слова, ещё не показано.
  const first = renderPlanAt(plan, 0);
  check(first.length === 1 && first[0].split(' ').length === 1, `Анимация — старт с одного слова (${name})`);
}

const animEntities = [
  { key: 'ОС', title: 'Общестрой' },
  { key: 'НЦ', title: 'Нулевой' },
];
const animValues = (a: number, b: number, total: number) => ({ 'ОС': a, 'НЦ': b, [TOTAL]: total });

animationCase('короткий отчёт', {
  title: 'Отчет МОСКВА',
  subtitle: { style: 'za', date: '2026-08-05' },
  entities: animEntities,
  overview: [[{
    label: '% ПЛАНА (ДЕНЬ)', format: 'pct0',
    values: { 'ОС': { num: 9_900_000, den: 11_300_000 }, 'НЦ': { num: 6_450_000, den: 4_884_000 }, [TOTAL]: { num: 16_350_000, den: 16_184_000 } },
  }]],
  entityBlock: [
    { label: 'План продаж', format: 'mln', values: animValues(11_300_000, 4_884_000, 16_184_000) },
    { label: 'Сумма продаж', format: 'mln', values: animValues(9_900_000, 6_450_000, 16_350_000) },
  ],
  aggregate: { title: 'ИТОГО (ОС+НЦ)' },
});

// Длинный отчёт — тот случай, ради которого и вводился потолок: без сжатия
// 40 метрик × 12 сущностей собирались бы заметно дольше 20 секунд.
animationCase('длинный отчёт (12 сущностей × 40 метрик)', {
  title: 'Отчет БОЛЬШОЙ',
  subtitle: { style: 'weekday', date: '2026-08-05' },
  entities: Array.from({ length: 12 }, (_, i) => ({ key: `e${i}`, title: `Подразделение ${i + 1}` })),
  overview: [Array.from({ length: 3 }, (_, i) => ({
    label: `% ПЛАНА (ОКНО ${i})`, format: 'pct1' as const,
    values: Object.fromEntries([
      ...Array.from({ length: 12 }, (_, k) => [`e${k}`, { num: k * 1000, den: 5000 }]),
      [TOTAL, { num: 66_000, den: 60_000 }],
    ]),
  }))],
  entityBlock: Array.from({ length: 40 }, (_, i) => ({
    label: `Показатель номер ${i + 1}`, format: 'mln' as const,
    values: Object.fromEntries([
      ...Array.from({ length: 12 }, (_, k) => [`e${k}`, (k + 1) * 1_000_000]),
      [TOTAL, 78_000_000],
    ]),
  })),
  aggregate: { title: 'ИТОГО (ВСЁ)' },
});

// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
