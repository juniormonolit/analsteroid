-- Rename "Исполнение плана" → "Выполнение плана" and compute it against TOTAL sales
-- (primary + repeat), not just primary. Uses collected metrics directly (not the calculated
-- all_sales_amount) so it never depends on calculated-metric evaluation order.
UPDATE metrics SET
  name_ru       = 'Выполнение плана',
  name_short_ru = 'Вып. плана',
  formula       = '([primary_sales_amount] + [repeat_sales_amount]) / [plan_sales_month] * 100',
  dependencies  = ARRAY['primary_sales_amount','repeat_sales_amount','plan_sales_month']
WHERE id = 'plan_execution_pct';
