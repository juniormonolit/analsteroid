-- БД: YC analytics (таблица metrics, run_analytics.mjs). Номер 103 проверен на
-- сервере 17.07 (занято по 102 включительно, в т.ч. ad-hoc ченджлоги вне репо).
--
-- Задачи 2059 + 2063 (Серёга, 17.07, несколько итераций за день). Категория
-- каталога «Стадии (сейчас)»: 14 per-stage метрик-снимков + 3 «Сделок в работе»
-- (перв./повт./все) = 17 метрик. ВСЕ — metric_type='external': считает движок
-- features/reports/engine/stageSnapshot.ts (+ byManagers/byProductGroups/
-- bySources), НЕ generic buildCollectedSQL — период не участвует НИГДЕ (снимок).
--
-- ПРАВИЛА 2063 (дословно Серёга: «пер-стадийные в повторных должны быть. …
-- Называться они должны ТОЧЬ-В-ТОЧЬ как стадии.»):
--   * имя метрики = ТОЧНОЕ имя стадии портала без суффикса воронки; одноимённые
--     стадии funnels 0/1/2/3 агрегируются в одну метрику;
--   * funnels 4 (Холодные звонки) / 7 (Тендеры) НЕ включены — видны только в
--     «Сделок в работе» (stage_type='WORK');
--   * исключение: «Необработанные» — персональное имя Серёги для входных
--     created-стадий (NEW/C1:NEW «Срочно обработать» + C2:NEW/C3:NEW «Сделка»);
--   * охват стадий задаётся В КОДЕ (stageSnapshot.ts) — каталог хранит только
--     имена/флаги, цифры меняются только с деплоем кода.
--
-- История итераций: v1 «Лид (сейчас)» stage_now_new_count → v2 удалена → v3
-- возвращена как «Необработанные» (id stage_now_unprocessed_count) → v4 (2063)
-- сплиты по точным именам + повторные воронки. DELETE старого id остаётся ниже.
--
-- Идемпотентно: INSERT ... ON CONFLICT DO UPDATE (без is_test в SET — ручной
-- рычаг скрытия не перетирается перекатом).

DELETE FROM metrics WHERE id = 'stage_now_new_count';

-- Необработанные
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_unprocessed_count', 'Необработанные', 'Необработанные', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1300,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. Входные created-стадии всех 4 воронок: «Срочно обработать» (ЧЛ/ЮЛ) + «Сделка» (B2C/B2B). Имя — решение Серёги (исключение из «точь-в-точь»). Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Не дозвонился
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_no_answer_count', 'Не дозвонился', 'Не дозвонился', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1301,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. Стадии «Не дозвонился» (ЧЛ/ЮЛ). Расщеплено из прежней «Взято в работу» (2059). Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Взял в работу
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_taken_count', 'Взял в работу', 'Взял в работу', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1302,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. Стадии «Взял в работу» (ЧЛ/ЮЛ). Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Сделал запрос снабженцу, созвонился с заказчиком
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_contacted_count', 'Сделал запрос снабженцу, созвонился с заказчиком', 'Сделал запрос снабженцу, созвонился с заказчиком', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1303,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. Одноимённые стадии всех 4 воронок (ЧЛ/ЮЛ/B2C/B2B). Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Созвонился и озвучил цены
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_priced_count', 'Созвонился и озвучил цены', 'Созвонился и озвучил цены', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1304,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. Только ЧЛ (в остальных воронках одноимённой стадии нет). Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Отправил КП и позвонил
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_kp_sent_count', 'Отправил КП и позвонил', 'Отправил КП и позвонил', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1305,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. ЮЛ + B2B (одноимённые стадии). Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Созвонился и уточнил следующие материалы
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_next_materials_count', 'Созвонился и уточнил следующие материалы', 'Созвонился и уточнил следующие материалы', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1306,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. Только повторные (B2C/B2B). Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Заполнил все материалы и запланировал звонок
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_filled_planned_call_count', 'Заполнил все материалы и запланировал звонок', 'Заполнил все материалы и запланировал звонок', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1307,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. Только B2C. Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Есть цена дешевле, запросил предложение лучше
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_price_objection_count', 'Есть цена дешевле, запросил предложение лучше', 'Есть цена дешевле, запросил предложение лучше', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1308,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. Все 4 воронки. Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Забронировано
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_reservation_count', 'Забронировано', 'Забронировано', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1309,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. ЧЛ + B2C. Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Отправил счет и договор (Бронь)
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_invoice_contract_count', 'Отправил счет и договор (Бронь)', 'Отправил счет и договор (Бронь)', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1310,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. Только ЮЛ; «(Бронь)» — часть имени стадии. Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Подтвержденная бронь
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_confirmed_count', 'Подтвержденная бронь', 'Подтвержденная бронь', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1311,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. ЧЛ + B2C. Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Наша цена лучшая, ждем оплату (Подтв.бронь)
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_best_price_wait_count', 'Наша цена лучшая, ждем оплату (Подтв.бронь)', 'Наша цена лучшая, ждем оплату (Подтв.бронь)', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1312,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. Только ЮЛ. Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Отправил счет
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_invoice_sent_count', 'Отправил счет', 'Отправил счет', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1313,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии с этим названием. Только B2B (event_type=''confirmed''). Период отчёта НЕ влияет — не сумма за период, а состояние на текущий момент. Охват stage_id — в коде (stageSnapshot.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Сделок в работе (сейчас)
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('deals_in_work_count', 'Сделок в работе (сейчас)', 'В работе', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1320,
  'Снимок: все сделки, чья ТЕКУЩАЯ стадия относится к sa.stages.stage_type=''WORK'' (ВСЕ воронки, включая Холодные звонки/Тендеры; ПЕРВИЧНЫЕ funnels.is_repeat=false). НЕ равно сумме per-stage метрик выше (см. WORKLOG). Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Сделок в работе, повт. (сейчас)
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('deals_in_work_count_repeat', 'Сделок в работе, повт. (сейчас)', 'В работе (повт.)', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1321,
  'То же, funnels.is_repeat=true (Повторные Б2С/Б2Б). Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- Сделок в работе, все (сейчас)
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('deals_in_work_count_all', 'Сделок в работе, все (сейчас)', 'В работе (все)', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1322,
  'То же, ВСЕ воронки разом (первичные + повторные). Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;
