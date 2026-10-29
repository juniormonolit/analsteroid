-- Миграция 259: «Золотые рыбки» — четыре метрики раздела «Клиенты»
-- БД: analytics (таблица metrics). Накат с прода (локальный контейнер, YC мёртв с 08.10):
--   ssh … docker exec -i analsteroid-sys-pg psql -U $POSTGRES_USER -d analytics -1 < migrations/259_goldfish_clients.sql
--
-- Порядок: сначала код (движок clientMetrics.ts), потом миграция. Наоборот не упадёт,
-- но до выкатки кода колонки будут пустыми.
--
-- Задача владельца 29.10: «Кол-во золотых рыбок» — заказчики с 5+ отгрузками за период;
-- «в работе» — из них те, у кого последняя отгрузка за последние 30 дней (от сегодня);
-- «спящие» — остаток; «Доля улова» = в работе ÷ все. Смысл и решения при постройке —
-- в шапке блока «Золотые рыбки» в features/reports/engine/clientMetrics.ts.
-- Накат безопасен повторно (ON CONFLICT DO UPDATE).

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source,
  agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui,
  is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
  category, sort_order, description, human_description)
VALUES
  ('goldfish_clients', 'Кол-во золотых рыбок', 'Золотые рыбки', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients}', false, true, false, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1424,
   'Заказчики (contact_id) с 5 и более товарными отгрузками (delivered_at) за период в срезе строки: у менеджера — его отгрузки, у товарной группы — отгрузки группы, в «Итого» — все. Воронки 4/7 и чисто сервисные сделки не считаются.',
   'Сколько у строки крупных постоянных заказчиков. 1) Берём товарные отгрузки периода (доставка/аренда сами по себе не считаются). 2) Считаем отгрузки каждого заказчика — у менеджера только его собственные. 3) Пять и больше — это золотая рыбка.'),
  ('goldfish_active_clients', 'Кол-во золотых рыбок в работе', 'Рыбки в работе', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients}', false, true, false, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1425,
   'Золотые рыбки (5+ товарных отгрузок за период в срезе строки), у которых последняя товарная отгрузка за всю историю — у любого менеджера — не раньше 30 дней до сегодня (полночь МСК). Окно считается от сегодняшней даты, а не от конца периода.',
   'Сколько золотых рыбок мы сейчас держим: из рыбок строки — те, кому что-то отгружали за последние 30 дней (считая от сегодня, у любого менеджера).'),
  ('goldfish_sleeping_clients', 'Спящие золотые рыбки', 'Спящие рыбки', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients}', false, true, false, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1426,
   'Золотые рыбки строки минус рыбки в работе: последней товарной отгрузки не было 30 дней до сегодня (полночь МСК).',
   'Золотые рыбки, с которыми мы не работали последний месяц — за 30 дней до сегодня им ничего не отгружали. Кандидаты на звонок.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui,
  aggregation_fn = EXCLUDED.aggregation_fn, description = EXCLUDED.description,
  human_description = EXCLUDED.human_description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags,
  is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok,
  is_collect_ok, is_calc_ok, category, sort_order, description, human_description, formula_human)
VALUES ('goldfish_catch_pct', 'Доля улова', 'Доля улова', 'calculated', 'percent',
   '[goldfish_active_clients] / [goldfish_clients] * 100', ARRAY['goldfish_active_clients','goldfish_clients'],
   '{clients}', false, true, false, false, 1, 'avg', false, true, false, true, 'Клиенты', 1427,
   'Какой % золотых рыбок строки сейчас в работе (последняя отгрузка за 30 дней до сегодня).',
   'Какую долю крупных постоянных заказчиков мы удерживаем: рыбки в работе ÷ все золотые рыбки.',
   '= «Кол-во золотых рыбок в работе» ÷ «Кол-во золотых рыбок» × 100. В строках отделов — из сумм, не среднее процентов')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_active = EXCLUDED.is_active,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, description = EXCLUDED.description,
  human_description = EXCLUDED.human_description, formula_human = EXCLUDED.formula_human;

SELECT id, name_ru, metric_type, is_active, is_hidden_in_ui FROM metrics WHERE id LIKE 'goldfish%' ORDER BY sort_order;
