-- Migration 160: «Первичные/Повторные» — две ЯВНЫЕ базы вместо одной скрытой
-- БД: YC analytics (таблица metrics). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/160_repeat_share_funnel_vs_history.sql --db=analytics
--
-- Причина (владелец, 07.08.2026, со скриншота отчёта «Базовый минимум»):
-- в строке менеджера стояли «Сумма продаж (перв.) 3 414 509» и «Сумма продаж
-- (повт.) 446 402», а «Доля повторных продаж, % (сумма)» показывала 26,0 %
-- вместо ожидаемых 11,5 %. Формула была правильной по форме
-- (повт / (перв + повт)), но брала ДРУГИЕ слагаемые:
--   * колонки «(перв.)/(повт.)» — воронка Битрикса (funnels.is_repeat);
--   * доля — история заказчика (contact_id, ROW_NUMBER по sold_at: rn=1 первая
--     покупка, rn>=2 повторная), служебные метрики *_hist из миграции 082.
-- Обе базы легитимны и отвечают на разные вопросы, но выглядели как одна:
-- имена не различались, а служебные *_hist были скрыты из каталога. Человек
-- видел в одной строке числа, которые не сходятся, и не мог понять почему.
--
-- Живые цифры (июль 2026, вся компания): по воронке доля повторных 45,2 % по
-- сумме, по истории — 47,4 %. По компании близко, а у отдельных менеджеров
-- разлёт до 100 п.п.: сделка повторного клиента, проведённая через первичную
-- воронку, уходит в «первичные» по одной базе и в «повторные» по другой.
-- Причина расхождения — 146 сделок июля, лежащих в «неправильной» воронке
-- (разбор отправлен владельцу отдельным файлом со ссылками на сделки).
--
-- Решение владельца (07.08.2026, дословно): «Делаем метрики так:
-- Первичные/Повторные продажи/отгрузки (по воронке); Доля повторных/первичных
-- продаж/отгрузок, % (сумма по воронке) + тоже самое (по истории заказчика).
-- В уже существующих отчетах метрики, которые считали по истории заменяем на
-- те, которые считали по воронке: так как ранее всегда считали по воронке и так
-- все привыкли».
--
-- Отсюда две вещи:
--   1) ID существующих метрик НЕ меняются (правило каталога: на них ссылаются
--      сохранённые отчёты) — вместо этого у repeat_sales_*_pct меняется ФОРМУЛА
--      обратно на воронку. Все уже собранные отчёты сами начинают считать по
--      воронке, править их руками не нужно.
--   2) База пишется прямо в НАЗВАНИИ, у обеих семей. Пока «по воронке» было
--      неявным дефолтом, а «по истории» — скрытой служебной, эта путаница была
--      вопросом времени: она уже случалась в обратную сторону (баг #1556,
--      миграция 082, тогда доля показывала 0 при ППП > 0).
--
-- ВНИМАНИЕ, обратная сторона решения: «Доля повторных» снова считается по
-- воронке и снова НЕ согласована с ППП (ППП считает по истории заказчика).
-- Это осознанный выбор владельца в пользу привычности. Если расхождение с ППП
-- опять начнёт мешать — сравнивать надо с *_pct_hist, они теперь видны в
-- каталоге и считают ровно то же, что ППП.
--
-- Метрики раздела «Повторные» (repeat_clients_delivered, complex_clients и др.)
-- НЕ трогаем: они изначально и осознанно про историю клиента (ТЗ #1725), это
-- отдельная семья со своим смыслом, а не дубль этих долей.

BEGIN;

-- ── 1. Воронковые collected-метрики: база — в название ───────────────────────
-- Формулы и фильтры не трогаем, меняется только name_ru/description. Это те
-- самые колонки, которые владелец видит в отчёте как «(перв.)/(повт.)».
UPDATE metrics SET name_ru = 'Кол-во продаж (перв., по воронке)',
  description = 'Количество продаж, прошедших через НЕповторные воронки Битрикса (funnels.is_repeat = false). База «по воронке» — процессный смысл: как сделка была оформлена.'
  WHERE id = 'primary_sales_count';
UPDATE metrics SET name_ru = 'Кол-во продаж (повт., по воронке)',
  description = 'Количество продаж, прошедших через воронки повторных продаж Битрикса (funnels.is_repeat = true).'
  WHERE id = 'repeat_sales_count';
UPDATE metrics SET name_ru = 'Сумма продаж (перв., по воронке)',
  description = 'Сумма продаж, прошедших через НЕповторные воронки Битрикса (funnels.is_repeat = false).'
  WHERE id = 'primary_sales_amount';
UPDATE metrics SET name_ru = 'Сумма продаж (повт., по воронке)',
  description = 'Сумма продаж, прошедших через воронки повторных продаж Битрикса (funnels.is_repeat = true).'
  WHERE id = 'repeat_sales_amount';

UPDATE metrics SET name_ru = 'Кол-во отгрузок (перв., по воронке)',
  description = 'Количество отгрузок по сделкам из НЕповторных воронок Битрикса (funnels.is_repeat = false).'
  WHERE id = 'primary_shipments_count';
UPDATE metrics SET name_ru = 'Кол-во отгрузок (повт., по воронке)',
  description = 'Количество отгрузок по сделкам из воронок повторных продаж (funnels.is_repeat = true).'
  WHERE id = 'repeat_shipments_count';
UPDATE metrics SET name_ru = 'Сумма отгрузок (перв., по воронке)',
  description = 'Сумма отгрузок по сделкам из НЕповторных воронок Битрикса (funnels.is_repeat = false).'
  WHERE id = 'primary_shipments_amount';
UPDATE metrics SET name_ru = 'Сумма отгрузок (повт., по воронке)',
  description = 'Сумма отгрузок по сделкам из воронок повторных продаж (funnels.is_repeat = true).'
  WHERE id = 'repeat_shipments_amount';

-- ── 2. Метрики по истории заказчика перестают быть служебными ────────────────
-- Были is_hidden_in_ui = true и «(служебная)» в имени — из-за этого база доли
-- была не видна из каталога вовсе. Теперь это полноценные метрики: их можно
-- поставить в отчёт рядом с воронковыми и увидеть разницу своими глазами.
-- Тег scope_independent сохраняется: пилюля «Первичные/Повторные» их не режет
-- (см. 082 — повторность здесь про историю клиента, а не про воронку периода).
UPDATE metrics SET
  name_ru = 'Кол-во продаж (перв., по истории заказчика)', is_hidden_in_ui = false, is_active = true,
  description = 'Количество продаж, являющихся ПЕРВОЙ покупкой заказчика за всю историю (contact_id, rn=1 по sold_at). База «по истории заказчика» — фактический смысл: покупал ли клиент раньше, независимо от того, в какой воронке оформлена сделка. Согласована с ППП.'
  WHERE id = 'primary_sales_count_hist';
UPDATE metrics SET
  name_ru = 'Кол-во продаж (повт., по истории заказчика)', is_hidden_in_ui = false, is_active = true,
  description = 'Количество продаж заказчикам, которые покупали и раньше (contact_id, rn>=2 по sold_at). Согласована с ППП.'
  WHERE id = 'repeat_sales_count_hist';
UPDATE metrics SET
  name_ru = 'Сумма продаж (перв., по истории заказчика)', is_hidden_in_ui = false, is_active = true,
  description = 'Сумма продаж, являющихся ПЕРВОЙ покупкой заказчика за всю историю (contact_id, rn=1 по sold_at).'
  WHERE id = 'primary_sales_amount_hist';
UPDATE metrics SET
  name_ru = 'Сумма продаж (повт., по истории заказчика)', is_hidden_in_ui = false, is_active = true,
  description = 'Сумма продаж заказчикам, которые покупали и раньше (contact_id, rn>=2 по sold_at).'
  WHERE id = 'repeat_sales_amount_hist';

-- ── 3. Отгрузки по истории заказчика — новых 4 метрики ───────────────────────
-- Виртуальные поля _primary_deliv_hist / _repeat_deliv_hist уже есть в
-- lib/metrics/sqlGen.ts::CLIENT_HISTORY_FIELDS (ROW_NUMBER по delivered_at) —
-- ими уже пользуется раздел «Повторные». Здесь заводим симметричную пару к
-- продажам, чтобы у отгрузок были обе базы, а не одна.
INSERT INTO metrics (id, name_ru, metric_type, data_type, source, agg_fn, agg_field, date_field,
  filters, tags, is_active, is_hidden_in_ui, decimal_places, aggregation_fn, is_collect_ok, category, sort_order, description)
VALUES
  ('primary_shipments_count_hist', 'Кол-во отгрузок (перв., по истории заказчика)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'delivered_at',
   '[{"op":"eq","field":"_primary_deliv_hist","value":""}]'::jsonb, ARRAY['scope_independent'], true, false, 0, 'sum', true, 'Отгрузки', 420,
   'Количество отгрузок, являющихся ПЕРВОЙ отгрузкой заказчика за всю историю (contact_id, rn=1 по delivered_at).'),
  ('repeat_shipments_count_hist', 'Кол-во отгрузок (повт., по истории заказчика)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'delivered_at',
   '[{"op":"eq","field":"_repeat_deliv_hist","value":""}]'::jsonb, ARRAY['scope_independent'], true, false, 0, 'sum', true, 'Отгрузки', 421,
   'Количество отгрузок заказчикам, которым уже отгружали раньше (contact_id, rn>=2 по delivered_at).'),
  ('primary_shipments_amount_hist', 'Сумма отгрузок (перв., по истории заказчика)', 'collected', 'money', 'deals', 'sum', 'amount', 'delivered_at',
   '[{"op":"eq","field":"_primary_deliv_hist","value":""}]'::jsonb, ARRAY['scope_independent'], true, false, 0, 'sum', true, 'Отгрузки', 422,
   'Сумма отгрузок, являющихся ПЕРВОЙ отгрузкой заказчика за всю историю (contact_id, rn=1 по delivered_at).'),
  ('repeat_shipments_amount_hist', 'Сумма отгрузок (повт., по истории заказчика)', 'collected', 'money', 'deals', 'sum', 'amount', 'delivered_at',
   '[{"op":"eq","field":"_repeat_deliv_hist","value":""}]'::jsonb, ARRAY['scope_independent'], true, false, 0, 'sum', true, 'Отгрузки', 423,
   'Сумма отгрузок заказчикам, которым уже отгружали раньше (contact_id, rn>=2 по delivered_at).')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field, date_field = EXCLUDED.date_field,
  filters = EXCLUDED.filters, tags = EXCLUDED.tags, is_active = EXCLUDED.is_active,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, decimal_places = EXCLUDED.decimal_places,
  aggregation_fn = EXCLUDED.aggregation_fn, is_collect_ok = EXCLUDED.is_collect_ok,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, description = EXCLUDED.description;

-- ── 4. Доли: ID существующих сохраняем, формулы — на ВОРОНКУ ─────────────────
-- Это и есть «в существующих отчётах вернуть воронку»: id те же, поэтому все
-- сохранённые отчёты и карточки подхватывают новую базу сами.
UPDATE metrics SET
  name_ru = 'Доля повторных продаж, % (кол-во, по воронке)',
  formula = '[repeat_sales_count] / ([primary_sales_count] + [repeat_sales_count]) * 100',
  dependencies = ARRAY['repeat_sales_count', 'primary_sales_count'], is_active = true,
  description = 'Доля повторных продаж в количестве продаж (%), база — воронка Битрикса. Сходится с колонками «Кол-во продаж (перв./повт., по воронке)». С 07.08.2026 снова считается по воронке (решение владельца: «ранее всегда считали по воронке и так все привыкли»); версия по истории заказчика — repeat_sales_count_pct_hist.'
  WHERE id = 'repeat_sales_count_pct';
UPDATE metrics SET
  name_ru = 'Доля повторных продаж, % (сумма, по воронке)',
  formula = '[repeat_sales_amount] / ([primary_sales_amount] + [repeat_sales_amount]) * 100',
  dependencies = ARRAY['repeat_sales_amount', 'primary_sales_amount'], is_active = true,
  description = 'Доля повторных продаж в сумме продаж (%), база — воронка Битрикса. Сходится с колонками «Сумма продаж (перв./повт., по воронке)». Версия по истории заказчика — repeat_sales_amount_pct_hist.'
  WHERE id = 'repeat_sales_amount_pct';
UPDATE metrics SET name_ru = 'Доля повторных отгрузок, % (кол-во, по воронке)', is_active = true,
  description = 'Доля повторных отгрузок в количестве отгрузок (%), база — воронка Битрикса. Версия по истории заказчика — repeat_shipments_count_pct_hist.'
  WHERE id = 'repeat_shipments_count_pct';
UPDATE metrics SET name_ru = 'Доля повторных отгрузок, % (сумма, по воронке)', is_active = true,
  description = 'Доля повторных отгрузок в сумме отгрузок (%), база — воронка Битрикса. Версия по истории заказчика — repeat_shipments_amount_pct_hist.'
  WHERE id = 'repeat_shipments_amount_pct';

-- ── 5. Доли первичных + доли по истории заказчика — 12 новых метрик ──────────
-- Правило каталога требует тройку «перв./повт./все», но «все» для доли — это
-- всегда 100 %, поэтому пара: доля первичных + доля повторных. Знаменатель у
-- пары общий, так что сумма двух долей даёт ровно 100 % — это удобная проверка
-- глазами прямо в отчёте.
INSERT INTO metrics (id, name_ru, metric_type, data_type, source, formula, dependencies,
  tags, is_active, is_hidden_in_ui, decimal_places, aggregation_fn, calc_ok, is_calc_ok, category, sort_order, description)
VALUES
  -- продажи, воронка
  ('primary_sales_count_pct', 'Доля первичных продаж, % (кол-во, по воронке)', 'calculated', 'percent', 'deals',
   '[primary_sales_count] / ([primary_sales_count] + [repeat_sales_count]) * 100',
   ARRAY['primary_sales_count','repeat_sales_count'], ARRAY['sales','primary','percent'], true, false, 1, 'avg', true, true, 'Продажи', 332,
   'Доля первичных продаж в количестве продаж (%), база — воронка Битрикса. В сумме с «Доля повторных продаж, % (кол-во, по воронке)» даёт 100 %.'),
  ('primary_sales_amount_pct', 'Доля первичных продаж, % (сумма, по воронке)', 'calculated', 'percent', 'deals',
   '[primary_sales_amount] / ([primary_sales_amount] + [repeat_sales_amount]) * 100',
   ARRAY['primary_sales_amount','repeat_sales_amount'], ARRAY['sales','primary','percent','amount'], true, false, 1, 'avg', true, true, 'Продажи', 333,
   'Доля первичных продаж в сумме продаж (%), база — воронка Битрикса.'),
  -- продажи, история заказчика
  ('repeat_sales_count_pct_hist', 'Доля повторных продаж, % (кол-во, по истории заказчика)', 'calculated', 'percent', 'deals',
   '[repeat_sales_count_hist] / ([primary_sales_count_hist] + [repeat_sales_count_hist]) * 100',
   ARRAY['repeat_sales_count_hist','primary_sales_count_hist'], ARRAY['sales','repeat','percent','scope_independent'], true, false, 1, 'avg', true, true, 'Продажи', 334,
   'Доля повторных продаж в количестве продаж (%), база — история заказчика (contact_id, rn>=2 по sold_at). Согласована с ППП. Может расходиться с версией «по воронке», если повторную сделку оформили в первичной воронке.'),
  ('repeat_sales_amount_pct_hist', 'Доля повторных продаж, % (сумма, по истории заказчика)', 'calculated', 'percent', 'deals',
   '[repeat_sales_amount_hist] / ([primary_sales_amount_hist] + [repeat_sales_amount_hist]) * 100',
   ARRAY['repeat_sales_amount_hist','primary_sales_amount_hist'], ARRAY['sales','repeat','percent','amount','scope_independent'], true, false, 1, 'avg', true, true, 'Продажи', 335,
   'Доля повторных продаж в сумме продаж (%), база — история заказчика (contact_id, rn>=2 по sold_at). До 07.08.2026 по этой формуле считалась метрика repeat_sales_amount_pct.'),
  ('primary_sales_count_pct_hist', 'Доля первичных продаж, % (кол-во, по истории заказчика)', 'calculated', 'percent', 'deals',
   '[primary_sales_count_hist] / ([primary_sales_count_hist] + [repeat_sales_count_hist]) * 100',
   ARRAY['primary_sales_count_hist','repeat_sales_count_hist'], ARRAY['sales','primary','percent','scope_independent'], true, false, 1, 'avg', true, true, 'Продажи', 336,
   'Доля первичных продаж в количестве продаж (%), база — история заказчика: первая покупка клиента (rn=1 по sold_at).'),
  ('primary_sales_amount_pct_hist', 'Доля первичных продаж, % (сумма, по истории заказчика)', 'calculated', 'percent', 'deals',
   '[primary_sales_amount_hist] / ([primary_sales_amount_hist] + [repeat_sales_amount_hist]) * 100',
   ARRAY['primary_sales_amount_hist','repeat_sales_amount_hist'], ARRAY['sales','primary','percent','amount','scope_independent'], true, false, 1, 'avg', true, true, 'Продажи', 337,
   'Доля первичных продаж в сумме продаж (%), база — история заказчика: первая покупка клиента (rn=1 по sold_at).'),
  -- отгрузки, воронка
  ('primary_shipments_count_pct', 'Доля первичных отгрузок, % (кол-во, по воронке)', 'calculated', 'percent', 'deals',
   '[primary_shipments_count] / ([primary_shipments_count] + [repeat_shipments_count]) * 100',
   ARRAY['primary_shipments_count','repeat_shipments_count'], ARRAY['shipments','primary','percent'], true, false, 1, 'avg', true, true, 'Отгрузки', 412,
   'Доля первичных отгрузок в количестве отгрузок (%), база — воронка Битрикса.'),
  ('primary_shipments_amount_pct', 'Доля первичных отгрузок, % (сумма, по воронке)', 'calculated', 'percent', 'deals',
   '[primary_shipments_amount] / ([primary_shipments_amount] + [repeat_shipments_amount]) * 100',
   ARRAY['primary_shipments_amount','repeat_shipments_amount'], ARRAY['shipments','primary','percent','amount'], true, false, 1, 'avg', true, true, 'Отгрузки', 413,
   'Доля первичных отгрузок в сумме отгрузок (%), база — воронка Битрикса.'),
  -- отгрузки, история заказчика
  ('repeat_shipments_count_pct_hist', 'Доля повторных отгрузок, % (кол-во, по истории заказчика)', 'calculated', 'percent', 'deals',
   '[repeat_shipments_count_hist] / ([primary_shipments_count_hist] + [repeat_shipments_count_hist]) * 100',
   ARRAY['repeat_shipments_count_hist','primary_shipments_count_hist'], ARRAY['shipments','repeat','percent','scope_independent'], true, false, 1, 'avg', true, true, 'Отгрузки', 424,
   'Доля повторных отгрузок в количестве отгрузок (%), база — история заказчика (contact_id, rn>=2 по delivered_at).'),
  ('repeat_shipments_amount_pct_hist', 'Доля повторных отгрузок, % (сумма, по истории заказчика)', 'calculated', 'percent', 'deals',
   '[repeat_shipments_amount_hist] / ([primary_shipments_amount_hist] + [repeat_shipments_amount_hist]) * 100',
   ARRAY['repeat_shipments_amount_hist','primary_shipments_amount_hist'], ARRAY['shipments','repeat','percent','amount','scope_independent'], true, false, 1, 'avg', true, true, 'Отгрузки', 425,
   'Доля повторных отгрузок в сумме отгрузок (%), база — история заказчика (contact_id, rn>=2 по delivered_at).'),
  ('primary_shipments_count_pct_hist', 'Доля первичных отгрузок, % (кол-во, по истории заказчика)', 'calculated', 'percent', 'deals',
   '[primary_shipments_count_hist] / ([primary_shipments_count_hist] + [repeat_shipments_count_hist]) * 100',
   ARRAY['primary_shipments_count_hist','repeat_shipments_count_hist'], ARRAY['shipments','primary','percent','scope_independent'], true, false, 1, 'avg', true, true, 'Отгрузки', 426,
   'Доля первичных отгрузок в количестве отгрузок (%), база — история заказчика (rn=1 по delivered_at).'),
  ('primary_shipments_amount_pct_hist', 'Доля первичных отгрузок, % (сумма, по истории заказчика)', 'calculated', 'percent', 'deals',
   '[primary_shipments_amount_hist] / ([primary_shipments_amount_hist] + [repeat_shipments_amount_hist]) * 100',
   ARRAY['primary_shipments_amount_hist','repeat_shipments_amount_hist'], ARRAY['shipments','primary','percent','amount','scope_independent'], true, false, 1, 'avg', true, true, 'Отгрузки', 427,
   'Доля первичных отгрузок в сумме отгрузок (%), база — история заказчика (rn=1 по delivered_at).')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  tags = EXCLUDED.tags, is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui,
  decimal_places = EXCLUDED.decimal_places, aggregation_fn = EXCLUDED.aggregation_fn,
  calc_ok = EXCLUDED.calc_ok, is_calc_ok = EXCLUDED.is_calc_ok,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, description = EXCLUDED.description;

COMMIT;

-- Проверка после наката (должно вернуть 28 строк: 8 воронковых collected,
-- 8 collected по истории, 12 долей):
--   SELECT id, name_ru, metric_type FROM metrics
--   WHERE id ~ '^(primary|repeat)_(sales|shipments)_(count|amount)(_hist)?(_pct)?(_hist)?$'
--   ORDER BY category, sort_order;
