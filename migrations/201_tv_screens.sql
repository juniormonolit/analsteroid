-- 201: «Телевизоры» — ТВ-дашборды отделов продаж (ТЗ владельца 07.09.2026).
--
-- Экран (tv_screens) = что показывать: набор отделов, режим (карусель /
-- объединённая сетка), тема, бегущая строка, настройки событий («мувики» на
-- продажу). У экрана есть публичный токен — по нему открывается /tv/s/<token>
-- (превью в админке и прямая ссылка).
--
-- Устройство (tv_devices) = конкретный телевизор. Телевизор открывает /tv,
-- получает device_token (localStorage+cookie) и код привязки из 4 символов,
-- который показывает крупно на экране. Админ вводит код в карточке экрана —
-- устройство привязывается к экрану, и телевизор сам переключается на дашборд.
-- Перепривязка — «Отвязать» в админке, код появится снова.
--
-- Сообщения (tv_messages) = рассылка на экраны: бегущая строка / баннер /
-- на весь экран, адресат — все экраны (target_screen_ids IS NULL) или список.
-- Действует в окне [starts_at, ends_at).

CREATE TABLE IF NOT EXISTS tv_screens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  comment         TEXT,
  public_token    TEXT NOT NULL UNIQUE,
  department_ids  uuid[] NOT NULL DEFAULT '{}',
  mode            TEXT NOT NULL DEFAULT 'carousel' CHECK (mode IN ('carousel', 'merged')),
  theme           TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),
  rotate_sec      INT  NOT NULL DEFAULT 15 CHECK (rotate_sec BETWEEN 5 AND 300),
  ticker_text     TEXT,
  ticker_enabled  BOOLEAN NOT NULL DEFAULT false,
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tv_devices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_token          TEXT NOT NULL UNIQUE,
  screen_id             uuid REFERENCES tv_screens(id) ON DELETE SET NULL,
  pair_code             TEXT,
  pair_code_expires_at  TIMESTAMPTZ,
  label                 TEXT,
  user_agent            TEXT,
  last_ip               TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ,
  paired_at             TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS tv_devices_pair_code_idx ON tv_devices(pair_code) WHERE pair_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS tv_devices_screen_idx ON tv_devices(screen_id);

CREATE TABLE IF NOT EXISTS tv_messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               TEXT NOT NULL CHECK (kind IN ('ticker', 'banner', 'fullscreen')),
  text               TEXT NOT NULL,
  target_screen_ids  uuid[],                       -- NULL = все экраны
  starts_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at            TIMESTAMPTZ NOT NULL,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_name    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tv_messages_active_idx ON tv_messages(ends_at);
