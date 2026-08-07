-- Migration 161: воронковые «перв./повт.» — вернуть в пикер метрик
-- БД: YC analytics. Накат с ноутбука:
--   node migrations/run_local.mjs migrations/161_funnel_metrics_pickable.sql --db=analytics
--
-- Хвост миграции 160. Там метрики «по истории заказчика» перестали быть
-- служебными и стали видны в пикере, а их воронковые близнецы остались с
-- is_active = false — так было ещё до 160 (борьба с захламлением каталога из
-- ~418 метрик, см. комментарий в lib/settings/cardTemplates.ts: is_active
-- означает «показывать в общем пикере», а НЕ «метрика нерабочая»).
--
-- В итоге получилась асимметрия ровно там, где 160 обещала обратное: человек
-- ищет в пикере «по воронке», находит только ДОЛИ, а сами колонки «Сумма продаж
-- (перв., по воронке)» не находит и поставить обе базы рядом в новый отчёт не
-- может. В старых отчётах эти метрики при этом стоят и считаются — их туда
-- добавили, когда пикер был другим.
--
-- Восемь метрик — те же, что 160 переименовала. Ничего, кроме видимости в
-- пикере, не меняется: формулы, фильтры и id нетронуты.

UPDATE metrics SET is_active = true
WHERE id IN (
  'primary_sales_count', 'repeat_sales_count',
  'primary_sales_amount', 'repeat_sales_amount',
  'primary_shipments_count', 'repeat_shipments_count',
  'primary_shipments_amount', 'repeat_shipments_amount'
);

-- Проверка: должно быть 0 строк (не осталось невидимых в этой семье).
--   SELECT id, name_ru FROM metrics
--   WHERE name_ru LIKE '%по воронке%' AND is_active = false;
