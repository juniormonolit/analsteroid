-- Оргструктура в sa (переезд с system, задача Серёги 13.07).
-- Применяется на Мишиной БД (62.113.100.67) под supabase_admin.
-- Зеркалит system.{departments,org_resolved_hierarchy,user_departments} 1-в-1
-- (uuid сохраняются при переносе), + справочник филиалов и история имён.

-- Справочник филиалов: короткое + развёрнутое имя (по месту в UI).
CREATE TABLE IF NOT EXISTS sa.branches (
  code        text PRIMARY KEY,          -- spb/msk/krd/ekb
  raw_label   text UNIQUE,               -- как приходит из резолвера: 'СПб','Москва/МО',...
  short_name  text NOT NULL,             -- СПб/МСК/КРД/ЕКБ
  full_name   text NOT NULL,             -- Санкт-Петербург/Москва/Краснодар/Екатеринбург
  sort_order  int DEFAULT 0
);
INSERT INTO sa.branches(code,raw_label,short_name,full_name,sort_order) VALUES
  ('spb','СПб','СПб','Санкт-Петербург',1),
  ('msk','Москва/МО','МСК','Москва',2),
  ('krd','Краснодар','КРД','Краснодар',3),
  ('ekb','Екатеринбург','ЕКБ','Екатеринбург',4)
ON CONFLICT (code) DO UPDATE SET raw_label=EXCLUDED.raw_label, short_name=EXCLUDED.short_name,
  full_name=EXCLUDED.full_name, sort_order=EXCLUDED.sort_order;

CREATE TABLE IF NOT EXISTS sa.departments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bitrix_department_id        text NOT NULL UNIQUE,
  name                        text NOT NULL,
  parent_bitrix_department_id text,
  head_bitrix_user_id         text,
  director_bitrix_user_id     text,
  is_active                   boolean NOT NULL DEFAULT true,
  created_at                  timestamptz DEFAULT now(),
  updated_at                  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sa.org_resolved_hierarchy (
  id                                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_bitrix_user_id             text NOT NULL UNIQUE,
  manager_name                       text,
  department_id                      uuid REFERENCES sa.departments(id) ON DELETE SET NULL,
  department_name                    text,
  rop_bitrix_user_id                 text,
  rop_name                           text,
  department_director_bitrix_user_id text,
  department_director_name           text,
  company_director_bitrix_user_id    text,
  company_director_name              text,
  resolved_path                      jsonb,
  is_active                          boolean,
  resolved_at                        timestamptz,
  source_snapshot_at                 timestamptz,
  short_login                        text,
  branch                             text,                 -- raw label (1-в-1 с system)
  branch_code                        text REFERENCES sa.branches(code)
);

CREATE TABLE IF NOT EXISTS sa.user_departments (
  user_id       uuid NOT NULL,   -- system.users(id); межбазовой FK нет, храним значение
  department_id uuid NOT NULL REFERENCES sa.departments(id) ON DELETE CASCADE,
  created_at    timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, department_id)
);

-- Фиксация смены имени менеджера (SCD2). valid_to IS NULL = действующее имя.
CREATE TABLE IF NOT EXISTS sa.employee_name_history (
  id             bigserial PRIMARY KEY,
  bitrix_user_id text NOT NULL,
  name           text NOT NULL,
  valid_from     timestamptz NOT NULL DEFAULT now(),
  valid_to       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_emp_name_hist_current
  ON sa.employee_name_history(bitrix_user_id) WHERE valid_to IS NULL;
