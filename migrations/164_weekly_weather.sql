-- Migration 164: погода для спец-отчёта «Данные по годам» (решения владельца 28.08)
-- БД: YC system. Накат с ноутбука:
--   node migrations/run_local.mjs migrations/164_weekly_weather.sql
--
-- Владелец: «Живой [комментарий] — оставляем, это обязательно. По каждому отделу
-- ответственному… в понедельник в 09:00 пусть Аналитик (бот) пишет вопрос: „Как
-- погодка на той неделе была?“ и записывает ответ в таблицу… Можно вынести в
-- настройки „Кого спрашивать по погоде“… Плюс подключись к бесплатному сервису
-- реальной погоды и проставляй данные и оттуда тоже».

-- Кого спрашивать: город → bitrix id. Дефолты СПб/КРД резолвятся ЛЕНИВО кодом
-- на сервере по имени (Осипов Сергей / Федоров Даниил) — на момент миграции
-- доступа к оргструктуре (sa) из system-миграции нет; МСК задан владельцем
-- явно (2098). Переопределение — страница настроек.
CREATE TABLE IF NOT EXISTS weather_responsibles (
  city text PRIMARY KEY CHECK (city IN ('spb', 'msk', 'krd')),
  bitrix_user_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO weather_responsibles (city, bitrix_user_id)
VALUES ('msk', '2098')
ON CONFLICT (city) DO NOTHING;

-- Погода недели: живой ответ ответственного + автосводка Open-Meteo.
-- week_start — понедельник недели (МСК), на которую погода ОПИСЫВАЕТСЯ
-- (бот в понедельник спрашивает про ПРОШЛУЮ неделю).
CREATE TABLE IF NOT EXISTS weekly_weather (
  id bigserial PRIMARY KEY,
  city text NOT NULL CHECK (city IN ('spb', 'msk', 'krd')),
  week_start date NOT NULL,
  -- живой текст ответственного (из ответа боту или правки в UI)
  manual_text text,
  manual_author_bitrix_id text,
  answered_at timestamptz,
  -- кому и когда бот задал вопрос (для матчинга ответа и «не спрашивать дважды»)
  asked_bitrix_id text,
  asked_at timestamptz,
  -- автосводка Open-Meteo («t 12…22, осадки 71 мм») + сырые числа
  auto_summary text,
  auto_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city, week_start)
);

-- Ответ бота матчится так: последняя строка, где asked_bitrix_id = автор
-- сообщения и answered_at IS NULL. Индекс под этот поиск.
CREATE INDEX IF NOT EXISTS weekly_weather_pending_idx
  ON weekly_weather (asked_bitrix_id, week_start)
  WHERE answered_at IS NULL;
