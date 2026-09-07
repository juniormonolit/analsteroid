-- Задача #5555 (Серёга, «стоячая санкция — по одной сразу на прод»): 7 метрик-заглушек
-- для будущего раздела «Дела и задачи». Сущности «Дела» и «Задачи» в БД пока НЕТ —
-- появятся позже как новые таблицы, аналогичные sa.deals/sa.contacts. Логику расчёта
-- Серёга объяснит потом. До тех пор все 7 метрик просто возвращают 0 во всех режимах
-- конструктора (период/сравнение/группировка/pinned/highlight и т.д.), не трогая БД.
--
-- Реализация: metric_type='calculated', formula='0', dependencies=[] — вычисляется
-- в features/reports/engine/calculated.ts (computeCalculated) ПОСЛЕ collected/external,
-- одинаково для current/comparison/totals (см. app/api/reports/run/route.ts:965,998,1000).
-- Формула без ссылок на другие метрики (evalFormula пропускает голое число '0') —
-- не зависит от наличия/отсутствия других колонок, поэтому безопасна при пустых
-- данных и в любом режиме отображения (full/partial/compact/current).
--
-- Категория — новая «Дела и задачи» (добавлена в CATEGORY_ORDER в
-- features/reports/ui/MetricPanel.tsx, после «Планы»). sort_order 1700-1706 —
-- свободный диапазон (существующие категории занимают до 1371).
--
-- БД: YC analytics (run_analytics.mjs) — каталог metrics.

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies,
                      tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places,
                      aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
                      category, sort_order, description)
VALUES
  ('dela_total', 'Всего дел', 'Дела всего', 'calculated', 'int', '0', ARRAY[]::text[],
   '{dela,tasks,stub}', false, true, false, false, 0, 'sum', false, true, false, true,
   'Дела и задачи', 1700,
   'TODO(Серёга, задача 5555): заглушка, всегда 0. Сущность «Дела» появится позже как новая таблица (аналог sa.deals/sa.contacts). Логику расчёта объяснит Серёга.'),
  ('dela_overdue', 'Просроченные дела', 'Дела просроч.', 'calculated', 'int', '0', ARRAY[]::text[],
   '{dela,tasks,stub}', false, true, false, false, 0, 'sum', false, true, false, true,
   'Дела и задачи', 1701,
   'TODO(Серёга, задача 5555): заглушка, всегда 0. Ждёт таблицу «Дела» и правило «просрочено».'),
  ('dela_today', 'Дела на сегодня', 'Дела сегодня', 'calculated', 'int', '0', ARRAY[]::text[],
   '{dela,tasks,stub}', false, true, false, false, 0, 'sum', false, true, false, true,
   'Дела и задачи', 1702,
   'TODO(Серёга, задача 5555): заглушка, всегда 0. Ждёт таблицу «Дела» и определение «на сегодня».'),
  ('deals_without_dela', 'Сделки без дел', 'Сделки без дел', 'calculated', 'int', '0', ARRAY[]::text[],
   '{dela,tasks,stub}', false, true, false, false, 0, 'sum', false, true, false, true,
   'Дела и задачи', 1703,
   'TODO(Серёга, задача 5555): заглушка, всегда 0. Ждёт таблицу «Дела» и связь со сделками (sa.deals).'),
  ('zadachi_total', 'Всего задач', 'Задачи всего', 'calculated', 'int', '0', ARRAY[]::text[],
   '{dela,tasks,stub}', false, true, false, false, 0, 'sum', false, true, false, true,
   'Дела и задачи', 1704,
   'TODO(Серёга, задача 5555): заглушка, всегда 0. Сущность «Задачи» появится позже как новая таблица (аналог sa.deals/sa.contacts). Логику расчёта объяснит Серёга.'),
  ('zadachi_overdue', 'Просроченных задач', 'Задачи просроч.', 'calculated', 'int', '0', ARRAY[]::text[],
   '{dela,tasks,stub}', false, true, false, false, 0, 'sum', false, true, false, true,
   'Дела и задачи', 1705,
   'TODO(Серёга, задача 5555): заглушка, всегда 0. Ждёт таблицу «Задачи» и правило «просрочено».'),
  ('zadachi_today', 'Задач на сегодня', 'Задачи сегодня', 'calculated', 'int', '0', ARRAY[]::text[],
   '{dela,tasks,stub}', false, true, false, false, 0, 'sum', false, true, false, true,
   'Дела и задачи', 1706,
   'TODO(Серёга, задача 5555): заглушка, всегда 0. Ждёт таблицу «Задачи» и определение «на сегодня».')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  tags = EXCLUDED.tags, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_calc_ok = EXCLUDED.is_calc_ok,
  description = EXCLUDED.description;
