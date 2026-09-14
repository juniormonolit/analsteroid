-- Задача владельца 14.09.2026: «Добавь метрики "Просрочено больше 5 раб дней"
-- и еще такие же на 10, 30, 60 и 90».
--
-- Зачем. Базовая «Просроченные дела» (миграция 198) сваливает в одну кучу дело,
-- забытое вчера вечером, и дело, которое никто не трогал с мая. Разговор с
-- менеджером в этих случаях разный, а цифра одна. Пять порогов дают глубину
-- запущенности: на живых данных 14.09 из 1933 просроченных дел 1061 висит
-- дольше 5 рабочих дней, 853 — дольше 10, 533 — дольше 30, 427 — дольше 60 и
-- 376 — дольше 90.
--
-- Дни РАБОЧИЕ, по производственному календарю РФ (lib/metrics/
-- productionCalendar.ts, функция workingDaysAgoMsk): дело со сроком в пятницу
-- в понедельник просрочено на 1 рабочий день, а не на 3. С календарными днями
-- метрика скакала бы каждые выходные сама по себе.
--
-- Пороги ВЛОЖЕННЫЕ, не взаимоисключающие: дело на 40 рабочих дней попадает и в
-- «>5», и в «>10», и в «>30». Столбцы читаются как воронка слева направо, и
-- каждый отвечает на свой вопрос «сколько висит дольше N» без сложения соседних.
--
-- Реализация: metric_type='external', тот же снимок sa.deals.activities, что и
-- у остальных восьми (features/reports/engine/dealsActivities.ts) — отсечки
-- считаются в JS по календарю и уходят в SQL готовыми моментами ($1..$5),
-- потому что производственный календарь живёт в коде метрик, а не в sa-БД.
-- Только reportSlug='by-managers', снимок «сейчас» одинаков в current/comparison.
--
-- sort_order 1708–1712 (1700–1707 заняты миграциями 156/198).
-- БД: YC analytics (run_analytics.mjs). Идемпотентно (ON CONFLICT).

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies,
                      tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places,
                      aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
                      category, sort_order, description)
VALUES
  ('dela_overdue_5wd',  'Дела просрочены > 5 раб. дней',  'Проср. >5 р.д.',  'external', 'int', NULL, ARRAY[]::text[],
   '{dela,tasks,overdue}', false, true, false, false, 0, 'sum', false, false, true, false,
   'Дела и задачи', 1708,
   'Дела активных сделок менеджера, просроченные больше чем на 5 РАБОЧИХ дней (срок date_end раньше момента «5 рабочих дней назад» по производственному календарю РФ). Порог вложенный: сюда попадают и дела, просроченные на 10, 30, 60, 90 дней. Снимок на текущий момент, обновляется 4 раза в день.'),
  ('dela_overdue_10wd', 'Дела просрочены > 10 раб. дней', 'Проср. >10 р.д.', 'external', 'int', NULL, ARRAY[]::text[],
   '{dela,tasks,overdue}', false, true, false, false, 0, 'sum', false, false, true, false,
   'Дела и задачи', 1709,
   'Дела активных сделок менеджера, просроченные больше чем на 10 РАБОЧИХ дней (примерно две рабочие недели). Порог вложенный — включает более глубокие. Снимок на текущий момент, обновляется 4 раза в день.'),
  ('dela_overdue_30wd', 'Дела просрочены > 30 раб. дней', 'Проср. >30 р.д.', 'external', 'int', NULL, ARRAY[]::text[],
   '{dela,tasks,overdue}', false, true, false, false, 0, 'sum', false, false, true, false,
   'Дела и задачи', 1710,
   'Дела активных сделок менеджера, просроченные больше чем на 30 РАБОЧИХ дней (примерно полтора календарных месяца). Порог вложенный — включает более глубокие. Снимок на текущий момент, обновляется 4 раза в день.'),
  ('dela_overdue_60wd', 'Дела просрочены > 60 раб. дней', 'Проср. >60 р.д.', 'external', 'int', NULL, ARRAY[]::text[],
   '{dela,tasks,overdue}', false, true, false, false, 0, 'sum', false, false, true, false,
   'Дела и задачи', 1711,
   'Дела активных сделок менеджера, просроченные больше чем на 60 РАБОЧИХ дней (примерно три календарных месяца). Порог вложенный — включает более глубокие. Снимок на текущий момент, обновляется 4 раза в день.'),
  ('dela_overdue_90wd', 'Дела просрочены > 90 раб. дней', 'Проср. >90 р.д.', 'external', 'int', NULL, ARRAY[]::text[],
   '{dela,tasks,overdue}', false, true, false, false, 0, 'sum', false, false, true, false,
   'Дела и задачи', 1712,
   'Дела активных сделок менеджера, просроченные больше чем на 90 РАБОЧИХ дней (примерно полгода календарных) — практически брошенные. Снимок на текущий момент, обновляется 4 раза в день.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  tags = EXCLUDED.tags, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok,
  is_calc_ok = EXCLUDED.is_calc_ok, description = EXCLUDED.description;
