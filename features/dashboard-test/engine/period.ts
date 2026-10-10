// «Дашборд тест» — вкладки «Неделя / Месяц / Год»: созданные первичные сделки за период и сравнение
// с прошлым периодом — для всей компании, каждого филиала и департамента.
//
// СЧИТАЮТСЯ ПЕРВИЧНЫЕ СДЕЛКИ, СОЗДАННЫЕ ЗА ПЕРИОД (по дате создания) — метрика каталога
// `primary_deals_count` («Кол-во сделок (перв.)»). Повторные не входят: решение владельца
// 09.10 — «сделки мы всегда считаем только первичные». Условие отбора берётся из каталога
// метрик тем же генератором SQL, что у отчётов (lib/metrics/sqlGen.ts), поэтому число
// совпадает с отчётами. ИСТОРИЯ: сначала раздел назывался «лиды» (допущение исполнителя
// по наброску «Лиды, шт.»); 09.10 владелец поправил — лидов как сущности в системе нет,
// это сделки. При переименовании исполнитель на час переключил метрику на «все сделки»
// (`deals_count`) — владелец вернул первичные. Поменять метрику — одна константа ниже.
//
// Филиал сделки — по ТЕКУЩЕМУ менеджеру сделки и ТЕКУЩЕЙ оргструктуре (то же дерево, что
// у вкладки «Сегодня»). Сделки, чей менеджер сейчас вне отдела продаж, в график не входят.
//
// СРАВНЕНИЕ (решение владельца 08.10: «у каждой базы сравнения свой способ выравнивания»):
//   • неделя — с предыдущей неделей по дням недели; в итог идут только совпадающие дни —
//     ДЕНЬ КО ДНЮ (у идущей недели пн…сегодня против тех же дней прошлой, у завершённой все
//     семь), а сегодняшний неполный день — с тем же днём на то же время (basePartial).
//     Подтверждено владельцем 09.10; «неделя целиком к неделе целиком» у идущей недели
//     давала ложный минус и была убрана;
//   • месяц — каждый день сравнивается с ТЕМ ЖЕ ДНЁМ НЕДЕЛИ четырьмя неделями раньше (минус
//     28 дней: 1 окт, чт ↔ 3 сен, чт). Решение владельца 09.10: «сравнивать подобное с
//     подобным, а не пятницу с понедельником» — сравнение «то же число прошлого месяца»
//     прожило час и давало скачки +217% / −69% из-за выходных. У идущего месяца итог —
//     «1-е…сегодня» против тех же дней 4 недели назад (сегодняшний день — на то же время),
//     у завершённого — весь месяц против тех же дней 4 недели назад;
//   • год — с предыдущим годом по месяцам (сделок в месяц); у идущего года итог — «с 10 января
//     по сегодня» против тех же дат прошлого года, у завершённого — год к году. ЯНВАРЬ В ГОДУ —
//     С 10 ЯНВАРЯ в обоих годах (решение владельца 10.10, см. shared.YEAR_START_MD): 1–9 января
//     не входят ни в январь, ни в итог года, ни в «по филиалам».
// ВСЁ СЧИТАЕТСЯ ПО КАЛЕНДАРНЫМ ДНЯМ (решение владельца 09.10). Первый вариант выравнивал
// месяц и год по рабочим дням производственного календаря («на 7-й рабочий день», «в среднем
// на рабочий день») — владельцу это было неудобно читать, убрано целиком.

import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL, isSqlIdent } from '@/lib/metrics/sqlGen';
import type { Metric } from '@/lib/metrics/types';
import { mskMidnightIso, mskTodayStr } from '@/features/tv/engine/feed';
import { buildTvTree, deptChains, loadActiveManagers, managersOfNode } from '@/features/tv/engine/orgTree';
import { addDays, countsInYear, maxPeriodOffset, periodBuckets, periodLabel, periodRange, weekdayIndex, type DashPeriod } from '../shared';

export const DEALS_METRIC_ID = 'primary_deals_count';

/** Что ещё считается за период, кроме созданных сделок (блоки «Брони» и «Продажи», 09.10):
 *    reservations — первичные брони по дате брони (`primary_reservations_count`);
 *    sales        — первичные продажи по дате продажи (`primary_sales_count`);
 *    salesReserved — из них только те, что прошли через бронь (`primary_reservation_to_sale_count`:
 *                   у сделки заполнена дата брони) — числитель конверсии «бронь → продажа».
 *                   Решение владельца 09.10: «тут надо учитывать только те, что были в бронях»;
 *                   первый вариант делил на брони ВСЕ первичные продажи (формула каталога
 *                   `cr_reservation_to_sale`) и из-за продаж мимо брони давал больше 100%;
 *    salesAmount  — сумма ВСЕХ продаж, первичных и повторных, по дате продажи — та же сумма,
 *                   что «Продажи» на вкладке «Сегодня» и что идёт в план.
 *  Блок «Отгрузки» (владелец 10.10: «конверсия из сделки в отгрузку, из продажи в отгрузку,
 *  сумма отгрузок»), всё по дате отгрузки (delivered_at):
 *    shipments       — первичные отгрузки (`primary_shipments_count`);
 *    shipmentsSold   — из них только те, у которых была продажа (дата продажи заполнена) —
 *                      числитель конверсии «продажа → отгрузка», по тому же правилу, что владелец
 *                      дал для «бронь → продажа». Готовой метрики в каталоге нет: это
 *                      `primary_shipments_count` с добавочным условием `sold_at IS NOT NULL`
 *                      (SHIPMENTS_SOLD ниже); формула каталога `cr_sale_to_shipment_primary`
 *                      делит на продажи ВСЕ отгрузки;
 *    shipmentsAmount — сумма ВСЕХ отгрузок, первичных и повторных (как сумма продаж).
 *  Конверсии страница считает сама теми же формулами, что метрики каталога
 *  `cr_deal_to_reservation`, `cr_deal_to_sale` (а «бронь → продажа» — см. salesReserved): события ЗА ПЕРИОД
 *  делятся друг на друга (брони за день ÷ сделки, созданные в этот день) — это не путь одних
 *  и тех же сделок. Сравнение с прошлым периодом — по тем же правилам, что у сделок. */
export type DashMeasure = 'reservations' | 'sales' | 'salesReserved' | 'salesAmount' | 'shipments' | 'shipmentsSold' | 'shipmentsAmount';
/** Отгрузки, у которых была продажа: своя метрика на основе `primary_shipments_count`. */
const SHIPMENTS_SOLD = 'dt_primary_shipments_after_sale_count';
type MeasureKey = 'deals' | DashMeasure;
const MEASURE_METRICS: Record<MeasureKey, string[]> = {
  deals: [DEALS_METRIC_ID],
  reservations: ['primary_reservations_count'],
  sales: ['primary_sales_count'],
  salesReserved: ['primary_reservation_to_sale_count'],
  salesAmount: ['primary_sales_amount', 'repeat_sales_amount'],
  shipments: ['primary_shipments_count'],
  shipmentsSold: [SHIPMENTS_SOLD],
  shipmentsAmount: ['primary_shipments_amount', 'repeat_shipments_amount'],
};
const MEASURE_KEYS = Object.keys(MEASURE_METRICS) as MeasureKey[];

export interface DashPeriodSeries {
  /** id узла — тот же, что у вкладки «Сегодня» (root.id, id филиала или департамента). */
  id: string;
  name: string;
  values: number[];
  total: number;
}

/** Неделя к предыдущей неделе, по дням недели (7 значений, пн…вс). */
export interface DashCompareWeek {
  mode: 'week';
  baseFrom: string;
  baseTo: string;
  /** Сколько первых дней недели идут в итог (у текущей недели — по сегодня, иначе 7). */
  matched: number;
  /** Индекс сегодняшнего дня: его база считается на то же время суток. null — неделя завершена. */
  partialIndex: number | null;
  /** «18:06» — до какого времени взята база сегодняшнего дня. */
  cutoffTime: string | null;
  series: { id: string; cur: number[]; base: number[]; basePartial: number | null; curTotal: number; baseTotal: number }[];
}

/** Месяц к тем же дням недели четырьмя неделями раньше, накопительно по числам месяца. */
export interface DashCompareMonth {
  mode: 'month';
  /** На сколько дней назад сдвинута база (28 — тот же день недели 4 недели назад). */
  shiftDays: number;
  /** Первый и последний день базы (первое и последнее число месяца минус shiftDays). */
  baseFrom: string;
  baseTo: string;
  /** Дней в выбранном месяце (в базе столько же). */
  curDays: number;
  baseDays: number;
  /** Идущий месяц: сегодняшнее число и время среза базы. */
  current: { day: number; cutoffTime: string | null } | null;
  /** cur/base — создано сделок с начала месяца на конец каждого дня (у идущего месяца последняя
   *  точка cur — «на сейчас»; base[i] — накоплено за дни базы, парные числам 1…i+1).
   *  curTotal/baseTotal: идущий месяц — по один и тот же день и время, завершённый — целиком. */
  series: { id: string; cur: number[]; base: number[]; curTotal: number; baseTotal: number }[];
}

/** Год к предыдущему году: сделок в каждом месяце. */
export interface DashCompareYear {
  mode: 'year';
  baseYear: number;
  /** Сколько месяцев с начала года уже началось (у идущего года — по текущий, иначе 12). */
  uptoMonth: number;
  /** Идущий год: по какую дату прошлого года взята база и время среза её последнего дня. */
  current: { baseThrough: string; cutoffTime: string | null } | null;
  /** cur/base — 12 значений, сделок в месяц (base — месяцы целиком). basePartial — базовый
   *  текущий месяц по ту же дату и время. curTotal/baseTotal: идущий год — с 1 января по одну
   *  и ту же дату, завершённый — годы целиком. */
  series: { id: string; cur: number[]; base: number[]; basePartial: number | null; curTotal: number; baseTotal: number }[];
}

export type DashCompare = DashCompareWeek | DashCompareMonth | DashCompareYear;

export interface DashPeriodResponse {
  period: DashPeriod;
  offset: number;
  maxOffset: number;
  from: string;
  to: string;
  label: string;
  today: string;
  /** Ключи столбцов: дни (ГГГГ-ММ-ДД) или месяцы (ГГГГ-ММ) — см. shared.periodBuckets. */
  buckets: string[];
  /** Первая серия — вся компания, дальше филиалы, за ними департаменты филиалов. */
  series: DashPeriodSeries[];
  /** Сравнение с предыдущим периодом; null — раньше данных нет, сравнивать не с чем. */
  compare: DashCompare | null;
  /** Брони, продажи и сумма продаж — в том же виде, что compare у сделок (те же узлы и даты). */
  extra: Record<DashMeasure, DashCompare | null>;
  metricName: string;
  generatedAt: string;
}

/** Первый день, за который в базе есть сделки (по Москве). */
async function earliestDay(today: string): Promise<string> {
  return cached('dashtest:earliest:v1', 6 * 3600, async () => {
    const res = await analyticsDb().query<{ d: string | null }>(
      `SELECT to_char(min(created_at) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS d FROM deals`,
    );
    return res.rows[0]?.d ?? today;
  });
}

const daysOf = (from: string, to: string) => periodBuckets('month', from, to);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** Метрики с ОДНИМ полем даты по «ключ | менеджер» за [fromIso, toExclIso). keyFmt 'day' — ключ = день
 *  события по Москве, null — только менеджер. В ответе у строки значения по id метрик. */
async function loadByManager(group: Metric[], idsNum: number[], keyFmt: 'day' | null, fromIso: string, toExclIso: string): Promise<{ key: string; managerId: string; row: Record<string, unknown> }[]> {
  if (idsNum.length === 0 || group.length === 0) return [];
  const manager = 'd.current_manager_id::text';
  const sql = buildCollectedSQL(group, {
    idExpr: keyFmt ? `to_char(d.${group[0].dateField} AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') || '|' || ${manager}` : `'|' || ${manager}`,
    groupBy: 'GROUP BY 1',
    notNullWhere: `d.current_manager_id IN (${idsNum.join(',')})`,
  });
  if (!sql) return [];
  const res = await analyticsDb().query<Record<string, unknown>>(sql, [fromIso, toExclIso]);
  const out: { key: string; managerId: string; row: Record<string, unknown> }[] = [];
  for (const row of res.rows) {
    const [key, managerId] = String(row.dimension_id).split('|');
    if (managerId) out.push({ key, managerId, row });
  }
  return out;
}

export async function buildDashboardPeriod(period: DashPeriod, offsetRaw: number): Promise<DashPeriodResponse> {
  const today = mskTodayStr();
  const maxOffset = maxPeriodOffset(period, today, await earliestDay(today));
  const offset = Math.max(0, Math.min(Number.isInteger(offsetRaw) ? offsetRaw : 0, maxOffset));
  const { from, to } = periodRange(period, offset, today);
  const isCurrent = offset === 0;
  const baseRange = offset + 1 <= maxOffset ? periodRange(period, offset + 1, today) : null;

  // год — два года по дням, запрос тяжелее: держим в кэше дольше
  return cached(`dashtest:period:v11:${period}:${from}`, period === 'year' ? 300 : 60, async () => {
    const [tree, orgRows, chains, catalog] = await Promise.all([buildTvTree(), loadActiveManagers(), deptChains(), loadMetrics()]);
    // своя метрика «отгрузки после продажи» — копия первичных отгрузок с условием «продажа была»
    const shipBase = catalog.find(m => m.id === 'primary_shipments_count');
    const metrics: Metric[] = shipBase
      ? [...catalog, { ...shipBase, id: SHIPMENTS_SOLD, filters: [...shipBase.filters, { field: 'sold_at', op: 'is_not_null', value: '' }] }]
      : catalog;
    const metric = metrics.find(m => m.id === DEALS_METRIC_ID);
    if (!metric || !isSqlIdent(metric.dateField)) throw new Error(`метрика ${DEALS_METRIC_ID} не найдена в каталоге`);
    // метрики всех показателей, собранные по полю даты: один запрос на поле (создана / бронь / продажа)
    const byDateField = new Map<string, Metric[]>();
    for (const id of new Set(MEASURE_KEYS.flatMap(k => MEASURE_METRICS[k]))) {
      const m = metrics.find(x => x.id === id);
      if (!m || !isSqlIdent(m.dateField)) throw new Error(`метрика ${id} не найдена в каталоге`);
      if (!byDateField.has(m.dateField!)) byDateField.set(m.dateField!, []);
      byDateField.get(m.dateField!)!.push(m);
    }
    const groups = [...byDateField.values()];
    /** Значение показателя в строке ответа: сумма его метрик. */
    const measureOf = (k: MeasureKey, row: Record<string, unknown>) => MEASURE_METRICS[k].reduce((a, id) => a + Number(row[id] ?? 0), 0);

    // Узлы: компания, филиалы и департаменты филиалов (для фильтра «Департамент» на
    // странице: НЦ по всем филиалам = сумма серий НЦ каждого филиала — складывает страница).
    const nodes = [tree.root, ...tree.root.children, ...tree.root.children.flatMap(b => b.children)];
    // менеджер → в какие узлы входит (компания, его филиал, его департамент)
    const nodesOfManager = new Map<string, number[]>();
    nodes.forEach((n, i) => {
      for (const id of new Set(managersOfNode(n, orgRows, chains).map(m => m.managerId))) {
        if (!nodesOfManager.has(id)) nodesOfManager.set(id, []);
        nodesOfManager.get(id)!.push(i);
      }
    });
    const idsNum = [...nodesOfManager.keys()].map(Number).filter(n => Number.isInteger(n) && n > 0);

    // По запросу на поле даты, каждый — сразу на оба периода (они идут подряд): события по
    // «день | менеджер». У сделки один менеджер и одна дата события, поэтому сумма по менеджерам
    // узла — точное число узла.
    const dailyBy = Object.fromEntries(MEASURE_KEYS.map(k => [k, nodes.map(() => new Map<string, number>())])) as Record<MeasureKey, Map<string, number>[]>;
    const loaded = await Promise.all(groups.map(g => loadByManager(g, idsNum, 'day', mskMidnightIso(baseRange?.from ?? from), mskMidnightIso(addDays(to, 1)))));
    for (const r of loaded.flat()) {
      for (const k of MEASURE_KEYS) {
        const n = measureOf(k, r.row);
        if (!n) continue;
        for (const i of nodesOfManager.get(r.managerId) ?? []) dailyBy[k][i].set(r.key, (dailyBy[k][i].get(r.key) ?? 0) + n);
      }
    }

    /** События узлов за день `day` от полуночи до того же времени суток, что сейчас (все показатели разом). */
    const elapsedMs = Math.max(0, Date.now() - Date.parse(mskMidnightIso(today)));
    const cutoffTime = `${String(Math.floor(elapsedMs / 3_600_000)).padStart(2, '0')}:${String(Math.floor(elapsedMs / 60_000) % 60).padStart(2, '0')}`;
    const partialCache = new Map<string, Promise<Record<MeasureKey, number[]>>>();
    const loadPartialAll = (day: string): Promise<Record<MeasureKey, number[]>> => {
      if (!partialCache.has(day)) partialCache.set(day, (async () => {
        const out = Object.fromEntries(MEASURE_KEYS.map(k => [k, nodes.map(() => 0)])) as Record<MeasureKey, number[]>;
        const start = Date.parse(mskMidnightIso(day));
        const rows = await Promise.all(groups.map(g => loadByManager(g, idsNum, null, new Date(start).toISOString(), new Date(start + elapsedMs).toISOString())));
        for (const r of rows.flat()) {
          for (const k of MEASURE_KEYS) {
            const n = measureOf(k, r.row);
            if (n) for (const i of nodesOfManager.get(r.managerId) ?? []) out[k][i] += n;
          }
        }
        return out;
      })());
      return partialCache.get(day)!;
    };

    const curDays = daysOf(from, to);
    const buckets = periodBuckets(period, from, to);
    const val = (i: number, day: string) => dailyBy.deals[i].get(day) ?? 0;
    const sumDays = (i: number, days: string[]) => days.reduce((a, d) => a + val(i, d), 0);
    const series: DashPeriodSeries[] = nodes.map((n, i) => {
      const values = period === 'year'
        ? buckets.map(ym => sumDays(i, curDays.filter(d => d.startsWith(ym) && countsInYear(d))))
        : buckets.map(d => val(i, d));
      return { id: n.id, name: n.name, values, total: sum(values) };
    });

    /** Сравнение с предыдущим периодом для одного показателя — правила в шапке файла. */
    const compareOf = async (key: MeasureKey): Promise<DashCompare | null> => {
      const val = (i: number, day: string) => dailyBy[key][i].get(day) ?? 0;
      const sumDays = (i: number, days: string[]) => days.reduce((a, d) => a + val(i, d), 0);
      if (baseRange && period === 'week') {
        const baseDays = buckets.map(d => addDays(d, -7));
        const matched = isCurrent ? weekdayIndex(today) + 1 : 7;
        const partialIndex = isCurrent ? weekdayIndex(today) : null;
        const partial = partialIndex != null ? (await loadPartialAll(baseDays[partialIndex]))[key] : null;
        return {
          mode: 'week', baseFrom: baseRange.from, baseTo: baseRange.to, matched, partialIndex, cutoffTime: partial ? cutoffTime : null,
          series: nodes.map((n, i) => {
            const cur = buckets.map(d => val(i, d));
            const base = baseDays.map(d => val(i, d));
            const basePartial = partial ? partial[i] : null;
            return {
              id: n.id, cur, base, basePartial,
              curTotal: sum(cur.slice(0, matched)),
              baseTotal: sum(base.slice(0, matched).map((v, j) => (j === partialIndex && basePartial != null ? basePartial : v))),
            };
          }),
        };
      } else if (baseRange && period === 'month') {
        // база — те же дни недели четырьмя неделями раньше; все они лежат не раньше начала
        // предыдущего месяца (в месяце не меньше 28 дней), то есть внутри уже загруженных дней
        const SHIFT = 28;
        const baseDays = curDays.map(d => addDays(d, -SHIFT));
        const limit = isCurrent ? today : to;
        const day = isCurrent ? Number(today.slice(8, 10)) : null;
        const baseSameDay = day != null ? baseDays[day - 1] : null;
        const partial = baseSameDay ? (await loadPartialAll(baseSameDay))[key] : null;
        const cumulative = (i: number, days: string[], through: string): number[] => {
          const pts: number[] = [];
          let acc = 0;
          for (const d of days) { if (d > through) break; acc += val(i, d); pts.push(acc); }
          return pts;
        };
        return {
          mode: 'month', shiftDays: SHIFT, baseFrom: baseDays[0], baseTo: baseDays[baseDays.length - 1],
          curDays: curDays.length, baseDays: baseDays.length,
          current: day != null ? { day, cutoffTime: partial ? cutoffTime : null } : null,
          series: nodes.map((n, i) => {
            const cur = cumulative(i, curDays, limit);
            // дни базы, которые ещё не наступили (в первые числа месяца конец базы заходит в него), не берём
            const base = cumulative(i, baseDays, today);
            const baseWhole = base[base.length - 1] ?? 0;
            const baseTotal = day != null && partial ? (day >= 2 ? base[day - 2] : 0) + partial[i] : baseWhole;
            return { id: n.id, cur, base, curTotal: cur[cur.length - 1] ?? 0, baseTotal };
          }),
        };
      } else if (baseRange && period === 'year') {
        const baseDays = daysOf(baseRange.from, baseRange.to);
        const baseYear = baseRange.from.slice(0, 4);
        const uptoMonth = isCurrent ? Number(today.slice(5, 7)) : 12;
        const monthOf = (d: string) => Number(d.slice(5, 7)) - 1;
        const monthly = (i: number, days: string[], through: string) => {
          const out = Array.from({ length: 12 }, () => 0);
          for (const d of days) if (d <= through && countsInYear(d)) out[monthOf(d)] += val(i, d);
          return out;
        };
        // идущий год: та же дата прошлого года — до того же времени суток (29 февраля, которого
        // в прошлом году нет, — по 28-е целиком)
        const sameDate = `${baseYear}${today.slice(4)}`;
        const baseSameDay = isCurrent && baseDays.includes(sameDate) ? sameDate : null;
        const baseFullThrough = baseSameDay ? addDays(baseSameDay, -1) : `${baseYear}-02-28`;
        // 1–9 января в счёт года не входят — и сегодняшний день прошлого года тоже, если он из них
        const partial = baseSameDay && countsInYear(baseSameDay) ? (await loadPartialAll(baseSameDay))[key] : null;
        const m = uptoMonth - 1;
        return {
          mode: 'year', baseYear: Number(baseYear), uptoMonth,
          current: isCurrent ? { baseThrough: baseSameDay ?? baseFullThrough, cutoffTime: partial ? cutoffTime : null } : null,
          series: nodes.map((n, i) => {
            const cur = monthly(i, curDays, isCurrent ? today : to);
            const base = monthly(i, baseDays, baseRange.to);
            const basePartial = isCurrent
              ? sumDays(i, baseDays.filter(d => monthOf(d) === m && d <= baseFullThrough && countsInYear(d))) + (partial ? partial[i] : 0)
              : null;
            return {
              id: n.id, cur, base, basePartial,
              curTotal: sum(cur),
              baseTotal: basePartial != null ? sum(base.slice(0, m)) + basePartial : sum(base),
            };
          }),
        };
      }
      return null;
    };
    const EXTRA: DashMeasure[] = ['reservations', 'sales', 'salesReserved', 'salesAmount', 'shipments', 'shipmentsSold', 'shipmentsAmount'];
    const [compare, ...extras] = await Promise.all([compareOf('deals'), ...EXTRA.map(k => compareOf(k))]);
    const extra = Object.fromEntries(EXTRA.map((k, i) => [k, extras[i]])) as Record<DashMeasure, DashCompare | null>;

    return {
      period, offset, maxOffset, from, to, label: periodLabel(period, from, to), today,
      buckets, series, compare, extra, metricName: metric.nameRu, generatedAt: new Date().toISOString(),
    };
  });
}
