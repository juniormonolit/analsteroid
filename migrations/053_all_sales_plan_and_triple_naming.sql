-- Этап 5б (правки Серёги 08.07 16:57, owners-inbox/analsteroid-edits-spec-agreed-20260708.md):
-- 1) план-метрики считают факт по ВСЕМ продажам/отгрузкам (перв.+повт.), не только
--    по первичным, как было исторически на проде и как зафиксировала миграция 051.
-- 3) тройки «X (перв.)» / «X (повт.)» / «X» получают явный суффикс «X (все)» —
--    рабочая семантика "без суффикса = все" остаётся, но теперь читается явно в UI.
-- Идемпотентна, к проду НЕ применена (применяет Артём вместе с 052, по порядку номеров).
-- БД: YC analytics (run_analytics.mjs).

-- ── 1) План-метрики: факт = ВСЕ продажи/отгрузки ────────────────────────────
-- plan_execution_pct — «Выполнение плана продаж, % (месяц)» (переименована в 051).
-- Было: '[primary_sales_amount] / [plan_sales_month] * 100' — только первичные продажи
-- (так исторически работало на проде, миграция 051 сознательно это сохранила).
-- Стало: сумма первичных + повторных продаж (тот же inline-паттерн суммы, что и в
-- migrations/040_avg_metrics.sql для all_sales_avg_amount — НЕ ссылаемся на калькулируемую
-- 'all_sales_amount' как на зависимость, чтобы не зависеть от порядка вычисления цепочки
-- calculated-метрик в computeCalculated).
UPDATE metrics SET
  formula = '([primary_sales_amount] + [repeat_sales_amount]) / [plan_sales_month] * 100',
  dependencies = ARRAY['primary_sales_amount', 'repeat_sales_amount', 'plan_sales_month']
WHERE id = 'plan_execution_pct';

-- plan_execution_pct_shipments_month — «Выполнение плана отгрузок, % (месяц)» (051).
-- Было: '[primary_shipments_amount] / [plan_shipments_month] * 100' — только первичные.
-- Стало: 'shipments_amount' — collected-метрика без funnel-фильтра (миграция 041),
-- т.е. уже сумма первичных+повторных на уровне SQL. Безопасно ссылаться напрямую:
-- collected-метрики всегда присутствуют в rawMetrics ДО вычисления calculated-цепочки.
UPDATE metrics SET
  formula = '[shipments_amount] / [plan_shipments_month] * 100',
  dependencies = ARRAY['shipments_amount', 'plan_shipments_month']
WHERE id = 'plan_execution_pct_shipments_month';

-- plan_execution_pct_sales_day/week и plan_execution_pct_shipments_day/week (051) сами
-- по себе НЕ меняются — их формулы уже ссылаются на скрытые external-хелперы
-- (sales_fact_mtd/wtd, shipments_fact_mtd/wtd), которые не имеют SQL-формулы и
-- инжектятся сервером в app/api/reports/run/route.ts. Источник факта для них исправлен
-- ТАМ (код, не миграция) — теперь это primary+repeat вместо только primary.

-- ── 3) Тройки «X (перв.)»/«X (повт.)»/«X» → «X (все)» ───────────────────────
-- Список построен по истории миграций (034_refusal_metrics.sql и 040_avg_metrics.sql
-- изначально засевали эти id с суффиксом "(все)" и в name_ru, и в name_short_ru;
-- 041_metrics_naming.sql в рамках унификации нейминга убрал суффикс из name_ru,
-- но НЕ трогал name_short_ru своими точечными UPDATE — поэтому состояние колонок
-- могло разъехаться). Гвардим по факту содержимого, а не жёстко перезаписываем —
-- миграция идемпотентна и безопасна при повторном запуске.
UPDATE metrics SET
  name_ru = name_ru || ' (все)'
WHERE id IN (
  'deals_count', 'deals_amount', 'deals_avg_amount', 'unprocessed_count',
  'reservations_count', 'reservations_amount',
  'confirmed_reservations_count', 'all_confirmed_amount', 'all_confirmed_avg_amount',
  'sales_count', 'all_sales_amount', 'all_sales_avg_amount',
  'reservation_to_sale_count', 'reservation_to_sale_amount', 'confirmed_sales_count',
  'shipments_count', 'shipments_amount', 'all_shipments_avg_amount',
  'cr_deal_to_reservation_all', 'cr_deal_to_confirmed_all', 'cr_deal_to_sale_all',
  'cr_deal_to_shipment_all', 'cr_reservation_to_confirmed_all', 'cr_reservation_to_sale_all',
  'cr_reservation_to_shipment_all', 'cr_confirmed_to_sale_all', 'cr_sale_to_shipment',
  'lost_deals_count',
  'reservation_to_lost_count', 'reservation_to_lost_amount',
  'confirmed_to_lost_count', 'confirmed_to_lost_amount',
  'sale_to_lost_count', 'sale_to_lost_amount',
  'cr_reservation_to_lost_all', 'cr_confirmed_to_lost_all', 'cr_sale_to_lost_all'
)
AND name_ru NOT LIKE '%(перв.)%'
AND name_ru NOT LIKE '%(повт.)%'
AND name_ru NOT LIKE '%(все)%';

UPDATE metrics SET
  name_short_ru = name_short_ru || ' (все)'
WHERE id IN (
  'deals_count', 'deals_amount', 'deals_avg_amount', 'unprocessed_count',
  'reservations_count', 'reservations_amount',
  'confirmed_reservations_count', 'all_confirmed_amount', 'all_confirmed_avg_amount',
  'sales_count', 'all_sales_amount', 'all_sales_avg_amount',
  'reservation_to_sale_count', 'reservation_to_sale_amount', 'confirmed_sales_count',
  'shipments_count', 'shipments_amount', 'all_shipments_avg_amount',
  'cr_deal_to_reservation_all', 'cr_deal_to_confirmed_all', 'cr_deal_to_sale_all',
  'cr_deal_to_shipment_all', 'cr_reservation_to_confirmed_all', 'cr_reservation_to_sale_all',
  'cr_reservation_to_shipment_all', 'cr_confirmed_to_sale_all', 'cr_sale_to_shipment',
  'lost_deals_count',
  'reservation_to_lost_count', 'reservation_to_lost_amount',
  'confirmed_to_lost_count', 'confirmed_to_lost_amount',
  'sale_to_lost_count', 'sale_to_lost_amount',
  'cr_reservation_to_lost_all', 'cr_confirmed_to_lost_all', 'cr_sale_to_lost_all'
)
AND name_short_ru IS NOT NULL
AND name_short_ru NOT LIKE '%(перв.)%'
AND name_short_ru NOT LIKE '%(повт.)%'
AND name_short_ru NOT LIKE '%(все)%';
