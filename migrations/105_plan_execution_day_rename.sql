-- Миграция 105: переименование дневных вариантов метрик выполнения плана
-- (задача #2423, заказчик Серёга, 27.07). Недельные/месячные варианты не трогаем.
-- Суффикс «(день)» → «(на тек. день)» — для единообразия с уже принятой
-- формулировкой из 101_plan_current_day_metrics.sql («План продаж/отгрузок
-- (на тек. день)»).
-- БД: YC analytics (таблица metrics). Меняем только name_ru — ключи метрик
-- (plan_execution_pct_sales_day / plan_execution_pct_shipments_day) не трогаем.
-- Идемпотентна.

UPDATE metrics SET
  name_ru = 'Выполнение плана продаж, % (на тек. день)'
WHERE id = 'plan_execution_pct_sales_day';

UPDATE metrics SET
  name_ru = 'Выполнение плана отгрузок, % (на тек. день)'
WHERE id = 'plan_execution_pct_shipments_day';
