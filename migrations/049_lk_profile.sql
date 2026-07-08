-- ЛК пользователя (/profile): аватар из Битрикса + подконтрольные отделы.
-- Дочерние отделы включаются НЕявно — проходом вверх по
-- departments.parent_bitrix_department_id в коде (lib/profile/deptSummary.ts);
-- в таблице храним только явно назначенные админом узлы.
-- Таблиц под конструктор уведомлений (notification_rules) пока нет — придёт
-- отдельной миграцией вместе с самим конструктором.
-- БД: YC system.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS avatar_synced_at timestamptz;

CREATE TABLE IF NOT EXISTS user_departments (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  created_at    timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, department_id)
);
