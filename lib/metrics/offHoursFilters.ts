import type { CreatedTimeFilter, FirstTouchFilter } from './types';

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

/** CASE-выражение, классифицирующее момент времени на будни-рабочее/будни-нерабочее/выходные. */
function createdBucketExpr(tsExpr: string): string {
  const local = mskLocal(tsExpr);
  const dow = `EXTRACT(ISODOW FROM ${local})`; // 1=Пн..7=Вс
  const t = `(${local})::time`;
  return `
    CASE
      WHEN ${dow} BETWEEN 1 AND 5 AND ${t} >= TIME '${WORKDAY_START_HOUR}:00' AND ${t} < TIME '${WORKDAY_END_HOUR}:00' THEN 'business_hours'
      WHEN ${dow} BETWEEN 1 AND 5 THEN 'weekday_after_hours'
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
 *  - будни 09:00-18:00 → сам момент (уже открыто — окно нулевое);
 *  - будни до 09:00 → 09:00 того же дня;
 *  - будни после 18:00 → 09:00 следующего буднего дня (Пт вечер → Пн);
 *  - выходные → 09:00 ближайшего понедельника.
 */
function nextBusinessOpenExpr(tsExpr: string): string {
  const local = mskLocal(tsExpr);
  const dow = `EXTRACT(ISODOW FROM ${local})`;
  const day = `date_trunc('day', ${local})`;
  const open = `(${day} + interval '${WORKDAY_START_HOUR} hours')`;
  const close = `(${day} + interval '${WORKDAY_END_HOUR} hours')`;
  const naive = `
    CASE
      WHEN ${dow} BETWEEN 1 AND 5 AND ${local} < ${open}  THEN ${open}
      WHEN ${dow} BETWEEN 1 AND 5 AND ${local} < ${close} THEN ${local}
      WHEN ${dow} = 5              THEN ${day} + interval '3 days ${WORKDAY_START_HOUR} hours'
      WHEN ${dow} BETWEEN 1 AND 4  THEN ${day} + interval '1 day ${WORKDAY_START_HOUR} hours'
      WHEN ${dow} = 6              THEN ${day} + interval '2 days ${WORKDAY_START_HOUR} hours'
      ELSE                              ${day} + interval '1 day ${WORKDAY_START_HOUR} hours'
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
