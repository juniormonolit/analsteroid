-- Задача #5589 (Серёга): наполнить 7 метрик-заглушек «Дела и задачи»
-- (migrations/156_dela_zadachi_metrics.sql, задача #5555) реальными данными из
-- sa.deals.activities + добавить 8-ю метрику «Сделки с активным запросом».
--
-- Источник и определения — см. features/reports/engine/dealsActivities.ts
-- (шапка файла) и справочник/статистику:
--   owners-inbox/sa-deals-activities-field-guide-20260907.html
--   owners-inbox/sa-deals-activities-analysis-20260907.html
-- Дела = activities.type <> 'CRM_TASKS_TASK'; Задачи = activities.type =
-- 'CRM_TASKS_TASK'. «Просрочено» = deadline < now() и deadline не заглушка
-- '9999-12-31…' (у трети открытых дел — «без срока»). «Сегодня» — по МСК.
-- Активная сделка = sa.stages.stage_type NOT IN ('WON','LOSS') (27% открытых дел
-- висят на закрытых сделках, см. анализ 20260907 — резать так же, как
-- stageSnapshot.ts).
--
-- Реализация: metric_type='calculated'+formula='0' → 'external' (расчёт больше
-- НЕ через голую формулу — реальный агрегатный SQL по sa.deals.activities,
-- features/reports/engine/dealsActivities.ts::fetchDealsActivitiesSnapshot(),
-- инжектится в app/api/reports/run/route.ts тем же паттерном, что
-- manager_worked_days_count/stage_now_*/manager_rating: ТОЛЬКО для
-- reportSlug='by-managers', снимок «сейчас» одинаковый в current/comparison
-- (activities обновляется сверкой 4 раза в сутки, история снимка не хранится —
-- сравнение с прошлым периодом всегда даёт то же число, как и у stage_now_*).
-- Группировка по отделу/филиалу/итого — штатный rollup by-managers поверх
-- по-менеджерских значений (aggregation_fn='sum'), доп. кода не требует.
--
-- 8-я метрика «Сделки с активным запросом» (deals_with_active_zapros) —
-- активные сделки менеджера с хотя бы одной задачей (CRM_TASKS_TASK). Доп.
-- правка Серёги 07.09 после проверки Маркуса (owners-inbox/
-- sa-deals-logist-tasks-check-20260907.html, раздел 6): фильтр «ответственный =
-- логист» — включаемая настройка (DELA_ZADACHI_LOGIST_FILTER_ENABLED в
-- dealsActivities.ts), ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНА — считаем по ВСЕМ задачам
-- CRM_TASKS_TASK, т.к. только 21,2% из них реально на логистах (Bitrix
-- WORK_POSITION, user.get). Список из 19 проверенных ID — временная заглушка
-- до справочной таблицы sa.logist_bitrix_ids (рекомендация Маркуса).
--
-- БД: YC analytics (run_analytics.mjs). Идемпотентно (ON CONFLICT).

UPDATE metrics SET
  metric_type = 'external',
  formula = NULL,
  is_collect_ok = true,
  is_calc_ok = false,
  description = v.description
FROM (VALUES
  ('dela_total', 'Всего дел активных сделок менеджера (sa.deals.activities, type <> ''CRM_TASKS_TASK''). Снимок на текущий момент, обновляется 4 раза в день. Финальные стадии (продано/отказ) исключены.'),
  ('dela_overdue', 'Просроченные дела активных сделок менеджера (deadline < сейчас, без учёта заглушки без-срока ''9999-12-31''). Снимок на текущий момент, обновляется 4 раза в день.'),
  ('dela_today', 'Дела активных сделок менеджера со сроком сегодня (МСК). Снимок на текущий момент, обновляется 4 раза в день.'),
  ('deals_without_dela', 'Активные сделки менеджера, у которых нет ни одного дела (sa.deals.activities, type <> ''CRM_TASKS_TASK'' пусто). Снимок на текущий момент, обновляется 4 раза в день.'),
  ('zadachi_total', 'Всего задач (модуль «Задачи», на портале в основном запросы логистам от БП) активных сделок менеджера (sa.deals.activities, type = ''CRM_TASKS_TASK''). Снимок на текущий момент, обновляется 4 раза в день.'),
  ('zadachi_overdue', 'Просроченные задачи активных сделок менеджера (deadline < сейчас, без учёта заглушки без-срока ''9999-12-31''). Снимок на текущий момент, обновляется 4 раза в день.'),
  ('zadachi_today', 'Задачи активных сделок менеджера со сроком сегодня (МСК). Снимок на текущий момент, обновляется 4 раза в день.')
) AS v(id, description)
WHERE metrics.id = v.id;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies,
                      tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places,
                      aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
                      category, sort_order, description)
VALUES
  ('deals_with_active_zapros', 'Сделки с активным запросом', 'Сделки с запросом', 'external', 'int', NULL, ARRAY[]::text[],
   '{dela,tasks}', false, true, false, false, 0, 'sum', false, false, true, false,
   'Дела и задачи', 1707,
   'Активные сделки менеджера, у которых есть хотя бы одна задача (sa.deals.activities, type = ''CRM_TASKS_TASK''). Снимок на текущий момент, обновляется 4 раза в день. ТЕКУЩАЯ трактовка (задача #5589, 07.09.2026): считается по ВСЕМ задачам вида «Задачи», без фильтра по ответственному — проверка Маркуса показала, что лишь 21,2% таких задач реально на логистах (Bitrix WORK_POSITION), остальное — обычные задачи менеджеров/продавцов; фильтр «ответственный = логист» реализован как отключаемая по умолчанию настройка в коде (features/reports/engine/dealsActivities.ts), список логистов — временная заглушка на 19 Bitrix ID.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  tags = EXCLUDED.tags, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok,
  is_calc_ok = EXCLUDED.is_calc_ok, description = EXCLUDED.description;
