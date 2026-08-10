-- Migration 171: раздел «Клиенты» — метрики повторных продаж, посчитанные честно
-- БД: YC analytics (таблица metrics). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/171_clients_category.sql --db=analytics
--
-- Задача владельца 10.08.2026. Просил новую группу метрик «Клиенты» про повторные
-- продажи. При разборе выяснилось, что почти вся эта семья уже существует в
-- категории «Повторные» (ТЗ #1725), но с тремя дефектами, и владелец выбрал
-- вариант «починить и перенести», а не плодить вторую семью с теми же именами
-- (тот же принцип, что в миграции 160: два набора одноимённых метрик с разными
-- числами — гарантированная путаница).
--
-- ── ЧТО БЫЛО НЕ ТАК ──────────────────────────────────────────────────────────
--
-- 1. `all_clients_delivered` называлась «Кол-во (Новые клиенты)», а считала ВСЕХ
--    клиентов с отгрузкой в периоде. Ровно болезнь миграции 160: имя обещает
--    одно, формула считает другое. Настоящих «новых» в каталоге не было вовсе.
--
-- 2. Сервисные позиции считались покупкой категории. `complex_clients` брала
--    `deals.head_group_name` — ОДНУ главную группу сделки (по наибольшей сумме) —
--    за всю историю клиента. Отдельная отгрузка «только доставка» (582 таких на
--    проде) добавляла клиенту вторую «категорию», и он становился комплексным.
--    Решение владельца 10.08: перевозка, аренда спецтехники, «для логистов»,
--    служебная и «ошибка» — не покупка категории. Считаем по позициям products,
--    а не по главной группе: 473 отгрузки с реальным товаром подписаны
--    «Перевозка», потому что доставка вышла дороже товара.
--
-- 3. `avg_groups_per_client`, `avg_groups_per_order`, `avg_products_per_order`
--    были объявлены как external ещё в ТЗ #1725, но движка не получили — всё это
--    время отдавали пустые колонки. Теперь у них есть движок.
--
-- ── ПОЧЕМУ ВСЁ СТАЛО external ────────────────────────────────────────────────
--
-- COUNT(DISTINCT contact_id) нельзя складывать, а конструктор collected-метрик
-- именно складывает: он считает в разрезе (измерение × воронка), чтобы пилюли
-- фильтровались постфактум, и суммирует строки по воронкам. Клиент, купивший в
-- двух воронках, считается дважды. Замер на живых данных (июль 2026): честно
-- 2 072 клиента, суммой по воронкам — 2 216 (+7 %), а у отдельного менеджера
-- (#1930) 32 против 44 (+37 %). Именно поэтому старые метрики этой семьи были
-- помечены «служебная, скрыта» и жили только внутри формул, где числитель и
-- знаменатель врали одинаково. Новый движок (features/reports/engine/
-- clientMetrics.ts) применяет пилюли В SQL, до агрегации, поэтому DISTINCT
-- честный и метрики можно показывать сами по себе — они больше не скрыты.
--
-- ПОБОЧНЫЙ ЭФФЕКТ, ОСОЗНАННЫЙ: в уже сохранённых отчётах со «% комплексных
-- клиентов» и «Repeat Rate» числа поедут — вниз и в правильную сторону.
--
-- ГРАНИЦА ПОДДЕРЖКИ: метрики считаются в отчёте «По менеджерам» и в «Итого»
-- (движку нужен честный DISTINCT по срезу). В отчёте по товарным группам они
-- сознательно пустые: сделка относится к нескольким группам, и «клиент товарной
-- группы» — величина с двойным счётом по построению. Та же граница, что у
-- план-метрик, которые тоже живут только в отчёте по менеджерам.

BEGIN;

-- ── 0. Резервная копия затрагиваемых определений ─────────────────────────────
-- Тот же приём, что в миграциях 165/166: ниже идут UPDATE'ы, переписывающие
-- метрики необратимо (имена, тип, фильтры). Если что-то посчитается не так,
-- вернуть исходные определения можно из этой таблицы, а не из памяти.
CREATE TABLE IF NOT EXISTS metrics_backup_171 AS SELECT * FROM metrics WHERE false;
INSERT INTO metrics_backup_171
  SELECT * FROM metrics
   WHERE id IN ('all_clients_delivered', 'repeat_clients_delivered', 'repeat_rate_clients',
                'complex_clients', 'complex_clients_pct', 'delivered_deals_count',
                'avg_orders_per_client', 'avg_groups_per_client', 'avg_groups_per_order',
                'avg_products_per_order')
     AND NOT EXISTS (SELECT 1 FROM metrics_backup_171);

-- ── 1. Вся семья переезжает в новую категорию «Клиенты» ──────────────────────
UPDATE metrics SET category = 'Клиенты' WHERE id IN (
  'all_clients_delivered', 'repeat_clients_delivered', 'repeat_rate_clients',
  'complex_clients', 'complex_clients_pct', 'delivered_deals_count',
  'avg_orders_per_client', 'avg_groups_per_client', 'avg_groups_per_order',
  'avg_products_per_order'
);

-- ── 2. Существующие: честный движок вместо конструктора + правдивые имена ────
UPDATE metrics SET
  metric_type = 'external', agg_fn = NULL, agg_field = NULL, date_field = NULL,
  filters = '[]'::jsonb, is_hidden_in_ui = false, sort_order = 1402,
  name_ru = 'Клиенты с отгрузкой (кол-во)', name_short_ru = 'Клиентов',
  description = 'Уникальные клиенты (contact_id) с товарной отгрузкой в периоде. '
    || 'Сервисные позиции (перевозка, аренда спецтехники, для логистов, служебная, ошибка) '
    || 'покупкой не считаются: сделка, где кроме них ничего нет, в расчёт не идёт. '
    || 'Считается честным DISTINCT по срезу (без задвоения по воронкам).'
  WHERE id = 'all_clients_delivered';

UPDATE metrics SET
  metric_type = 'external', agg_fn = NULL, agg_field = NULL, date_field = NULL,
  filters = '[]'::jsonb, is_hidden_in_ui = false, sort_order = 1403,
  name_ru = 'Купившие повторно (кол-во)', name_short_ru = 'Повт. клиентов',
  description = 'Клиенты с товарной отгрузкой в периоде, у которых это НЕ первая '
    || 'товарная отгрузка за всю историю. Вместе с «Новыми клиентами» дают всех '
    || 'клиентов периода, поэтому Repeat Rate = повторные / всех.'
  WHERE id = 'repeat_clients_delivered';

UPDATE metrics SET
  metric_type = 'external', agg_fn = NULL, agg_field = NULL, date_field = NULL,
  filters = '[]'::jsonb, is_hidden_in_ui = false, sort_order = 1410,
  name_ru = 'Купившие повторно другую категорию (кол-во)', name_short_ru = 'Комплексных',
  description = 'Клиенты с отгрузкой в периоде, у которых за всю историю набралось '
    || '2+ РАЗНЫХ товарных группы. Группы берутся из позиций сделки (products), '
    || 'сервисные исключены: «газобетон + доставка» — это одна группа, а не две.'
  WHERE id = 'complex_clients';

UPDATE metrics SET
  metric_type = 'external', agg_fn = NULL, agg_field = NULL, date_field = NULL,
  filters = '[]'::jsonb, is_hidden_in_ui = false, sort_order = 1404,
  name_ru = 'Заказы (кол-во)', name_short_ru = 'Заказов',
  description = 'Товарные отгрузки периода. Сделки, где только сервисные позиции, '
    || 'заказом не считаются.'
  WHERE id = 'delivered_deals_count';

UPDATE metrics SET sort_order = 1405, name_ru = 'Repeat Rate (клиенты), %',
  formula = '[repeat_clients_delivered] / [all_clients_delivered] * 100',
  dependencies = ARRAY['repeat_clients_delivered', 'all_clients_delivered'],
  description = 'Доля купивших повторно среди всех клиентов с отгрузкой в периоде.'
  WHERE id = 'repeat_rate_clients';

UPDATE metrics SET sort_order = 1411, name_ru = 'Доля комплексных клиентов, %',
  description = 'Доля клиентов с 2+ разными товарными группами за историю среди '
    || 'всех клиентов с отгрузкой в периоде.'
  WHERE id = 'complex_clients_pct';

UPDATE metrics SET sort_order = 1406, decimal_places = 2,
  description = 'Товарные отгрузки периода, делённые на число уникальных клиентов периода.'
  WHERE id = 'avg_orders_per_client';

UPDATE metrics SET sort_order = 1412, decimal_places = 2, is_hidden_in_ui = false,
  name_ru = 'Среднее кол-во товарных групп на клиента', name_short_ru = 'Групп/клиент',
  description = 'Среднее по клиентам периода от числа РАЗНЫХ товарных групп за всю '
    || 'историю их отгрузок (сервисные исключены). Клиент с десятью заказами весит '
    || 'столько же, сколько клиент с одним. Не суммируется в «Итого» — там своё среднее.'
  WHERE id = 'avg_groups_per_client';

UPDATE metrics SET sort_order = 1413, decimal_places = 2, is_hidden_in_ui = false,
  name_ru = 'Среднее кол-во товарных групп в 1 заказе', name_short_ru = 'Групп/заказ',
  description = 'Среднее по товарным отгрузкам периода от числа разных товарных групп '
    || 'в сделке (сервисные исключены). Не суммируется в «Итого».'
  WHERE id = 'avg_groups_per_order';

UPDATE metrics SET sort_order = 1414, decimal_places = 2, is_hidden_in_ui = false,
  name_ru = 'Среднее кол-во товаров в 1 заказе', name_short_ru = 'Товаров/заказ',
  description = 'Среднее по товарным отгрузкам периода от числа товарных ПОЗИЦИЙ в '
    || 'сделке. Раньше резалось по type<>''услуга'', но «Доставка без разгрузки» лежит '
    || 'с type=''товар'' — теперь режется по группе позиции. Не суммируется в «Итого».'
  WHERE id = 'avg_products_per_order';

-- ── 3. Новые метрики, которых в каталоге не было ─────────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source,
  agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui,
  is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
  category, sort_order, description)
VALUES
  ('new_clients_count', 'Новые клиенты (кол-во)', 'Новых клиентов', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients}', false, true, false, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1401,
   'Клиенты, у которых товарная отгрузка в периоде — ПЕРВАЯ за всю историю. Сервисные сделки (только перевозка и т.п.) первой покупкой не считаются: на проде у 220 клиентов из 19 728 первая отгрузка была именно такой.'),
  ('new_clients_amount', 'Сумма (Новые клиенты)', 'Сумма новых', 'external', 'money', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients}', false, true, false, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1407,
   'Сумма первых товарных отгрузок клиентов, попавших в период. Вместе с «Суммой (Купившие повторно)» даёт всю сумму товарных отгрузок периода.'),
  ('repeat_clients_amount', 'Сумма (Купившие повторно)', 'Сумма повт.', 'external', 'money', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients}', false, true, false, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1408,
   'Сумма товарных отгрузок периода, которые НЕ являются первой отгрузкой клиента.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui,
  description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula,
  dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places,
  aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('repeat_amount_share', 'Доля суммы купивших повторно, %', 'Доля суммы повт.', 'calculated', 'percent',
   '[repeat_clients_amount] / ([new_clients_amount] + [repeat_clients_amount]) * 100',
   ARRAY['repeat_clients_amount', 'new_clients_amount'],
   '{clients}', false, true, false, false, 1, 'avg', false, true, false, true, 'Клиенты', 1409,
   'Какая часть суммы товарных отгрузок периода пришла от клиентов, покупающих не в первый раз.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, description = EXCLUDED.description;

COMMIT;
