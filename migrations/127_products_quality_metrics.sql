-- 127: Метрики качества товарного наполнения сделок — тройки перв/повт/все (задача #2548,
--      дефолт подтверждён владельцем аналитики Серёгой). БД: analytics (metrics).
--
-- «Без товаров» — в сделке НЕТ товарных строк вообще:
--     products IS NULL OR jsonb_array_length(products) = 0
--   (тот же предикат, что у is_null для products в sqlGen.ts; согласовано с движком
--   byProductGroups: такие сделки в разрезе by_max падают в «Без группы»).
--
-- «Товары только текстом» — строки есть, но все свободнотекстовые, без привязки
--   к номенклатурной группе (шкала by_max):
--     products непуст AND head_group_name IS NULL
--   Инвариант проверен на проде: deal-level head_group_name IS NULL <=> ни одна строка
--   products не несёт head_group_name (июль-2026: 0 расхождений в обе стороны).
--   Нюанс: ~15% таких сделок имеют строку с product_id (товар из каталога), но без
--   head-группы — по шкале by_max они всё равно «без группы», считаем текстовыми.
--
-- Период: created_at сделки (как у соседей по категории «Сделки»).
-- Тройка перв/повт — фильтр funnel_type eq primary/repeat (funnels.is_repeat), «все» — без него.
--
-- DOWN:
--   DELETE FROM metrics WHERE id IN ('no_products_primary_count','no_products_repeat_count',
--     'text_products_primary_count','text_products_repeat_count','text_products_count');
--   UPDATE metrics SET name_ru='Кол-во сделок без товаров', name_short_ru='Без товаров',
--     is_active=false, sort_order=115 WHERE id='no_products_count';

-- «Без товаров (все)» — реактивируем существующую спящую метрику 014-й миграции
UPDATE metrics SET
  name_ru = 'Без товаров (все)',
  name_short_ru = 'Без тов. (вс)',
  description = 'Сделки без товарных строк вообще (products NULL или пустой массив), созданные за период, все воронки. Задача #2548.',
  is_active = true,
  sort_order = 118
WHERE id = 'no_products_count';

INSERT INTO metrics (
  id, name_ru, name_short_ru, description,
  metric_type, data_type, formula, dependencies,
  decimal_places, aggregation_fn, category, sort_order,
  is_core, is_active, is_hidden_in_ui, is_test,
  source, agg_fn, agg_field, date_field, filters, tags,
  is_collect_ok, is_calc_ok, calc_ok, fill_ok
) VALUES

('no_products_primary_count',
 'Без товаров (перв.)', 'Без тов. (п)',
 'Сделки без товарных строк вообще (products NULL или пустой массив), созданные за период, первичные воронки (funnels.is_repeat=false). Задача #2548.',
 'collected', 'int', NULL, '{}',
 0, 'sum', 'Сделки', 116,
 false, true, false, false,
 'deals', 'count_distinct', 'deal_id', 'created_at',
 '[{"field":"funnel_type","op":"eq","value":"primary"},{"field":"products","op":"is_null","value":""}]'::jsonb,
 ARRAY['deals','quality','primary'],
 false, false, false, false),

('no_products_repeat_count',
 'Без товаров (повт.)', 'Без тов. (пв)',
 'Сделки без товарных строк вообще (products NULL или пустой массив), созданные за период, повторные воронки (funnels.is_repeat=true). Задача #2548.',
 'collected', 'int', NULL, '{}',
 0, 'sum', 'Сделки', 117,
 false, true, false, false,
 'deals', 'count_distinct', 'deal_id', 'created_at',
 '[{"field":"funnel_type","op":"eq","value":"repeat"},{"field":"products","op":"is_null","value":""}]'::jsonb,
 ARRAY['deals','quality','repeat'],
 false, false, false, false),

('text_products_primary_count',
 'Товары только текстом (перв.)', 'Тов. текстом (п)',
 'Сделки, где товарные строки есть, но все свободнотекстовые — без привязки к номенклатурной группе (head_group_name пуст при непустых products, шкала by_max). Созданные за период, первичные воронки. Задача #2548.',
 'collected', 'int', NULL, '{}',
 0, 'sum', 'Сделки', 119,
 false, true, false, false,
 'deals', 'count_distinct', 'deal_id', 'created_at',
 '[{"field":"funnel_type","op":"eq","value":"primary"},{"field":"products","op":"is_not_null","value":""},{"field":"head_group_name","op":"is_null","value":""}]'::jsonb,
 ARRAY['deals','quality','primary'],
 false, false, false, false),

('text_products_repeat_count',
 'Товары только текстом (повт.)', 'Тов. текстом (пв)',
 'Сделки, где товарные строки есть, но все свободнотекстовые — без привязки к номенклатурной группе (head_group_name пуст при непустых products, шкала by_max). Созданные за период, повторные воронки. Задача #2548.',
 'collected', 'int', NULL, '{}',
 0, 'sum', 'Сделки', 120,
 false, true, false, false,
 'deals', 'count_distinct', 'deal_id', 'created_at',
 '[{"field":"funnel_type","op":"eq","value":"repeat"},{"field":"products","op":"is_not_null","value":""},{"field":"head_group_name","op":"is_null","value":""}]'::jsonb,
 ARRAY['deals','quality','repeat'],
 false, false, false, false),

('text_products_count',
 'Товары только текстом (все)', 'Тов. текстом (вс)',
 'Сделки, где товарные строки есть, но все свободнотекстовые — без привязки к номенклатурной группе (head_group_name пуст при непустых products, шкала by_max). Созданные за период, все воронки. Задача #2548.',
 'collected', 'int', NULL, '{}',
 0, 'sum', 'Сделки', 121,
 false, true, false, false,
 'deals', 'count_distinct', 'deal_id', 'created_at',
 '[{"field":"products","op":"is_not_null","value":""},{"field":"head_group_name","op":"is_null","value":""}]'::jsonb,
 ARRAY['deals','quality'],
 false, false, false, false)

ON CONFLICT (id) DO NOTHING;
