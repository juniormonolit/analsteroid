-- Скрыть из каталога 3 мёртвые метрики «Необработанные», заведённые миграциями 014/041.
--
-- Диагноз (подтверждён живым запросом к продовой sa.deals/sa.stages 30.07.2026, Маркус):
-- фильтр {"field":"stage_type","op":"eq","value":"new"} резолвится в
--   d.stage_id IN (SELECT id FROM stages WHERE event_type = 'new')
-- (см. lib/metrics/sqlGen.ts resolveFilterClause). Значения event_type='new' в таблице
-- stages НЕ существует ни на одном контуре (YC-справочник, прод sa.stages) — реальная
-- NEW-стадия (C4:NEW «Новая сделка (срочно обработать)», C7:NEW «Новый тендер») имеет
-- event_type='created'. Поэтому подзапрос всегда пуст → все три метрики всегда 0.
--
-- Разрешение владельца приложения (Серёга): скрыть из UI, НЕ удалять/не деактивировать.
-- Живая метрика stage_now_unprocessed_count («Необработанные», категория
-- «Стадии (сейчас)», реально 1561/440 в зависимости от периода) НЕ затрагивается.
--
-- Обратимость: UPDATE metrics SET is_hidden_in_ui = false WHERE id = ANY(ARRAY[
--   'unprocessed_count','unprocessed_primary_count','unprocessed_repeat_count'
-- ]);

UPDATE metrics
SET is_hidden_in_ui = true
WHERE id = ANY(ARRAY[
  'unprocessed_count',
  'unprocessed_primary_count',
  'unprocessed_repeat_count'
]::text[]);
