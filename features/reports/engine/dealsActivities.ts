import { analyticsDb } from '@/lib/db/clients';

// «Дела и задачи» (задача #5589, Серёга) — снимок sa.deals.activities (jsonb),
// НЕ период-зависимая метрика: как и stageSnapshot.ts/managerActivity.ts, это
// «сейчас» на момент запроса (сама activities обновляется сверкой 4 раза в
// сутки), поэтому один и тот же снимок отдаётся и в current, и в comparison —
// колонка сравнения естественно совпадает (см. enrichDealsActivities в
// app/api/reports/run/route.ts, паттерн идентичен fetchManagerActivity).
//
// Источник и определения (справочник owners-inbox/sa-deals-activities-field-
// guide-20260907.html, статистика owners-inbox/sa-deals-activities-analysis-
// 20260907.html, зафиксировано в брифе задачи 5589):
//   Дела  = элементы activities с type <> 'CRM_TASKS_TASK'.
//   Задачи = элементы activities с type = 'CRM_TASKS_TASK' (модуль «Задачи»,
//            на этом портале в основном запросы логистам от БП).
//   «Сегодня»   — deadline::date (MSK) = сегодня (MSK).
//   «Просрочено» — deadline < now() И deadline не заглушка '9999-12-31…'
//            (у трети открытых дел заглушка = «без срока», не просрочка).
//   Активная сделка = current stage НЕ в финальной стадии (sa.stages.stage_type
//            NOT IN ('WON','LOSS')) — 27% открытых дел висят на закрытых
//            сделках (см. анализ 20260907), это должно резаться, как и в
//            stageSnapshot.ts (тот же критерий).
//
// «Сделки с активным запросом» (8-я метрика, добавлена 07.09) = активные
// сделки менеджера, у которых есть хотя бы одна задача (CRM_TASKS_TASK).
// Доп. правка Серёги 07.09 (после проверки Маркуса, отчёт
// sa-deals-logist-tasks-check-20260907.html, раздел 6): по факту type=
// CRM_TASKS_TASK — смешанное множество, только 21,2% (216/1018) реально на
// логистах (Bitrix WORK_POSITION ILIKE '%логист%', проверено user.get); фильтр
// «ответственный = логист» — ВКЛЮЧАЕМАЯ настройка, ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНА
// (считаем по ВСЕМ задачам CRM_TASKS_TASK, не только логистовским). Список
// ниже — временная заглушка (19 проверенных ID, user.get 07.09.2026) до
// справочной таблицы sa.logist_bitrix_ids (рекомендация Маркуса, ещё не
// создана) — заведёт Маркус синком по расписанию. Включить фильтр — поменять
// DELA_ZADACHI_LOGIST_FILTER_ENABLED на true, список ID сверять с новым
// синком, если/когда справочник появится.
export const DELA_ZADACHI_LOGIST_FILTER_ENABLED = false;
export const LOGIST_BITRIX_IDS: string[] = [
  '2062', '7453', '7450', '1881', '2064', '7455', '2001',
  '1882', '1904', '2069', '7449', '2068', '1999', '7448',
  '2000', '2007', '2131', '1996', '1998',
];

export interface DealsActivitiesRow {
  delaTotal: number;
  delaOverdue: number;
  delaToday: number;
  dealsWithoutDela: number;
  zadachiTotal: number;
  zadachiOverdue: number;
  zadachiToday: number;
  dealsWithActiveZapros: number;
}

export const DELA_ZADACHI_METRIC_IDS = [
  'dela_total', 'dela_overdue', 'dela_today', 'deals_without_dela',
  'zadachi_total', 'zadachi_overdue', 'zadachi_today', 'deals_with_active_zapros',
];

let _cache: { map: Map<string, DealsActivitiesRow>; at: number } | null = null;
const CACHE_TTL = 2 * 60 * 1000; // 2 мин — тот же порядок, что SNAPSHOT_TTL в stageSnapshot.ts

/**
 * Один агрегатный запрос по sa.deals.activities для ВСЕХ активных сделок разом,
 * сгруппированный по current_manager_id. Без параметра периода (снимок).
 * Пустой activities ('[]') безопасен: LEFT JOIN LATERAL ... ON true не
 * добавляет строк с элементом, счётчики FILTER просто не находят совпадений.
 */
export async function fetchDealsActivitiesSnapshot(): Promise<Map<string, DealsActivitiesRow>> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL) return _cache.map;

  const logistFilterSql = DELA_ZADACHI_LOGIST_FILTER_ENABLED
    ? `AND e->>'responsible_id' = ANY($1::text[])`
    : '';
  const params = DELA_ZADACHI_LOGIST_FILTER_ENABLED ? [LOGIST_BITRIX_IDS] : [];

  const sql = `
WITH active_deals AS (
  SELECT d.deal_id, d.current_manager_id AS manager_id, d.activities
  FROM deals d
  JOIN stages s ON s.id = d.stage_id
  WHERE s.stage_type NOT IN ('WON', 'LOSS')
    AND d.current_manager_id IS NOT NULL
),
items AS (
  SELECT ad.manager_id, e
  FROM active_deals ad
  LEFT JOIN LATERAL jsonb_array_elements(ad.activities) e ON true
),
item_agg AS (
  SELECT
    manager_id,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e->>'type' <> 'CRM_TASKS_TASK'
    ) AS dela_total,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e->>'type' <> 'CRM_TASKS_TASK'
        AND e->>'deadline' IS NOT NULL AND e->>'deadline' NOT LIKE '9999-12-31%'
        AND (e->>'deadline')::timestamptz < now()
    ) AS dela_overdue,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e->>'type' <> 'CRM_TASKS_TASK'
        AND e->>'deadline' IS NOT NULL AND e->>'deadline' NOT LIKE '9999-12-31%'
        AND ((e->>'deadline')::timestamptz AT TIME ZONE 'Europe/Moscow')::date
          = (now() AT TIME ZONE 'Europe/Moscow')::date
    ) AS dela_today,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e->>'type' = 'CRM_TASKS_TASK'
    ) AS zadachi_total,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e->>'type' = 'CRM_TASKS_TASK'
        AND e->>'deadline' IS NOT NULL AND e->>'deadline' NOT LIKE '9999-12-31%'
        AND (e->>'deadline')::timestamptz < now()
    ) AS zadachi_overdue,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e->>'type' = 'CRM_TASKS_TASK'
        AND e->>'deadline' IS NOT NULL AND e->>'deadline' NOT LIKE '9999-12-31%'
        AND ((e->>'deadline')::timestamptz AT TIME ZONE 'Europe/Moscow')::date
          = (now() AT TIME ZONE 'Europe/Moscow')::date
    ) AS zadachi_today
  FROM items
  GROUP BY manager_id
),
deal_flags AS (
  SELECT
    ad.manager_id,
    ad.deal_id,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(ad.activities) x
      WHERE x->>'type' <> 'CRM_TASKS_TASK'
    ) AS has_dela,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(ad.activities) x
      WHERE x->>'type' = 'CRM_TASKS_TASK' ${logistFilterSql}
    ) AS has_zapros
  FROM active_deals ad
),
deal_agg AS (
  SELECT
    manager_id,
    count(*) FILTER (WHERE NOT has_dela) AS deals_without_dela,
    count(*) FILTER (WHERE has_zapros) AS deals_with_active_zapros
  FROM deal_flags
  GROUP BY manager_id
)
SELECT
  COALESCE(i.manager_id, a.manager_id) AS manager_id,
  COALESCE(i.dela_total, 0)::int AS dela_total,
  COALESCE(i.dela_overdue, 0)::int AS dela_overdue,
  COALESCE(i.dela_today, 0)::int AS dela_today,
  COALESCE(a.deals_without_dela, 0)::int AS deals_without_dela,
  COALESCE(i.zadachi_total, 0)::int AS zadachi_total,
  COALESCE(i.zadachi_overdue, 0)::int AS zadachi_overdue,
  COALESCE(i.zadachi_today, 0)::int AS zadachi_today,
  COALESCE(a.deals_with_active_zapros, 0)::int AS deals_with_active_zapros
FROM item_agg i
FULL JOIN deal_agg a ON a.manager_id = i.manager_id
  `.trim();

  const res = await analyticsDb().query<{
    manager_id: string;
    dela_total: number; dela_overdue: number; dela_today: number; deals_without_dela: number;
    zadachi_total: number; zadachi_overdue: number; zadachi_today: number; deals_with_active_zapros: number;
  }>(sql, params);

  const map = new Map<string, DealsActivitiesRow>();
  for (const r of res.rows) {
    map.set(r.manager_id, {
      delaTotal: r.dela_total,
      delaOverdue: r.dela_overdue,
      delaToday: r.dela_today,
      dealsWithoutDela: r.deals_without_dela,
      zadachiTotal: r.zadachi_total,
      zadachiOverdue: r.zadachi_overdue,
      zadachiToday: r.zadachi_today,
      dealsWithActiveZapros: r.deals_with_active_zapros,
    });
  }
  _cache = { map, at: Date.now() };
  return map;
}
