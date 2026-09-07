-- Задача #5589: добавить 8-ю метрику deals_with_active_zapros в сохранённый
-- отчёт admin «Отчет по делам и задачам» (посеян migrations/157/158, задача
-- #5555). Идемпотентно: если метрика уже есть в metric_ids — ничего не делает.
--
-- БД: YC system (run_system.mjs).

UPDATE saved_reports
SET metric_ids = metric_ids || ARRAY['deals_with_active_zapros']
WHERE user_login = 'admin'
  AND name = 'Отчет по делам и задачам'
  AND NOT is_shared
  AND deleted_at IS NULL
  AND NOT ('deals_with_active_zapros' = ANY(metric_ids));
