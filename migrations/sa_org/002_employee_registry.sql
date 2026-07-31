-- Реестр сотрудников (задача 2654 Б): ручная дата начала работы (стаж) + заметки.
-- АНАЛИТИЧЕСКАЯ БД sa (self-hosted Supabase 62.113.100.67) — НЕ системная YC.
--
-- ПРИМЕНЯЕТСЯ СУПЕР-ЮЗЕРОМ ВРУЧНУЮ (docker exec supabase-db psql -U supabase_admin -d postgres):
-- у app-юзера junior_user нет CREATE в схеме sa. ПРИМЕНЕНА 31.07.2026.
--
-- Замечания по модели:
--  * sa.employees приложение НИКОГДА не пишет — её ведёт внешний синк. Стаж считается
--    как COALESCE(employee_registry.manual_start_date, employees.hire_date).
--  * История переименований логина НЕ создаётся заново: таблица sa.employee_name_history
--    (SCD2: bitrix_user_id, name, valid_from, valid_to) уже существует (sa_org/001) и
--    ведётся org-sync'ом (lib/org/sync.ts) + детектом на странице «Сотрудники»
--    (features/employees/engine/registry.ts). junior_user уже имеет на неё права.
--  * junior_user получает SELECT/INSERT/UPDATE на реестр, DELETE сознательно НЕ выдан
--    (очистка ручной даты = UPDATE manual_start_date = NULL).
--
-- DOWN: DROP TABLE IF EXISTS sa.employee_registry;

CREATE TABLE IF NOT EXISTS sa.employee_registry (
  bitrix_id         integer PRIMARY KEY,
  manual_start_date date,                       -- если задана — приоритетнее employees.hire_date
  notes             text NOT NULL DEFAULT '',
  updated_by        text,                       -- login пользователя приложения
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE sa.employee_registry IS
  'Ручной реестр сотрудников (analsteroid, задача 2654): ручная дата начала работы для стажа и заметки. sa.employees не трогаем — её ведёт синк.';

GRANT USAGE ON SCHEMA sa TO junior_user;
GRANT SELECT, INSERT, UPDATE ON sa.employee_registry TO junior_user;
REVOKE DELETE ON sa.employee_registry FROM junior_user;
