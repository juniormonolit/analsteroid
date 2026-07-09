import { analyticsDb, systemDb } from '@/lib/db/clients';
import { toSqlInterval, type DateRange } from '@/lib/period';
import { differenceInCalendarDays } from 'date-fns';

// Метрики активности менеджеров (спека owners-inbox/analsteroid-edits-spec-20260709.md,
// правки собрания 09.07 + допы, задача от 10.07): «Дней в работе» / «% выхода» /
// «Сделок/день». Смысл только в разрезе МЕНЕДЖЕРОВ (deal_events атрибутируется на
// менеджера, не на товарную группу/источник) — эти метрики инжектятся ТОЛЬКО в отчёт
// «по менеджерам» (см. app/api/reports/run/route.ts), для by-product-groups/by-sources
// они просто отсутствуют в row.metrics → computeCalculated отдаёт null по цепочке
// зависимостей (это и есть требуемое «верни null / не показывай»).
//
// «Рабочий день менеджера» (формула владельца, дословно): будний день (Пн–Пт, по
// календарной дате МСК), в который менеджер И получил хотя бы одну ПЕРВИЧНУЮ сделку
// (deals.created_at, funnel_type=primary), И сделал хотя бы одну смену стадии по любой
// сделке (deal_events).
//
// Атрибуция смены стадии — deal_events.manager_id. Проверено живым запросом 10.07
// (dev-креды junior_user, sa.deal_events): колонка ЕСТЬ и NOT NULL (не пришлось
// фолбэчить на current_manager_id, как допускала спека); домен ID совпадает с
// sa.deals.current_manager_id — из ~165k событий и десятков менеджеров нашёлся ровно
// 1 «осиротевший» manager_id (2105, 1 событие) без текущей сделки на этом менеджере
// — статистически незначимо, отдельно не обрабатываем.
export const DEAL_EVENTS_DATA_START = '2026-04-03'; // MIN(event_at) в sa.deal_events, проверено живым запросом 10.07

export interface ManagerActivityRow {
  workedDays: number;
  primaryDealsForActivity: number;
}

/**
 * Один агрегатный запрос (без N+1): три CTE на индексах created_at/event_at
 * (idx_sa_deals_created_at, idx_sa_deal_events_event_at), INNER JOIN дней создания и
 * дней событий по (manager_id, day) + будний фильтр в конце, плюс отдельный подсчёт
 * первичных сделок (для «Сделок/день» — СОЗНАТЕЛЬНО независим от пилюли
 * Первичные/Повторные отчёта: в отличие от каталожной primary_deals_count, чьё итоговое
 * значение по факту зависит от пилюли dealScope через funnel_id-группировку в
 * features/reports/engine/byManagers.ts::aggregate(), «Сделок/день» по требованию
 * владельца ВСЕГДА про первичные сделки — поэтому считаем свою копию числителя, а не
 * переиспользуем каталожную метрику).
 *
 * Возвращает null, если ВЕСЬ период раньше DEAL_EVENTS_DATA_START (данных о сменах
 * стадии нет вообще — 0 было бы ложью, честный null, спека: «если период раньше —
 * честно null, не ноль»). Частичное пересечение периода с началом сбора НЕ считается
 * особым случаем — SQL просто не найдёт событий до даты старта, что само по себе
 * корректно (не нужно обнулять весь период).
 */
export async function fetchManagerActivity(period: DateRange): Promise<Map<string, ManagerActivityRow> | null> {
  const periodToStr = period.to.toISOString().slice(0, 10);
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const { from, toExcl } = toSqlInterval(period);

  const sql = `
WITH creation_days AS (
  SELECT current_manager_id AS manager_id,
         (created_at AT TIME ZONE 'Europe/Moscow')::date AS day
  FROM deals
  WHERE created_at >= $1 AND created_at < $2
    AND funnel_id IN (SELECT id FROM funnels WHERE is_repeat = false)
  GROUP BY 1, 2
),
event_days AS (
  SELECT manager_id,
         (event_at AT TIME ZONE 'Europe/Moscow')::date AS day
  FROM deal_events
  WHERE event_at >= $1 AND event_at < $2
  GROUP BY 1, 2
),
worked AS (
  SELECT c.manager_id, COUNT(*) AS worked_days
  FROM creation_days c
  JOIN event_days e ON e.manager_id = c.manager_id AND e.day = c.day
  WHERE EXTRACT(ISODOW FROM c.day) BETWEEN 1 AND 5
  GROUP BY c.manager_id
),
primary_deals AS (
  SELECT current_manager_id AS manager_id, COUNT(*) AS cnt
  FROM deals
  WHERE created_at >= $1 AND created_at < $2
    AND funnel_id IN (SELECT id FROM funnels WHERE is_repeat = false)
  GROUP BY 1
)
SELECT COALESCE(w.manager_id, p.manager_id)::text AS manager_id,
       COALESCE(w.worked_days, 0)::int AS worked_days,
       COALESCE(p.cnt, 0)::int AS primary_deals_for_activity
FROM worked w
FULL OUTER JOIN primary_deals p ON p.manager_id = w.manager_id
  `.trim();

  const res = await analyticsDb().query<{
    manager_id: string; worked_days: number; primary_deals_for_activity: number;
  }>(sql, [from, toExcl]);

  const map = new Map<string, ManagerActivityRow>();
  for (const r of res.rows) {
    map.set(r.manager_id, {
      workedDays: r.worked_days,
      primaryDealsForActivity: r.primary_deals_for_activity,
    });
  }
  return map;
}

/**
 * Рабочих дней ПО ПРОИЗВОДСТВЕННОМУ КАЛЕНДАРЮ за период — для «% выхода».
 * Спека (10.07): «существующий механизм working_calendar — тот, что за тумблером
 * дневного плана; единственное согласованное место, где календарь используется ВСЕГДА».
 * Читаем working_calendar НАПРЯМУЮ, БЕЗ учёта тумблера divide20/calendar
 * (lib/plans/dailyPlan.ts::getDailyPlanMode) — тот тумблер по умолчанию (divide20)
 * игнорирует таблицу-календарь и считает приближённо (месяц÷20), что здесь неуместно:
 * «% выхода» должен быть настоящим производственным календарём с праздниками.
 *
 * Возвращает null, если календарь не заполнен на ВЕСЬ период (не гадаем частичными
 * числами — честный null, симметрично требованию про deal_events).
 */
export async function getCalendarWorkingDaysInPeriod(period: DateRange): Promise<number | null> {
  const fromStr = period.from.toISOString().slice(0, 10);
  const toStr = period.to.toISOString().slice(0, 10);
  const totalCalendarDays = differenceInCalendarDays(period.to, period.from) + 1;

  const res = await systemDb().query<{ total_working: string; covered: string }>(
    `SELECT COUNT(*) FILTER (WHERE is_working) AS total_working, COUNT(*) AS covered
     FROM working_calendar
     WHERE date >= $1::date AND date <= $2::date`,
    [fromStr, toStr],
  );
  const covered = parseInt(res.rows[0]?.covered ?? '0', 10);
  if (covered < totalCalendarDays) return null; // календарь не заполнен на весь период

  return parseInt(res.rows[0]?.total_working ?? '0', 10);
}
