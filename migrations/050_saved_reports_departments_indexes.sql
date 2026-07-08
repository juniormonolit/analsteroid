-- Индексы производительности для YC system DB. БД: YC system (run_system.mjs).
-- НЕ ПРИМЕНЕНО К БАЗЕ — только файл миграции (см. задачу #1277).
--
-- Оговорка после замера 08.07.2026: живой доступ был только к БД сделок (MLT,
-- схема sa); saved_reports/departments живут в YC system, куда подключения нет —
-- существующие индексы этих таблиц НЕ проверены. Перед применением обязательно
-- свериться с pg_indexes на YC system (на sa.deals такая сверка выкинула 8 из 13
-- первоначально предложенных индексов как дубли).

-- saved_reports: список отчётов пользователя читается как
-- `WHERE user_login = $1 OR is_shared = true` (app/api/saved-reports/route.ts,
-- app/(app)/sales/saved/[id]/page.tsx). Левая часть уже покрыта уникальным
-- ограничением saved_reports_user_name_unique (user_login, name) из миграции 020 —
-- не дублируем. Правая часть (is_shared = true) — частичный индекс: доля
-- "расшаренных" отчётов маленькая, индекс получается крошечным и полностью
-- закрывает вторую половину OR без seq scan всей таблицы.
CREATE INDEX IF NOT EXISTS idx_saved_reports_is_shared
  ON saved_reports (is_shared) WHERE is_shared = true;

-- departments: везде фигурирует как `WHERE bitrix_department_id = ANY($1)` —
-- фильтр по отделам в drilldown'ах (byManagers/byProductGroups deptIds,
-- /api/reports/deals?departmentIds=, /api/plans/export?deptIds=).
CREATE INDEX IF NOT EXISTS idx_departments_bitrix_department_id
  ON departments (bitrix_department_id);

-- org_resolved_hierarchy сознательно НЕ индексируем в этой миграции: не удалось
-- подтвердить вживую (нет доступа к БД в этой песочнице), что это обычная таблица,
-- а не VIEW/MATERIALIZED VIEW (название и способ наполнения — "resolved" —
-- намекают на производную сущность). CREATE INDEX на VIEW упадёт с ошибкой.
-- Плюс таблица, по всем признакам (справочник активных сотрудников), небольшая —
-- ожидаемый выигрыш от индекса на WHERE is_active = true / department_id
-- незначителен. Перед добавлением индекса нужно сначала подтвердить через
-- `SELECT relkind FROM pg_class WHERE relname = 'org_resolved_hierarchy'` (должно
-- быть 'r'), и оценить размер через pg_stat_user_tables.
