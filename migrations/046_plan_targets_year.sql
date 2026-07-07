-- Годовой план по отгрузкам для России и филиалов — источник для «Сводной»/виджета.
-- /decomposition хранит план как захардкоженные числа во фронтенде (features/decomposition/data.ts),
-- отдельного места для этих цифр в БД нет — заводим минимальную таблицу (Приложение А ТЗ виджета).
-- БД: YC system.
CREATE TABLE IF NOT EXISTS plan_targets_year (
  id SERIAL PRIMARY KEY,
  year INT NOT NULL,
  scope TEXT NOT NULL,          -- 'company' (вся Россия) | 'branch'
  scope_name TEXT,              -- NULL для company; 'СПБ' / 'МСК' / 'КРД' для branch
  target_amount NUMERIC NOT NULL
);

-- scope_name NULL для 'company' — обычный UNIQUE(year, scope, scope_name) не ловит дубли NULL
-- (Postgres считает NULL <> NULL), поэтому два частичных индекса вместо одного составного.
CREATE UNIQUE INDEX IF NOT EXISTS plan_targets_year_company_uq
  ON plan_targets_year (year) WHERE scope = 'company';
CREATE UNIQUE INDEX IF NOT EXISTS plan_targets_year_branch_uq
  ON plan_targets_year (year, scope_name) WHERE scope = 'branch';

-- Заполнено вручную текущими годовыми итогами из features/decomposition/data.ts.
INSERT INTO plan_targets_year (year, scope, scope_name, target_amount) VALUES
  (2026, 'company', NULL,   3459065176),
  (2026, 'branch',  'СПБ',  2320519650),
  (2026, 'branch',  'МСК',  920345526),
  (2026, 'branch',  'КРД',  218200000)
ON CONFLICT DO NOTHING;
