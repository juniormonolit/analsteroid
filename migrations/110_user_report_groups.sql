-- Пользовательские группы строк отчёта (задача 2653): директор объединяет
-- менеджеров/товарные группы в именованные агрегаты («офис» vs «удалёнка»).
-- СИСТЕМНАЯ БД (YC, dbname=system) — тот же паттерн per-user хранения, что
-- saved_reports (001): ключ user_login. DOWN: DROP TABLE IF EXISTS user_report_groups;

CREATE TABLE IF NOT EXISTS user_report_groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_login   text NOT NULL,
  -- 'manager' | 'product-group:kc' | 'product-group:by_max' — товарные группы
  -- у двух шкал несовместимы (id vs имя), поэтому шкала входит в ключ.
  dimension_key text NOT NULL,
  name         text NOT NULL,
  member_ids   text[] NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_report_groups_user ON user_report_groups (user_login, dimension_key);
