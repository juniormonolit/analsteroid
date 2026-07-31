-- Система бейджей/наград менеджеров, этап 1 (задача 2655).
-- СИСТЕМНАЯ БД (YC, dbname=system, та же, что users) — применяется вручную
-- migrations/run_system.mjs на проде.
-- Каталог наград сеется кодом (features/badges/engine/catalog.ts, upsert
-- ON CONFLICT DO NOTHING — правки порогов/вкл-выкл из настроек переживают деплой).
-- DOWN: DROP TABLE IF EXISTS badge_awards; DROP TABLE IF EXISTS badge_definitions;

CREATE TABLE IF NOT EXISTS badge_definitions (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  icon        text NOT NULL DEFAULT '🏅',       -- эмодзи, без внешних ассетов
  category    text NOT NULL,                    -- top | crosssell | repeat | speed | record | streak | hygiene | milestone | rare
  tiered      boolean NOT NULL DEFAULT false,   -- есть ли уровни бронза/серебро/золото/платина
  criteria    jsonb NOT NULL DEFAULT '{}'::jsonb, -- пороги/параметры (редактируются в настройках)
  enabled     boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS badge_awards (
  id          bigserial PRIMARY KEY,
  bitrix_id   integer NOT NULL,                 -- менеджер (bitrix_user_id)
  badge_key   text NOT NULL REFERENCES badge_definitions(key) ON DELETE CASCADE,
  tier        text,                             -- bronze | silver | gold | platinum | NULL
  period_type text,                             -- day | week | month | year | NULL (событийные)
  period_date date,                             -- начало периода / день события | NULL
  value       numeric,                          -- сумма/счётчик, зависит от бейджа
  awarded_at  timestamptz NOT NULL DEFAULT now()
);

-- Идемпотентность начислений: одна награда на (менеджер, бейдж, уровень, период).
-- NULL-поля событийных бейджей нормализуются COALESCE'ом, иначе UNIQUE их не ловит.
CREATE UNIQUE INDEX IF NOT EXISTS uq_badge_awards
  ON badge_awards (bitrix_id, badge_key, coalesce(tier, '-'), coalesce(period_type, '-'), coalesce(period_date, '0001-01-01'::date));

CREATE INDEX IF NOT EXISTS idx_badge_awards_mgr ON badge_awards (bitrix_id, awarded_at DESC);
CREATE INDEX IF NOT EXISTS idx_badge_awards_key ON badge_awards (badge_key);
