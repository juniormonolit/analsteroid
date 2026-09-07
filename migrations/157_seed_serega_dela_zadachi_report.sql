-- Задача #5555: сохранённый отчёт «Отчет по делам и задачам» из 7 новых метрик-заглушек
-- (migrations/156_dela_zadachi_metrics.sql), в личном «Избранном» Серёги.
--
-- user_login = 'devtest' — единственная явная зацепка: строка users с
-- display_name = 'Dev (Серёга)', is_admin=true, is_superadmin=true (проверено живым
-- SELECT на YC system, 2026-09-07). Кандидатов с именем «Сергей» в users несколько
-- (bx2069 «Сергей Степанов», bx2098 «Сергей Афанасьев», osipov «Сергей Осипов») —
-- это обычные сотрудники-тёзки, НЕ разработчик; ни один из них не подписан как
-- «Серёга»/dev. Если 'devtest' — не тот аккаунт, замените одной правкой: константу
-- v_user_login ниже на нужный users.login (избранное — per-user по user_login,
-- см. saved_reports.user_login + app/api/saved-reports/route.ts: GET фильтрует
-- WHERE user_login = session.login OR is_shared = true).
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
  'devtest', 'by-managers', 'Отчет по делам и задачам',
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
