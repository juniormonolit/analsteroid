-- Конструктор виджетов (Scriptable): персональные токены + персональные конфиги.
-- Расчёт метрик — фоновая джоба (lib/jobs/widgetMetrics.ts) в Redis; здесь только
-- презентационные конфиги («какой срез матрицы показать») и bearer-токены для внешнего
-- iPhone-виджета. БД: YC system (run_system.mjs) + junibaseone для dev-стенда. Идемпотентна.

-- Персональные bearer-токены виджета (модель — invite_tokens/user_sessions).
CREATE TABLE IF NOT EXISTS widget_tokens (
  token       TEXT PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS widget_tokens_user_idx ON widget_tokens(user_id) WHERE revoked_at IS NULL;

-- Персональные конфиги виджетов. Ключ (user_id, family, param): один конфиг на размер +
-- необязательный ярлык пресета (Scriptable args.widgetParameter, '' = дефолтный слот).
CREATE TABLE IF NOT EXISTS widget_configs (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family        TEXT NOT NULL,               -- 'small' | 'medium' | 'large'
  param         TEXT NOT NULL DEFAULT '',    -- ярлык пресета; '' = дефолт
  metrics       TEXT[] NOT NULL,             -- подмножество из 6 базовых id
  viz_kind      TEXT NOT NULL DEFAULT 'ring',-- 'ring' | 'line' | 'bar'
  scope_kind    TEXT NOT NULL,               -- 'department' | 'branch' | 'russia'
  scope_id      TEXT,                        -- department id / 'СПБ'|'МСК'|'КРД' / NULL для russia
  period_preset TEXT NOT NULL,               -- 'today'|'this_week'|'this_month'|'this_quarter'|'this_year'
  colors        JSONB,                       -- {accent, positive, negative} или id темы
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, family, param)
);
