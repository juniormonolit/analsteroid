-- 218: метрики объектов (адресов доставки) — задача владельца 21.09.
--
-- «Объект» = адрес доставки сделки (UF_ADDRESS_COORDS Битрикса, кэш
-- deal_addresses, миграции 216–217). Разведка по всей базе за 12 месяцев
-- показала, ради чего это нужно: 6 797 объектов, 1,80 отгрузки на объект,
-- средний чек на ОБЪЕКТ 253 763 ₽ против 141 044 ₽ на сделку, и главное —
-- 30% объектов, куда вернулись, дают 68% денег. В единице «сделка» этого не
-- видно вообще.
--
-- metric_type='external': значения считает features/reports/engine/
-- objectMetrics.ts — адреса живут в СИСТЕМНОЙ базе, а метрики каталога
-- генерируют SQL по sa.deals, и кросс-базного джойна тут быть не может
-- (писать в SA нам не дают: CREATE запрещён во всех схемах). Тот же приём,
-- что у планов (planMetrics.ts) и «Дел и задач» (dealsActivities.ts).
--
-- Шкала — ОТГРУЗКИ (delivered_at), как в отчёте «Повторные»: объект
-- появляется, когда на него реально привезли. Служебные адреса (дефолт формы
-- Битрикса и «просто город» — 32 точки на треть базы) исключены, иначе слово
-- «объект» теряет смысл.
--
-- aggregation_fn='none' у всех: объекты НЕ складываются по строкам (один адрес
-- бывает и у двух менеджеров, и в двух товарных группах, и в двух месяцах).
-- Строка «Итого» приходит отдельным честным агрегатом из движка — тем же
-- приёмом, что «Итого» у медиан звонков.
--
-- ВАЖНО про знаменатель: адрес заполнен не везде. На 21.09 по отгрузкам за 12
-- месяцев: нормальный адрес с координатами — 56%, служебный — 12%, без
-- координат — 9%, без адреса вовсе — 23%. Поэтому «Дисциплина адреса»
-- заведена отдельной метрикой: без неё остальные читаются как «мало объектов»,
-- хотя на деле «мало заполненных адресов».
--
-- БД: YC analytics (run_analytics.mjs). Идемпотентно (ON CONFLICT).

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies,
                      tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places,
                      aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
                      category, sort_order, description)
VALUES
  ('objects_count', 'Объектов', 'Объектов', 'external', 'int', NULL, ARRAY[]::text[],
   '{objects,address}', false, true, false, false, 0, 'none', false, false, true, false,
   'Объекты', 1801,
   'Сколько РАЗНЫХ адресов доставки было в отгрузках периода. Адрес берётся из поля сделки «Адрес и координаты» в Битриксе; одинаковые точки в пределах ~100 м считаются одним объектом. Служебные адреса (дефолт формы, «просто город») не учитываются. Не складывается по строкам: один объект может быть и у двух менеджеров — «Итого» считается отдельно по всей выборке.'),
  ('objects_new', 'Новых объектов', 'Новых об.', 'external', 'int', NULL, ARRAY[]::text[],
   '{objects,address}', false, true, false, false, 0, 'none', false, false, true, false,
   'Объекты', 1802,
   'Объекты периода, на которые ДО начала периода не отгружали ни разу за всю историю. Прирост географии: новые стройки и площадки, а не повторные привозы на старые.'),
  ('objects_returned', 'Вернулись на объект', 'Возврат об.', 'external', 'int', NULL, ARRAY[]::text[],
   '{objects,address}', false, true, false, false, 0, 'none', false, false, true, false,
   'Объекты', 1803,
   'Объекты периода, на которые уже возили РАНЬШЕ (есть отгрузка до начала периода). Это «повторные продажи» в правильной единице: вернулись не к клиенту, а на площадку. За 12 месяцев такие объекты дали 68% денег при 30% их числа.'),
  ('objects_return_pct', 'Доля возвратов на объект', '% возвр. об.', 'external', 'percent', NULL, ARRAY[]::text[],
   '{objects,address}', false, true, false, false, 1, 'none', false, false, true, false,
   'Объекты', 1804,
   'Вернулись на объект ÷ Объектов × 100. Насколько работа идёт по уже освоенным площадкам, а не только по новым.'),
  ('objects_avg_check', 'Средний чек на объект', 'Чек/объект', 'external', 'money', NULL, ARRAY[]::text[],
   '{objects,address}', false, true, false, false, 0, 'none', false, false, true, false,
   'Объекты', 1805,
   'Сумма отгрузок с адресом ÷ число объектов. Отличается от среднего чека сделки: на один объект часто возят несколько раз, и «сколько объект приносит целиком» — другая цифра (по базе за 12 мес: 253 763 ₽ на объект против 141 044 ₽ на сделку).'),
  ('shipments_per_object', 'Отгрузок на объект', 'Отгр./объект', 'external', 'decimal', NULL, ARRAY[]::text[],
   '{objects,address}', false, true, false, false, 2, 'none', false, false, true, false,
   'Объекты', 1806,
   'Отгрузки с адресом ÷ число объектов. Глубина работы с площадкой: 1,0 — привезли и забыли; 2+ — на объекте закупаются дальше.'),
  ('address_fill_pct', 'Дисциплина адреса', 'Адрес, %', 'external', 'percent', NULL, ARRAY[]::text[],
   '{objects,address,quality}', false, true, false, false, 1, 'none', false, false, true, false,
   'Объекты', 1807,
   'Доля отгрузок периода, у которых заполнен пригодный адрес с координатами (не служебный дефолт формы). Знаменатель — ВСЕ отгрузки строки. Без этой цифры остальные метрики объектов читаются неверно: на 21.09 по компании адрес пригоден лишь у 56% отгрузок (23% вообще без адреса).')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  tags = EXCLUDED.tags, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  decimal_places = EXCLUDED.decimal_places, aggregation_fn = EXCLUDED.aggregation_fn,
  is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok,
  is_calc_ok = EXCLUDED.is_calc_ok, description = EXCLUDED.description;
