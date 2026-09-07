-- Задача #5594: sa.deals.activities переходит на схему из 6 полей
-- (activity_id/type/name/responsible_id/date_create/date_end) — deadline
-- переименован в date_end (см. features/reports/engine/dealsActivities.ts).
-- Правит только ТЕКСТ description метрик каталога (migrations/198 уже мог
-- быть применён — это UPDATE поверх, идемпотентно), расчёт менять не нужно.
--
-- БД: YC analytics (run_analytics.mjs).

UPDATE metrics SET description = v.description
FROM (VALUES
  ('dela_overdue', 'Просроченные дела активных сделок менеджера (date_end < сейчас, без учёта заглушки без-срока ''9999-12-31'' из переходного периода). Снимок на текущий момент, обновляется 4 раза в день.'),
  ('zadachi_overdue', 'Просроченные задачи активных сделок менеджера (date_end < сейчас, без учёта заглушки без-срока ''9999-12-31'' из переходного периода). Снимок на текущий момент, обновляется 4 раза в день.')
) AS v(id, description)
WHERE metrics.id = v.id;
