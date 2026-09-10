-- Migration 193: «Доля прозвона ППП» — по аналогии с «Долей прозвона повторных продаж» (184)
-- БД: YC analytics. Накат: node migrations/run_local.mjs migrations/193_ppp_call_share.sql --db=analytics
--
-- Задача владельца 10.09: та же метрика прозвона, но популяция — сделки ППП
-- (первая повторная продажа = ВТОРАЯ по счёту продажа в истории заказчика,
-- виртуальный фильтр _ppp: rn=2 по sold_at, как у существующей «ППП» ppp_count).
--   числитель  ppp_called_count     — ППП-сделки периода (по дате продажи), по которым
--                                     есть хотя бы один звонок (_has_call, любое
--                                     направление/результат, привязка к этой сделке);
--   знаменатель — существующая «ППП» (ppp_count, тот же date_field sold_at и _ppp);
--   доля       ppp_called_share_pct  = числитель ÷ «ППП» × 100.
-- Обе — конструкторные: работают во всех сущностях отчётов, графиках и квестах.
-- scope_independent — как у ppp_count: пилюли Перв./Повт. популяцию не режут,
-- ППП определяется по истории заказчика, а не по воронке. Данные звонков — с 30.03.2026.

BEGIN;

INSERT INTO metrics (id, name_ru, name_short_ru, category, metric_type, data_type, decimal_places,
                     agg_fn, agg_field, date_field, filters, tags, sort_order, is_active, is_hidden_in_ui,
                     description, human_description, formula_human)
VALUES (
  'ppp_called_count', 'Прозвон ППП: сделок со звонком (кол-во)', 'ППП со звонком', 'Клиенты',
  'collected', 'int', 0, 'count_distinct', 'deal_id', 'sold_at',
  '[{"op":"eq","field":"_ppp","value":""},{"op":"eq","field":"_has_call","value":""}]'::jsonb,
  ARRAY['calls','clients','scope_independent'], 1618, true, false,
  'Числитель «Доли прозвона ППП» (миграция 193): ППП-сделки (rn=2 по sold_at у заказчика, фильтр _ppp) с sold_at в периоде, у которых есть звонок по deal_id (_has_call). Знаменатель — ppp_count.',
  'Берём сделки, которые стали ВТОРОЙ продажей в истории заказчика (ППП) и проданы в периоде. Считаем те, по которым есть хотя бы один звонок — любого направления и с любым результатом, привязанный именно к этой сделке. Данные звонков ведутся с 30.03.2026 — за более ранние периоды метрика ложно нулевая.',
  '= число ППП-сделок (вторая продажа заказчика), проданных в периоде, по которым есть хотя бы один звонок'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO metrics (id, name_ru, name_short_ru, category, metric_type, data_type, decimal_places,
                     formula, dependencies, tags, sort_order, is_active, is_hidden_in_ui,
                     description, human_description, formula_human)
VALUES (
  'ppp_called_share_pct', 'Доля прозвона ППП, %', 'Прозвон ППП', 'Клиенты',
  'calculated', 'percent', 1,
  '[ppp_called_count] / [ppp_count] * 100', ARRAY['ppp_called_count','ppp_count'],
  ARRAY['calls','clients'], 1619, true, false,
  'Доля ППП-сделок периода со звонком (миграция 193). Аналог repeat_called_share_pct для популяции ППП.',
  'Какую часть первых повторных продаж (ППП) менеджеры сопровождали звонком. 1) Считаем «Прозвон ППП: сделок со звонком» и «ППП» — обе по дате ПРОДАЖИ в периоде, обе только по сделкам, ставшим второй продажей заказчика. 2) Делим первое на второе и умножаем на 100. Хвост периода честный: продажа уже состоялась, звонок либо был, либо нет.',
  '= «Прозвон ППП: сделок со звонком» ÷ «ППП» × 100'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
