-- RBAC: роли = именованные наборы прав (видимость разделов + действия).
-- Каталог валидных ключей прав живёт в коде (lib/auth/perms.ts) — БД хранит только
-- выбранные ключи, неизвестные игнорируются hasPerm (добавление ключей без миграций).
-- users.is_admin после этой миграции кодом не используется (колонка остаётся как есть).
-- is_superadmin — единственный доступ к настройке ролей; выставляется только руками в БД.
-- БД: YC system.

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,   -- сидовые роли: нельзя удалить
  permissions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES roles(id) ON DELETE RESTRICT;

INSERT INTO roles (name, description, is_system, permissions) VALUES
('Администратор', 'Полный доступ ко всем разделам и действиям', true,
 ARRAY['section.sales','section.marketing','section.summary','section.plans',
       'section.decomposition','section.metrics','section.settings',
       'action.plans.edit','action.users.manage','action.shared_reports.manage']),
('Пользователь', 'Все разделы, кроме Метрик и Настроек', true,
 ARRAY['section.sales','section.marketing','section.summary','section.plans',
       'section.decomposition','action.plans.edit'])
ON CONFLICT (name) DO NOTHING;

-- backfill: сегодняшние админы → «Администратор», остальные → «Пользователь»
UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'Администратор')
WHERE is_admin = true AND role_id IS NULL;
UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'Пользователь')
WHERE role_id IS NULL;

UPDATE users SET is_superadmin = true WHERE login = 'admin';
