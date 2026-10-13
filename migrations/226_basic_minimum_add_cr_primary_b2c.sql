-- Миграция 226: «Базовый минимум» — добавить «CR Сделка → Бронь (перв., физлица)» справа от
-- «CR Сделка → Бронь». БД: YC system. Накат (ПОСЛЕ 225):
--   node migrations/run_local.mjs migrations/226_basic_minimum_add_cr_primary_b2c.sql
--
-- Какой именно id стоит в отчёте (перв./все/повт.), в репозитории не записано, поэтому якорь —
-- первый найденный из вариантов «CR Сделка → Бронь»; нет ни одного — метрика дописывается в
-- конец. Повторный накат ничего не дублирует.

UPDATE saved_reports sr
SET metric_ids = CASE
  WHEN a.pos = 0 THEN sr.metric_ids || 'cr_deal_to_reservation_primary_b2c'::text
  ELSE sr.metric_ids[1:a.pos] || 'cr_deal_to_reservation_primary_b2c'::text || sr.metric_ids[a.pos+1:array_length(sr.metric_ids,1)]
END
FROM (
  SELECT id, GREATEST(
    COALESCE(array_position(metric_ids, 'cr_deal_to_reservation'), 0),
    COALESCE(array_position(metric_ids, 'cr_deal_to_reservation_all'), 0),
    COALESCE(array_position(metric_ids, 'cr_deal_to_reservation_repeat'), 0)) AS pos
  FROM saved_reports
) a
WHERE a.id = sr.id AND sr.name ILIKE 'базовый минимум' AND sr.deleted_at IS NULL
  AND NOT ('cr_deal_to_reservation_primary_b2c' = ANY(sr.metric_ids));

SELECT id, name, is_shared, array_position(metric_ids, 'cr_deal_to_reservation_primary_b2c') AS pos, metric_ids
FROM saved_reports WHERE name ILIKE 'базовый минимум' AND deleted_at IS NULL;
