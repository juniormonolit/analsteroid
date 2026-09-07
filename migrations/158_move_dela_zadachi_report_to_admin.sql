-- Задача #5555 (доработка): перенос сохранённого отчёта «Отчет по делам и задачам»
-- из личного «Избранного» devtest в личное «Избранное» admin — по указанию Серёги
-- (владелец Монолитики). Утренний прогон migrations/157_... посеял строку под
-- devtest (единственная явная зацепка на тот момент); 157 задним числом перецелена
-- на admin, но на проде уже лежит фактическая строка под devtest — эта миграция
-- переносит её (не копирует): если целевой admin-строки ещё нет — INSERT из
-- devtest-строки, если уже есть (например 157 применилась заново после правки) —
-- слияние через тот же ON CONFLICT, что и в 157. Затем исходная devtest-строка
-- удаляется. Идемпотентно на повторный прогон (checkpoints/автодеплой): если
-- devtest-строки уже нет — INSERT/SELECT и DELETE ничего не делают.
--
-- БД: YC system (run_system.mjs).

INSERT INTO saved_reports (
  user_login, report_slug, name, metric_ids,
  deal_scope, client_type, grouping, comparison_display, product_group_mode,
  department_ids, is_shared
)
SELECT
  'admin', report_slug, name, metric_ids,
  deal_scope, client_type, grouping, comparison_display, product_group_mode,
  department_ids, is_shared
FROM saved_reports
WHERE user_login = 'devtest'
  AND name = 'Отчет по делам и задачам'
  AND NOT is_shared
  AND deleted_at IS NULL
ON CONFLICT (user_login, name) WHERE NOT is_shared AND deleted_at IS NULL
DO UPDATE SET
  metric_ids = EXCLUDED.metric_ids,
  deal_scope = EXCLUDED.deal_scope,
  client_type = EXCLUDED.client_type,
  grouping = EXCLUDED.grouping,
  comparison_display = EXCLUDED.comparison_display,
  product_group_mode = EXCLUDED.product_group_mode,
  department_ids = EXCLUDED.department_ids,
  is_shared = EXCLUDED.is_shared;

DELETE FROM saved_reports
WHERE user_login = 'devtest'
  AND name = 'Отчет по делам и задачам'
  AND NOT is_shared
  AND deleted_at IS NULL;
