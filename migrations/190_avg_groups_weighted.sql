-- Migration 190: «средние по товарным группам» — честная агрегация в группах
-- БД: YC analytics. Накат: node migrations/run_local.mjs migrations/190_avg_groups_weighted.sql --db=analytics
--
-- Инцидент владельца 03.09: в отчёте по менеджерам с группировкой по отделу/
-- филиалу «Среднее кол-во товарных групп на клиента» у СПб = 164,70 (у «Итого» —
-- честные 1,75). Строки групп собирает фронт (aggregateGroupDeltas), и он
-- суммировал ВСЕ не-calculated метрики — в т.ч. средние и медианы: отдел =
-- сумма средних менеджеров, филиал = сумма сумм.
--
-- Фикс в трёх слоях (код — в этом же коммите):
--  1. движок clientMetrics отдаёт аддитивные числители: client_groups_sum
--     (Σ товарных групп по клиентам строки), order_groups_sum / order_products_sum
--     (Σ групп/позиций по заказам) — здесь они заводятся скрытыми служебными;
--  2. сами «средние» переводятся из external в calculated: числитель ÷ знаменатель
--     (клиенты / заказы) — строки групп теперь складывают числители и делят,
--     т.е. считают ЧЕСТНОЕ взвешенное среднее, «Итого» — из grand-строки движка;
--  3. aggregateGroupDeltas больше не суммирует external с aggregation_fn <> 'sum'
--     (медианы и клиентские значения в группах — прочерк, а не сумма медиан).

BEGIN;

INSERT INTO metrics (id, name_ru, name_short_ru, category, metric_type, data_type,
                     decimal_places, aggregation_fn, sort_order, is_active, is_hidden_in_ui,
                     description, human_description, formula_human)
VALUES
  ('client_groups_sum', 'Сумма товарных групп по клиентам (служебная)', 'Σ групп/клиенты',
   'Клиенты', 'external', 'int', 0, 'sum', 1610, true, true,
   'Служебный числитель «Среднее кол-во товарных групп на клиента» (миграция 190): SUM(cg) по клиентам строки из движка clientMetrics. Аддитивен — группы отчёта складывают его честно.',
   'Складываем по каждому заказчику строки число РАЗНЫХ товарных групп за всю его историю (сервисные не считаются) — служебный числитель для среднего.',
   '= сумма по заказчикам строки числа разных товарных групп за их историю'),
  ('order_groups_sum', 'Сумма товарных групп по заказам (служебная)', 'Σ групп/заказы',
   'Клиенты', 'external', 'int', 0, 'sum', 1611, true, true,
   'Служебный числитель «Среднее кол-во товарных групп в 1 заказе» (миграция 190): SUM(groups_cnt) по товарным отгрузкам периода.',
   'Складываем по каждой товарной отгрузке периода число разных товарных групп внутри сделки — служебный числитель для среднего.',
   '= сумма по товарным отгрузкам периода числа разных групп в сделке'),
  ('order_products_sum', 'Сумма товарных позиций по заказам (служебная)', 'Σ позиций/заказы',
   'Клиенты', 'external', 'int', 0, 'sum', 1612, true, true,
   'Служебный числитель «Среднее кол-во товаров в 1 заказе» (миграция 190): SUM(items_cnt) по товарным отгрузкам периода.',
   'Складываем по каждой товарной отгрузке периода число товарных позиций в сделке — служебный числитель для среднего.',
   '= сумма по товарным отгрузкам периода числа товарных позиций в сделке')
ON CONFLICT (id) DO NOTHING;

UPDATE metrics SET metric_type = 'calculated',
  formula = '[client_groups_sum] / [all_clients_delivered]',
  dependencies = ARRAY['client_groups_sum','all_clients_delivered'],
  formula_human = '= «Сумма товарных групп по клиентам» ÷ «Клиенты с отгрузкой». В строках отделов/филиалов — взвешенное среднее (суммы числителей и клиентов), не среднее средних'
 WHERE id = 'avg_groups_per_client';

UPDATE metrics SET metric_type = 'calculated',
  formula = '[order_groups_sum] / [delivered_deals_count]',
  dependencies = ARRAY['order_groups_sum','delivered_deals_count'],
  formula_human = '= «Сумма товарных групп по заказам» ÷ «Заказы (кол-во)». В группах — взвешенное среднее по заказам'
 WHERE id = 'avg_groups_per_order';

UPDATE metrics SET metric_type = 'calculated',
  formula = '[order_products_sum] / [delivered_deals_count]',
  dependencies = ARRAY['order_products_sum','delivered_deals_count'],
  formula_human = '= «Сумма товарных позиций по заказам» ÷ «Заказы (кол-во)». В группах — взвешенное среднее по заказам'
 WHERE id = 'avg_products_per_order';

COMMIT;
