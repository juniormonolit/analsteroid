-- Задача #5555: сохранённый отчёт «Отчет по делам и задачам» из 7 новых метрик-заглушек
-- (migrations/156_dela_zadachi_metrics.sql), в личном «Избранном» Серёги.
--
-- user_login = 'admin' — уточнено Серёгой (владелец Монолитики) 2026-09-07: отчёт
-- должен лежать в Избранном аккаунта admin (login=admin, display_name Admin,
-- superadmin), не devtest. Исходно строка сеялась под devtest (display_name
-- 'Dev (Серёга)', is_admin=true, is_superadmin=true) — перенос выполнен
-- migrations/158_move_dela_zadachi_report_to_admin.sql, эта миграция сама
-- перецелена на admin, чтобы на свежем dev-стенде отчёт сразу сеялся под нужным
-- логином. Избранное — per-user по user_login, см. saved_reports.user_login +
-- app/api/saved-reports/route.ts: GET фильтрует WHERE user_login = session.login
-- OR is_shared = true.
--
-- Избранное = личный (НЕ is_shared) saved_reports с deleted_at IS NULL — раздел
-- «Избранное» в сайдбаре (components/layout/AppShell.tsx: ownReports = !isShared &&
-- userLogin === user.login) показывает такие строки независимо от report_slug.
-- report_slug='by-managers' — просто дефолтная страница-источник (метаданные,
-- на видимость в «Избранном» не влияет).
--
-- Идемпотентно: ON CONFLICT по частичному уникальному индексу личных отчётов
-- (user_login, name) WHERE NOT is_shared AND deleted_at IS NULL (migration 069).
--
-- БД: YC system (run_system.mjs).

INSERT INTO saved_reports (
  user_login, report_slug, name, metric_ids,
  deal_scope, client_type, grouping, comparison_display, product_group_mode,
  department_ids, is_shared
)
VALUES (
  'admin', 'by-managers', 'Отчет по делам и задачам',
  ARRAY['dela_total', 'dela_overdue', 'dela_today', 'deals_without_dela',
        'zadachi_total', 'zadachi_overdue', 'zadachi_today'],
  'all', 'all', 'none', 'full', 'kc',
  '{}', false
)
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
