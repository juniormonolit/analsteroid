-- БД: YC analytics (таблица metrics, run_analytics.mjs). Проверено на сервере
-- 17.07: занято по 102 включительно (в т.ч. ad-hoc changelog-файлы вне репо,
-- 057-088/096-097) — 103 свободен. НЕ применять локально — накатывает Артём на
-- проде (или сам код-агент, additive INSERT ... ON CONFLICT, как и 077).
--
-- Задача 2059 (Серёга 17.07) + доп. в тот же день. Новая категория каталога
-- «Стадии (сейчас)» — 9 метрик: 6 «снимок по конкретной рабочей стадии» +
-- 3 «Сделок в работе» (классическая троица перв./повт./все).
--
-- ПРАВКА 17.07 (вторая итерация, решение Серёги «лид не нужен»): метрика
-- «Лид (сейчас)» (stage_now_new_count) УДАЛЕНА из семейства. INSERT заменён на
-- DELETE (внизу файла), чтобы повторный прогон миграции её не воскресил — она
-- успела попасть в живой каталог первым прогоном.
--
-- ВСЕ 9 — metric_type='external': считает СЕРВЕР ОТЧЁТОВ
-- (features/reports/engine/stageSnapshot.ts + гейты в byManagers.ts/
-- byProductGroups.ts/bySources.ts), НЕ generic buildCollectedSQL. Это
-- ПРИНЦИПИАЛЬНОЕ архитектурное решение: buildCollectedSQL жёстко бьёт период
-- ($1/$2) в базовый SQL КАЖДОЙ collected-метрики разом — для «снимка текущего
-- состояния» это в принципе неприменимо (период здесь не участвует вообще, ни
-- одной даты). Отдельный путь также структурно исключает повтор инцидента 14.07
-- (виртуальные scope_independent-поля ронили ВСЕ отчёты, см. WORKLOG/reference_
-- analsteroid_reports_virtual_fields_incident) — этот код не трогает
-- resolveFilterClause/CLIENT_HISTORY_FIELDS вообще.
--
-- «Период не влияет» — та же семантика, что и у ППП/ППО, но здесь честнее:
-- ППП/ППО (тег scope_independent) технически ВСЁ ЕЩЁ фильтруются по периоду
-- через свой dateField в buildCollectedSQL (тег снимает только funnel-пилюлю
-- Первичные/Повторные, НЕ период) — это выяснилось при разборе задачи 17.07. У
-- «Стадий (сейчас)» период не участвует НИГДЕ, ни в SQL, ни в пилюле. Отдельного
-- UI-бейджа «период не влияет» в отчётах сейчас нет ни у одной метрики (проверено
-- живым кодом — есть только у карточки метрики в /metrics, не в самом отчёте) —
-- сигнал для пользователя: суффикс «(сейчас)» в name_ru/name_short_ru каждой
-- метрики (тот же приём, что «План (на сегодня)» и т.п.).
--
-- Группы 1-5 — переиспользование STAGE_GROUPS (тот же словарь, что и конверсии
-- стадий, stageConversions.ts), funnels 0(ЧЛ)/1(ЮЛ). Терминальные (продажа/
-- отгрузка/отказ) исключены по заданию; «Лид» удалён решением Серёги. 6 — «Есть
-- цена дешевле, запросил предложение лучше» (UC_PU4HM2/C1:11), рабочая, но вне
-- STAGE_GROUPS.
--
-- ОТКРЫТО (Серёге, НЕ блокирует): funnels 2/3 (Повторные Б2C/Б2Б) и 4/7
-- (Холодные звонки/Тендеры) НЕ покрыты per-stage метриками — их stage_id не
-- совпадают со схемой ЧЛ/ЮЛ, канонической группировки для них ещё нет. «Сделок в
-- работе» (7-9) — ПОКРЫВАЕТ все воронки разом (stage_type='WORK', семантическое
-- поле sa.stages, живая проверка 17.07: stage_type ∈ {NEW, WORK, WON, LOSS}).
--
-- СВЕРКА (запрошена явно): «Сделок в работе (все)» НЕ равно сумме per-stage
-- метрик выше — ожидаемо, см. финальный отчёт задачи (funnel-покрытие +
-- stage_type='sold' тоже считается WORK + стадии «Лид» в WORK не входят и своей
-- метрики больше не имеют).

-- «Лид (сейчас)» (stage_now_new_count): УДАЛЕНА по решению Серёги 17.07 (вторая
-- итерация). DELETE идемпотентен; убирает строку, оставшуюся от первого прогона.
DELETE FROM metrics WHERE id = 'stage_now_new_count';

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_taken_count', 'Взято в работу (сейчас)', 'Взято в работу', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1301,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии «Взял в работу» (funnels ЧЛ/ЮЛ). Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_contacted_count', 'Связался с заказчиком (сейчас)', 'Связался', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1302,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии «Сделал запрос снабженцу, созвонился с заказчиком» (funnels ЧЛ/ЮЛ). Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_priced_count', 'Озвучены цены (сейчас)', 'Цена озвучена', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1303,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии «Созвонился и озвучил цены» (funnels ЧЛ/ЮЛ). Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_reservation_count', 'Бронь (сейчас)', 'Бронь', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1304,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии брони (не подтверждённой) (funnels ЧЛ/ЮЛ). Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_confirmed_count', 'Подтв. бронь (сейчас)', 'Подтв.бронь', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1305,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии подтверждённой брони (funnels ЧЛ/ЮЛ). Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_now_price_objection_count', 'Возражение по цене (сейчас)', 'Возражение цена', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1306,
  'Снимок: сколько сделок ПРЯМО СЕЙЧАС стоит в стадии «Есть цена дешевле, запросил предложение лучше» (funnels ЧЛ/ЮЛ). Рабочая стадия, вне 6 групп выше. Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('deals_in_work_count', 'Сделок в работе (сейчас)', 'В работе', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1307,
  'Снимок: все сделки, чья ТЕКУЩАЯ стадия относится к sa.stages.stage_type=''WORK'' (все воронки, ПЕРВИЧНЫЕ funnels.is_repeat=false). НЕ равно сумме 7 метрик выше (funnel-покрытие шире + сделки в стадии "продано, не отгружено" тоже WORK). Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('deals_in_work_count_repeat', 'Сделок в работе, повт. (сейчас)', 'В работе (повт.)', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1308,
  'То же, что «Сделок в работе», но funnels.is_repeat=true (Повторные Б2С/Б2Б). Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('deals_in_work_count_all', 'Сделок в работе, все (сейчас)', 'В работе (все)', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Стадии (сейчас)', 1309,
  'То же, что «Сделок в работе», ВСЕ воронки разом (первичные + повторные). Период отчёта НЕ влияет.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;
