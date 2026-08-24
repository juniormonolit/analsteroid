-- Migration 182: метрики «% вернувшихся клиентов» — каталог (задача #4996,
-- заказчик Серёга, продолжение #4994). БД: analytics (ycAnalyticsDb, таблица
-- metrics — та же БД, что у миграции 174, НЕ system). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/182_returning_clients_metrics.sql --db=analytics
--
-- НАХОДКА (проверено прямым SELECT на живой analytics): каталог УЖЕ содержит
-- 5 метрик под эту ровно задачу, мёртвые с ТЗ #1725, is_active=false:
--   cohort_return_rate_30/60/90/180/360 — «% вернувшихся N дн», metric_type=
--   'external', formula/dependencies ПУСТЫЕ (движка никогда не было — та же
--   формулировка в migrations/174, что и у cohort_repeat_ratio_30..360: «не
--   заказывал, движка нет»), decimal_places=1 УЖЕ стоит (готовое требование
--   заказчика «1 знак после запятой»). Их описание «Доля клиентов когорты с
--   2+ отгрузкой в течение N дней от первой» — это ДРУГИМИ словами то же
--   определение, что владелец продиктовал сейчас («ППО через N дней»):
--   у клиента 2+ отгрузки суммарно впервые случаются РОВНО в момент его ППО
--   (второй отгрузки), так что «2+ отгрузка в течение N дней» ⟺ «ППО в
--   пределах N дней». Переиспользуем ID и строки, а не плодим дубли.
--
-- ЗНАМЕНАТЕЛЬ: cohort_clients, НЕ new_clients_count (правка после проверки на
-- живых данных). Первый черновик миграции взял new_clients_count по совету
-- комментария у LTV-блока (миграция 174: «отдельная метрика размера когорты
-- не нужна — это new_clients_count»). Прямая SQL-проверка разреза «Периоды»
-- (март 2026) это опровергла: new_clients_count=832, честный размер мартовской
-- когорты (кто ВПЕРВЫЕ купил именно в марте) — 775. Причина — new_clients_count
-- (fetchClientMetrics) считает клиента «новым» в КАЖДОМ бакете, где у него
-- есть отгрузка внутри отчётного периода (bool_or(is_new) по всем его сделкам
-- периода), а не только в бакете его первой отгрузки — тот же клиент, купивший
-- в январе и повторно в марте, засчитан «новым» и там, и там. В разрезе
-- 'manager' на практике почти не проявляется (менеджер первой сделки обычно
-- ведёт клиента и дальше — 2 ряда сверено вручную, совпало), но в 'period' и
-- 'product-group' это структурный эффект, а не редкий случай. Числитель и
-- знаменатель доли обязаны быть одной и той же выборкой — иначе % вернувшихся
-- посчитан от чужой базы. Решение: cohort_clients — тот самый ID, что уже был
-- в каталоге под ТЗ #1725 (задизейблен в 174 как «дубль new_clients_count» —
-- дубликат он не для всех разрезов), реактивируется этой миграцией и
-- заполняется той же когортной CTE, что и числитель (один SQL-проход, без
-- нового похода в БД).
--
-- ЧЕГО НЕ ХВАТАЕТ (готово этой миграцией):
--   1. Пяти счётчиков-числителей движка cohort_returned_30..360 (клиентов
--      когорты, у кого ППО попала в окно) — считает та же когортная CTE, что
--      LTV-блок (features/reports/engine/clientMetrics.ts,
--      fetchClientCohortMetrics), тот же движок, доп. похода в БД нет.
--   2. Знаменатель cohort_clients — реактивация мёртвой метрики (см. выше).
--   3. У пяти существующих cohort_return_rate_* — из 'external' без формулы
--      в 'calculated' от [cohort_returned_N]/[cohort_clients]*100 (тот же
--      приём, что cohort_repeat_ratio, миграция 174/181): computeTotals уже
--      суммирует зависимости (наши счётчики — 'external', aggregation_fn=
--      'sum') и пересчитывает долю из сумм строк — «Итого» не среднее по
--      строкам бесплатно; evalFormula даёt null при 0/0 → formatValue «—».
--   4. Шестая колонка «Весь срок» — новый id cohort_return_rate_total:
--      числитель — уже существующий cohort_repeat_clients (клиенты когорты
--      2+ отгрузок ЗА ВСЮ ИСТОРИЮ, без ограничения по времени, миграция
--      174), свой счётчик не нужен.
--
-- Зрелость окон и правило «незрелое → null только у разреза Периоды» —
-- буквально то же, что у LTV (LTV_WINDOWS_DAYS, rowEndMs) — тот же движок,
-- никакой новой логики зрелости эта миграция не добавляет.

BEGIN;

CREATE TABLE IF NOT EXISTS metrics_backup_182 AS SELECT * FROM metrics WHERE false;
INSERT INTO metrics_backup_182
  SELECT * FROM metrics
   WHERE (id LIKE 'cohort_return_rate%' OR id LIKE 'cohort_returned%' OR id = 'cohort_clients')
     AND NOT EXISTS (SELECT 1 FROM metrics_backup_182);

-- ── 1. Счётчики движка (скрытые — служебные, видна только доля) ─────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source,
  agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui,
  is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
  category, sort_order, description)
VALUES
  ('cohort_returned_30', 'Вернувшихся клиентов за 30 дней (счётчик)', 'Верн.сч 30', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,cohort}', false, true, true, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1449,
   'Служебный счётчик: клиенты когорты (первая товарная отгрузка в периоде), у кого ППО (вторая отгрузка, первая повторная) случилась в пределах 30 дней от первой. Знаменатель доли — cohort_clients. Не показывается сам по себе, только как числитель cohort_return_rate_30.'),
  ('cohort_returned_60', 'Вернувшихся клиентов за 60 дней (счётчик)', 'Верн.сч 60', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,cohort}', false, true, true, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1450, 'То же, что «за 30 дней (счётчик)», окно 60 дней.'),
  ('cohort_returned_90', 'Вернувшихся клиентов за 90 дней (счётчик)', 'Верн.сч 90', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,cohort}', false, true, true, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1451, 'То же, что «за 30 дней (счётчик)», окно 90 дней.'),
  ('cohort_returned_180', 'Вернувшихся клиентов за 180 дней (счётчик)', 'Верн.сч 180', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,cohort}', false, true, true, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1452, 'То же, что «за 30 дней (счётчик)», окно 180 дней.'),
  ('cohort_returned_360', 'Вернувшихся клиентов за 360 дней (счётчик)', 'Верн.сч 360', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,cohort}', false, true, true, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1453, 'То же, что «за 30 дней (счётчик)», окно 360 дней.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui,
  aggregation_fn = EXCLUDED.aggregation_fn, description = EXCLUDED.description;

-- ── 2. Реактивация знаменателя cohort_clients («дубль new_clients_count» не
--      подтвердился для разрезов period/product-group — см. шапку миграции) ──
-- sort_order НЕ трогаем (остаётся исходный 1220, ТЗ #1725) — весь диапазон
-- 1441-1448 у соседней «пятой пачки» (миграция 175) уже занят.
UPDATE metrics SET
  is_active = true, is_hidden_in_ui = false, tags = ARRAY['clients','cohort'],
  category = 'Клиенты',
  description = 'Все клиенты когорты (contact_id), чья первая товарная отгрузка попала в этот срез (менеджера/период/товарную группу первой отгрузки) и в период отчёта. Знаменатель «% вернувшихся клиентов» (задача #4996) — та же CTE, что у cohort_returned_N и cohort_repeat_clients, поэтому числитель и знаменатель всегда одна выборка. В отличие от new_clients_count не задваивает клиента между бакетами при повторных покупках в других бакетах периода.'
 WHERE id = 'cohort_clients';

-- ── 3. Реактивация пяти оконных долей (были 'external' без формулы, мёртвые) ─
UPDATE metrics SET
  metric_type = 'calculated', data_type = 'percent',
  formula = '[cohort_returned_30] / [cohort_clients] * 100',
  dependencies = ARRAY['cohort_returned_30', 'cohort_clients'],
  tags = ARRAY['clients','cohort'], is_active = true, is_hidden_in_ui = false,
  decimal_places = 1, aggregation_fn = 'avg', calc_ok = true, is_calc_ok = true,
  category = 'Клиенты', sort_order = 1454, name_short_ru = 'Верн. 30',
  description = 'Доля клиентов когорты, у которых ППО (первая повторная отгрузка) случилась в пределах 30 дней от первой отгрузки (накопительно). Пусто, пока окно не прожито всей когортой (разрез «Периоды»). Задача #4996.'
 WHERE id = 'cohort_return_rate_30';
UPDATE metrics SET
  metric_type = 'calculated', data_type = 'percent',
  formula = '[cohort_returned_60] / [cohort_clients] * 100',
  dependencies = ARRAY['cohort_returned_60', 'cohort_clients'],
  tags = ARRAY['clients','cohort'], is_active = true, is_hidden_in_ui = false,
  decimal_places = 1, aggregation_fn = 'avg', calc_ok = true, is_calc_ok = true,
  category = 'Клиенты', sort_order = 1455, name_short_ru = 'Верн. 60',
  description = 'То же, что «через 30 дней», окно 60 дней (накопительно). Задача #4996.'
 WHERE id = 'cohort_return_rate_60';
UPDATE metrics SET
  metric_type = 'calculated', data_type = 'percent',
  formula = '[cohort_returned_90] / [cohort_clients] * 100',
  dependencies = ARRAY['cohort_returned_90', 'cohort_clients'],
  tags = ARRAY['clients','cohort'], is_active = true, is_hidden_in_ui = false,
  decimal_places = 1, aggregation_fn = 'avg', calc_ok = true, is_calc_ok = true,
  category = 'Клиенты', sort_order = 1456, name_short_ru = 'Верн. 90',
  description = 'То же, что «через 30 дней», окно 90 дней (накопительно). Задача #4996.'
 WHERE id = 'cohort_return_rate_90';
UPDATE metrics SET
  metric_type = 'calculated', data_type = 'percent',
  formula = '[cohort_returned_180] / [cohort_clients] * 100',
  dependencies = ARRAY['cohort_returned_180', 'cohort_clients'],
  tags = ARRAY['clients','cohort'], is_active = true, is_hidden_in_ui = false,
  decimal_places = 1, aggregation_fn = 'avg', calc_ok = true, is_calc_ok = true,
  category = 'Клиенты', sort_order = 1457, name_short_ru = 'Верн. 180',
  description = 'То же, что «через 30 дней», окно 180 дней (накопительно). Задача #4996.'
 WHERE id = 'cohort_return_rate_180';
UPDATE metrics SET
  metric_type = 'calculated', data_type = 'percent',
  formula = '[cohort_returned_360] / [cohort_clients] * 100',
  dependencies = ARRAY['cohort_returned_360', 'cohort_clients'],
  tags = ARRAY['clients','cohort'], is_active = true, is_hidden_in_ui = false,
  decimal_places = 1, aggregation_fn = 'avg', calc_ok = true, is_calc_ok = true,
  category = 'Клиенты', sort_order = 1458, name_short_ru = 'Верн. 360',
  description = 'То же, что «через 30 дней», окно 360 дней (накопительно). Задача #4996.'
 WHERE id = 'cohort_return_rate_360';

-- ── 4. Новая шестая колонка «Весь срок» ──────────────────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula,
  dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places,
  aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('cohort_return_rate_total', '% вернувшихся клиентов за весь срок', 'Верн. всего', 'calculated', 'percent',
   '[cohort_repeat_clients] / [cohort_clients] * 100',
   ARRAY['cohort_repeat_clients', 'cohort_clients'],
   '{clients,cohort}', false, true, false, false, 1, 'avg', false, true, false, true, 'Клиенты', 1459,
   'Доля клиентов когорты, вернувшихся (2+ отгрузки) хоть когда-нибудь за всю историю — без ограничения по времени, накопительно всегда. Числитель — уже существующий cohort_repeat_clients (миграция 174), новый счётчик не нужен. Задача #4996.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  data_type = EXCLUDED.data_type, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active,
  description = EXCLUDED.description;

COMMIT;
