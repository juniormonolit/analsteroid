import { analyticsDb } from '@/lib/db/clients';
import { periodDateStrFromInstant } from '@/lib/period';
import { DEAL_EVENTS_DATA_START } from '@/features/reports/engine/managerActivity';
import {
  fetchWorkRows, RESERVED_CONFIRMED_EVENT_TYPES,
  type SurvivalRowOptions, type SurvivalDealRow,
} from './stageSurvival';
import { buildLifeTablePoints, selectLifeTableDealIds, LIFE_TABLE_MAX_DAY, type LifeTableRow } from './lifeTable';
import type { CalledToSaleCohortResult, KcGroupSlice } from './types';

export type { CalledToSaleCohortPoint, CalledToSaleCohortResult } from './types';

// Пятый график — ИСТОРИЯ ЧЕТЫРЁХ ВЕРСИЙ ПОДАЧИ (задачи 2574/2599):
//  v1 (28.07): бакеты/CR% по образцу preset='work' (stageSurvival.ts).
//  v2 (29.07): «по аналогии с 3 и 4, то есть от общего количества сделок» —
//    life table вместо бакетов.
//  v3 (30.07 утро): три линии бронь/продажа/отгрузка (reserved/sold/shipped).
//  v4 (30.07, задача 2599, владелец посмотрел v3): «переделай в 1 линию и он
//    должен отражать не кол-во сделок, а конверсию. То есть аналогично этим
//    двум графикам [3 и 4]. И сделай ещё так, чтобы в тултипе показывались
//    данные с разбивкой по товарным группам по кц» — возврат к форме v2
//    (одна линия sold, общий движок lifeTable, та же подача, что у
//    workDaysCohort.ts) + разбивка проданных каждого дня по «Категории КЦ»
//    (d.product_group_id → sa.product_groups, НЕ head_group_name) в тултипе.
//
// Механика ОСИ ДНЕЙ — смысл пятого графика, не менялась ни в одной версии:
// когорта та же, что у preset='work'/4-го графика (первый вход в любую
// WORK-стадию), «день» — НАКОПЛЕННОЕ время в WORK-стадиях БЕЗ интервалов
// event_type IN ('reserved','confirmed') — см. fetchWorkRows(opts,
// RESERVED_CONFIRMED_EVENT_TYPES) в stageSurvival.ts. Раскладка по дням —
// общий lifeTable.ts, как у 3-го/4-го графиков (дуальное значение days =
// eventDay для проданных / observedDays для всех — ровно как в
// workDaysCohort.ts, см. комментарий там).

export type WorkExclReservedCohortOptions = SurvivalRowOptions;

function toLifeTableRows(rows: SurvivalDealRow[]): LifeTableRow[] {
  return rows.map(r => {
    const d = Math.floor(r.days);
    return { dealId: r.dealId, eventDay: r.sold ? d : null, observedDays: d };
  });
}

// Сколько групп показывать в тултипе поимённо; хвост сворачивается в
// «Прочие (k)» — чтобы тултип не распухал (в kc ~96 групп).
const TOOLTIP_TOP_GROUPS = 5;

// Имя kc-группы на сделку (d.product_group_id → sa.product_groups; NULL —
// «Без группы»). Отдельный точечный запрос по продавшим сделкам когорты, а не
// колонка в fetchWorkRows: тот — общий код графиков 2 и 4, расширять его
// колонкой ради одного потребителя не стали.
async function fetchKcNames(dealIds: number[]): Promise<Map<number, string>> {
  if (dealIds.length === 0) return new Map();
  const res = await analyticsDb().query<{ deal_id: string; name: string | null }>(
    `SELECT d.deal_id, pg.name
       FROM deals d
       LEFT JOIN sa.product_groups pg ON pg.id = d.product_group_id
      WHERE d.deal_id = ANY($1::bigint[])`,
    [dealIds],
  );
  return new Map(res.rows.map(r => [Number(r.deal_id), r.name ?? 'Без группы']));
}

/** null — если весь период раньше старта сбора deal_events (03.04.2026). */
export async function fetchWorkExclReservedCohort(opts: WorkExclReservedCohortOptions): Promise<CalledToSaleCohortResult | null> {
  const periodToStr = periodDateStrFromInstant(opts.period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const rows = await fetchWorkRows(opts, RESERVED_CONFIRMED_EVENT_TYPES);
  const result = buildLifeTablePoints(toLifeTableRows(rows));

  // Разбивка проданных КАЖДОГО дня по kc-группам (тултип, задача 2599).
  // День продажи — тот же floor(days), что eventDay в toLifeTableRows выше,
  // поэтому Σ count разбивки точки == points[day].sold (инвариант проверяется
  // на живых данных при выкатке).
  const sold = rows.filter(r => r.sold);
  const names = await fetchKcNames(sold.map(r => r.dealId));
  const perDay = new Map<number, Map<string, number>>();
  for (const r of sold) {
    const d = Math.floor(r.days);
    const idx = d <= LIFE_TABLE_MAX_DAY ? d : LIFE_TABLE_MAX_DAY + 1;
    const m = perDay.get(idx) ?? new Map<string, number>();
    const name = names.get(r.dealId) ?? 'Без группы';
    m.set(name, (m.get(name) ?? 0) + 1);
    perDay.set(idx, m);
  }
  for (const p of result.points) {
    const m = perDay.get(p.day);
    if (!m) continue;
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
    const top: KcGroupSlice[] = sorted.slice(0, TOOLTIP_TOP_GROUPS).map(([name, count]) => ({ name, count }));
    const rest = sorted.slice(TOOLTIP_TOP_GROUPS);
    if (rest.length > 0) {
      top.push({ name: `Прочие (${rest.length})`, count: rest.reduce((s, [, c]) => s + c, 0) });
    }
    p.groups = top;
  }

  return result;
}

// ── Дрилл-даун: список сделок одного дня (те же условия, что раскладка выше) ─
export async function fetchWorkExclReservedCohortDealIds(
  opts: WorkExclReservedCohortOptions & { day: number; filter: 'all' | 'sold' },
): Promise<number[] | null> {
  const periodToStr = periodDateStrFromInstant(opts.period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const rows = await fetchWorkRows(opts, RESERVED_CONFIRMED_EVENT_TYPES);
  return selectLifeTableDealIds(toLifeTableRows(rows), opts.day, opts.filter);
}
