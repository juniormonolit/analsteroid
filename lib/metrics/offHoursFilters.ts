import type { CreatedTimeFilter, FirstTouchFilter } from './types';
import { isWorkingDaySql } from './productionCalendar';

// Задача 1569 (владелец, «побаловаться»): два экспериментальных фильтра для
// сегментации сделок по нерабочему времени — цель: сравнить конверсию сделок,
// пришедших в нерабочее время, в разрезе «дежурный обработал сразу vs дождались
// открытия офиса». WHERE-фрагменты в том же стиле, что и lib/metrics/sqlGen.ts
// (resolveFilterClause) / pgWhere в byManagers.ts — строка инлайнится в SQL и
// участвует в ключе row-кэша движков отчётов (createdTimeFilter/firstTouchFilter
// НЕ funnel-based, поэтому их нельзя фильтровать постфактум в памяти, как
// dealScope/clientType — см. computeAllowedFunnels в byManagers/byProductGroups/
// bySources.ts).

const TZ = 'Europe/Moscow';

// Единственная согласованная в проекте граница начала рабочего дня — 09:00 МСК
// (та же, что в features/reports/engine/managerActivity.ts и lib/plans/dailyPlan.ts
// для «рабочих дней»; отдельного часового понятия «рабочее время» до этой задачи
// в коде не было — введено здесь).
export const WORKDAY_START_HOUR = 9;
export const WORKDAY_END_HOUR = 18;

/** Наивный (без TZ) МСК wall-clock timestamp для произвольного timestamptz-выражения. */
function mskLocal(tsExpr: string): string {
  return `(${tsExpr} AT TIME ZONE '${TZ}')`;
}

/** CASE-выражение, классифицирующее момент времени на рабочее/нерабочее/выходной день.
 *
 * Фикс 30.07 (владелец: «берёшь рабочий календарь этого года и предыдущего…»):
 * раньше «выходной» определялся тупо по ISODOW 6-7 (сб/вс) — праздники среди
 * недели (12.06, 23.02, майские, новогодние каникулы) считались буднями, а
 * перенесённая РАБОЧАЯ суббота (01.11.2025) — выходным. Теперь «рабочий день»
 * = по производственному календарю РФ (lib/metrics/productionCalendar.ts, там
 * же напоминание пополнять ежегодно); «рабочее время» = рабочий день И
 * 09:00-18:00. День/час — в МСК (AT TIME ZONE выше), время в БД — UTC. */
function createdBucketExpr(tsExpr: string): string {
  const local = mskLocal(tsExpr);
  const workingDay = isWorkingDaySql(`(${local})::date`);
  const t = `(${local})::time`;
  return `
    CASE
      WHEN ${workingDay} AND ${t} >= TIME '${WORKDAY_START_HOUR}:00' AND ${t} < TIME '${WORKDAY_END_HOUR}:00' THEN 'business_hours'
      WHEN ${workingDay} THEN 'weekday_after_hours'
      ELSE 'weekend'
    END`;
}

/**
 * WHERE-фрагмент фильтра «Создана» по алиасу таблицы сделок (`d.created_at`).
 * '' — фильтр не задан ('all'/undefined), условие не добавляется в WHERE.
 */
export function createdTimeWhere(alias: string, filter: CreatedTimeFilter | undefined): string {
  if (!filter || filter === 'all') return '';
  return `(${createdBucketExpr(`${alias}.created_at`)}) = '${filter}'`;
}

/**
 * Ближайший момент открытия (МСК, приведён обратно к timestamptz) НА ИЛИ ПОСЛЕ
 * данного timestamptz-выражения:
 *  - рабочий день 09:00-18:00 → сам момент (уже открыто — окно нулевое);
 *  - рабочий день до 09:00 → 09:00 того же дня;
 *  - иначе (рабочий после 18:00 / нерабочий день) → 09:00 БЛИЖАЙШЕГО РАБОЧЕГО
 *    дня по производственному календарю (фикс 30.07 — раньше «следующий рабочий»
 *    искался наивным сдвигом по дню недели: пятница вечером 12.06.2026 давала
 *    «пн 15.06» верно случайно, а вечер 31.12 давал «01.01» — праздник).
 *
 * Ближайший рабочий день ищется скалярным подзапросом по generate_series на
 * 21 день вперёд — с запасом покрывает самый длинный нерабочий пробег
 * (новогодние каникулы + выходные ≈ 11 дней).
 */
function nextBusinessOpenExpr(tsExpr: string): string {
  const local = mskLocal(tsExpr);
  const day = `date_trunc('day', ${local})`;
  const open = `(${day} + interval '${WORKDAY_START_HOUR} hours')`;
  const close = `(${day} + interval '${WORKDAY_END_HOUR} hours')`;
  const workingToday = isWorkingDaySql(`(${local})::date`);
  const nextWorkingOpen = `(
    SELECT MIN(_g)::timestamp + interval '${WORKDAY_START_HOUR} hours'
    FROM generate_series(((${local})::date + 1)::timestamp, ((${local})::date + 21)::timestamp, interval '1 day') AS _g
    WHERE ${isWorkingDaySql('(_g)::date')}
  )`;
  const naive = `
    CASE
      WHEN ${workingToday} AND ${local} < ${open}  THEN ${open}
      WHEN ${workingToday} AND ${local} < ${close} THEN ${local}
      ELSE ${nextWorkingOpen}
    END`;
  return `((${naive}) AT TIME ZONE '${TZ}')`;
}

/**
 * WHERE-фрагмент фильтра «Первая обработка» — сравнивает время ПЕРВОГО события
 * sa.deal_events по сделке (MIN(event_at)) с ближайшим открытием относительно
 * created_at этой же сделки. Сделки без единого события (включая весь период до
 * старта сбора deal_events, 03.04.2026 — DEAL_EVENTS_DATA_START в
 * managerActivity.ts) под непустым вариантом исключаются (IS NOT NULL) — честно,
 * а не нулём/искажением сегмента.
 */
export function firstTouchWhere(alias: string, filter: FirstTouchFilter | undefined): string {
  if (!filter || filter === 'all') return '';
  const firstEvent = `(SELECT MIN(_fe.event_at) FROM deal_events _fe WHERE _fe.deal_id = ${alias}.deal_id)`;
  const nextOpen = nextBusinessOpenExpr(`${alias}.created_at`);
  const cmp = filter === 'business_hours' ? '>=' : '<';
  return `${firstEvent} IS NOT NULL AND ${firstEvent} ${cmp} ${nextOpen}`;
}
