import { analyticsDb } from '@/lib/db/clients';
import type { SnapshotFlatRow } from './stageSnapshot';

// «Дела и задачи» (задача #5589, Серёга) — снимок sa.deals.activities (jsonb),
// НЕ период-зависимая метрика: как и stageSnapshot.ts/managerActivity.ts, это
// «сейчас» на момент запроса (сама activities обновляется сверкой 4 раза в
// сутки), поэтому один и тот же снимок отдаётся и в current, и в comparison.
//
// Источник и определения (справочник owners-inbox/sa-deals-activities-field-
// guide-20260907.html, статистика owners-inbox/sa-deals-activities-analysis-
// 20260907.html, зафиксировано в брифе задачи 5589):
//   Дела  = элементы activities с type <> 'CRM_TASKS_TASK'.
//   Задачи = элементы activities с type = 'CRM_TASKS_TASK' (модуль «Задачи»,
//            на этом портале в основном запросы логистам от БП).
//   «Сегодня»   — date_end::date (MSK) = сегодня (MSK).
//   «Просрочено» — date_end < now() И date_end не заглушка '9999-12-31…'
//            (у трети открытых дел заглушка = «без срока», не просрочка).
//
// Задача #5594 (владелец): schema activities переведена на 6 полей —
// activity_id/type/name/responsible_id/date_create/date_end (id/deadline/
// created/subject/completed/priority/… больше не будет; заглушка '9999-…'
// у date_end больше не приходит — NULL = без срока). SQL толерантен к обеим
// схемам на переходный период: COALESCE(type, provider_id),
// COALESCE(date_end, deadline) — старая заглушка 9999 по-прежнему отсекается.
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

export const DELA_ZADACHI_METRIC_IDS = [
  'dela_total', 'dela_overdue', 'dela_today', 'deals_without_dela',
  'zadachi_total', 'zadachi_overdue', 'zadachi_today', 'deals_with_active_zapros',
];

let _cache: { rows: SnapshotFlatRow[]; at: number } | null = null;
const CACHE_TTL = 2 * 60 * 1000; // 2 мин — тот же порядок, что SNAPSHOT_TTL в stageSnapshot.ts

/**
 * Хотфикс (задача #5589, диагноз Маркуса): группировка ТОЛЬКО по manager_id (без
 * funnel_id) ломала строку менеджера в byManagers.ts::aggregate() — та строку
 * дропает целиком, если НИ ОДНА её funnel_id-строка не проходит пилюли
 * dealScope/clientType (тот же класс бага, что чинили 09.07 для ППП/ППО через
 * scopeIndependentIds, см. migrations/061). Снимок «сейчас» по природе
 * scope-independent (сделка не рождается заново каждый период), но чтобы этот
 * обход (scopeIndependentIds в byManagers.ts) вообще имел что фильтровать,
 * строки ОБЯЗАНЫ нести реальный d.funnel_id — как pillRows в stageSnapshot.ts.
 * Поэтому группировка здесь — (manager_id, funnel_id), а не голый manager_id;
 * DELA_ZADACHI_METRIC_IDS в byManagers.ts добавлены в scopeIndependentIds
 * ВРУЧНУЮ (не через metrics.tags — эти 8 метрик metric_type='external', а
 * scopeIndependentIds там строится только из metricType='collected').
 *
 * Один агрегатный запрос по sa.deals.activities для ВСЕХ активных сделок разом.
 * Без параметра периода (снимок). Пустой activities ('[]') безопасен: LEFT JOIN
 * LATERAL ... ON true не добавляет строк с элементом, счётчики FILTER просто не
 * находят совпадений — но строка (manager_id, funnel_id) с нулями всё равно
 * попадает в вывод (важно для «Сделки без дел»).
 */
export async function fetchDealsActivitiesSnapshot(): Promise<SnapshotFlatRow[]> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL) return _cache.rows;

  const logistFilterSql = DELA_ZADACHI_LOGIST_FILTER_ENABLED
    ? `AND e->>'responsible_id' = ANY($1::text[])`
    : '';
  const params = DELA_ZADACHI_LOGIST_FILTER_ENABLED ? [LOGIST_BITRIX_IDS] : [];

  const sql = `
WITH active_deals AS (
  SELECT d.deal_id, d.current_manager_id AS manager_id, d.funnel_id, d.activities
  FROM deals d
  JOIN stages s ON s.id = d.stage_id
  WHERE s.stage_type NOT IN ('WON', 'LOSS')
    AND d.current_manager_id IS NOT NULL
),
items AS (
  SELECT
    ad.manager_id, ad.funnel_id,
    e,
    -- Переходная схема (задача #5594, владелец): новые поля activity_id/type/
    -- name/responsible_id/date_create/date_end заменяют id/deadline/created/
    -- subject/completed/priority/…; type остаётся тем же именем (= PROVIDER_ID,
    -- как и раньше), но на переходный период COALESCE на provider_id — на
    -- случай, если где-то в снимке ещё встретится старое имя. date_end —
    -- замена deadline: заглушки '9999-12-31…' больше НЕ будет (NULL = без
    -- срока), но старые элементы с deadline='9999-...' всё ещё могут висеть в
    -- снимке до следующей сверки — фильтр по заглушке оставлен.
    COALESCE(e->>'type', e->>'provider_id') AS e_type,
    COALESCE(e->>'date_end', e->>'deadline') AS e_deadline
  FROM active_deals ad
  LEFT JOIN LATERAL jsonb_array_elements(ad.activities) e ON true
),
item_agg AS (
  SELECT
    manager_id, funnel_id,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e_type <> 'CRM_TASKS_TASK'
    ) AS dela_total,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e_type <> 'CRM_TASKS_TASK'
        AND e_deadline IS NOT NULL AND e_deadline NOT LIKE '9999-12-31%'
        AND e_deadline::timestamptz < now()
    ) AS dela_overdue,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e_type <> 'CRM_TASKS_TASK'
        AND e_deadline IS NOT NULL AND e_deadline NOT LIKE '9999-12-31%'
        AND (e_deadline::timestamptz AT TIME ZONE 'Europe/Moscow')::date
          = (now() AT TIME ZONE 'Europe/Moscow')::date
    ) AS dela_today,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e_type = 'CRM_TASKS_TASK'
    ) AS zadachi_total,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e_type = 'CRM_TASKS_TASK'
        AND e_deadline IS NOT NULL AND e_deadline NOT LIKE '9999-12-31%'
        AND e_deadline::timestamptz < now()
    ) AS zadachi_overdue,
    count(*) FILTER (
      WHERE e IS NOT NULL AND e_type = 'CRM_TASKS_TASK'
        AND e_deadline IS NOT NULL AND e_deadline NOT LIKE '9999-12-31%'
        AND (e_deadline::timestamptz AT TIME ZONE 'Europe/Moscow')::date
          = (now() AT TIME ZONE 'Europe/Moscow')::date
    ) AS zadachi_today
  FROM items
  GROUP BY manager_id, funnel_id
),
deal_flags AS (
  SELECT
    ad.manager_id, ad.funnel_id, ad.deal_id,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(ad.activities) x
      WHERE COALESCE(x->>'type', x->>'provider_id') <> 'CRM_TASKS_TASK'
    ) AS has_dela,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(ad.activities) x
      WHERE COALESCE(x->>'type', x->>'provider_id') = 'CRM_TASKS_TASK' ${logistFilterSql}
    ) AS has_zapros
  FROM active_deals ad
),
deal_agg AS (
  SELECT
    manager_id, funnel_id,
    count(*) FILTER (WHERE NOT has_dela) AS deals_without_dela,
    count(*) FILTER (WHERE has_zapros) AS deals_with_active_zapros
  FROM deal_flags
  GROUP BY manager_id, funnel_id
)
SELECT
  COALESCE(i.manager_id, a.manager_id)::text AS manager_id,
  COALESCE(i.funnel_id, a.funnel_id) AS funnel_id,
  COALESCE(i.dela_total, 0)::int AS dela_total,
  COALESCE(i.dela_overdue, 0)::int AS dela_overdue,
  COALESCE(i.dela_today, 0)::int AS dela_today,
  COALESCE(a.deals_without_dela, 0)::int AS deals_without_dela,
  COALESCE(i.zadachi_total, 0)::int AS zadachi_total,
  COALESCE(i.zadachi_overdue, 0)::int AS zadachi_overdue,
  COALESCE(i.zadachi_today, 0)::int AS zadachi_today,
  COALESCE(a.deals_with_active_zapros, 0)::int AS deals_with_active_zapros
FROM item_agg i
FULL JOIN deal_agg a ON a.manager_id = i.manager_id AND a.funnel_id = i.funnel_id
  `.trim();

  const res = await analyticsDb().query<{
    manager_id: string; funnel_id: number;
    dela_total: number; dela_overdue: number; dela_today: number; deals_without_dela: number;
    zadachi_total: number; zadachi_overdue: number; zadachi_today: number; deals_with_active_zapros: number;
  }>(sql, params);

  const rows: SnapshotFlatRow[] = res.rows.map(r => ({
    dimension_id: r.manager_id,
    funnel_id: r.funnel_id,
    dela_total: r.dela_total,
    dela_overdue: r.dela_overdue,
    dela_today: r.dela_today,
    deals_without_dela: r.deals_without_dela,
    zadachi_total: r.zadachi_total,
    zadachi_overdue: r.zadachi_overdue,
    zadachi_today: r.zadachi_today,
    deals_with_active_zapros: r.deals_with_active_zapros,
  }));
  _cache = { rows, at: Date.now() };
  return rows;
}
