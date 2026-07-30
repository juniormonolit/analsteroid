import { periodDateStrFromInstant } from '@/lib/period';
import { DEAL_EVENTS_DATA_START } from '@/features/reports/engine/managerActivity';
import { fetchWorkRows, type SurvivalRowOptions, type SurvivalDealRow } from './stageSurvival';
import { buildLifeTablePoints, selectLifeTableDealIds, type LifeTableRow } from './lifeTable';
import type { CalledToSaleCohortResult } from './types';

export type { CalledToSaleCohortPoint, CalledToSaleCohortResult } from './types';

// Четвёртый график «В работе → продажа по дням» (задача 2553, владелец 29.07).
// Дословно: Серёга прислал скриншот ВТОРОГО графика («Вероятность продажи от
// дней в работе, стадии WORK») с подписью «Вот этот график по аналогии с
// третьим добавь ещё пж». Трактовка (согласована с координатором): тот же
// день = накопленное время в WORK-стадиях, что уже считает stageSurvival.ts
// (пресет 'work', см. fetchWorkRows), но в ПОДАЧЕ третьего графика
// (calledToSaleCohort.ts) — life table: серые столбики «дожили минимум N дней
// в работе, не продав раньше», линия «продано ровно на день N». НЕ замена
// второго графика (тот остаётся с бакетами/CR%), а рядом с ним.
//
// Важное отличие «дня» здесь от calledToSaleCohort.ts: там день — календарные
// сутки от входа в стадию до sold_at. Здесь день — SurvivalDealRow.days,
// НАКОПЛЕННОЕ время в WORK-стадиях (может растянуться на много календарных
// дней, если сделка выходила из WORK и возвращалась) — та же величина, что уже
// на оси X SurvivalChart пресета 'work'. У проданной сделки days фиксируется
// на моменте выхода в 'sold'/'shipped' (work_stages их исключает — см.
// stageSurvival.ts), у ещё не проданной — растёт до now(). Из-за этого
// SurvivalDealRow.days ОДНОВременно служит и «eventDay» (для проданных), и
// «observedDays» (для всех) — ровно то же дуальное значение, что
// calledToSaleCohort.ts хранит в двух разных полях. Алгоритм раскладки по
// дням переиспользован из lifeTable.ts — копировать его второй раз владелец
// прямо просил не надо.

export type WorkDaysCohortOptions = SurvivalRowOptions;

function toLifeTableRows(rows: SurvivalDealRow[]): LifeTableRow[] {
  return rows.map(r => {
    const d = Math.floor(r.days);
    return { dealId: r.dealId, eventDay: r.sold ? d : null, observedDays: d, amount: r.amount };
  });
}

/** null — если весь период раньше старта сбора deal_events (03.04.2026). */
export async function fetchWorkDaysCohort(opts: WorkDaysCohortOptions): Promise<CalledToSaleCohortResult | null> {
  const periodToStr = periodDateStrFromInstant(opts.period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const rows = await fetchWorkRows(opts);
  return buildLifeTablePoints(toLifeTableRows(rows));
}

// ── Дрилл-даун: список сделок одного дня (задача 2546/2553) ─────────────────
export async function fetchWorkDaysCohortDealIds(
  opts: WorkDaysCohortOptions & { day: number; filter: 'all' | 'sold' },
): Promise<number[] | null> {
  const periodToStr = periodDateStrFromInstant(opts.period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const rows = await fetchWorkRows(opts);
  return selectLifeTableDealIds(toLifeTableRows(rows), opts.day, opts.filter);
}
