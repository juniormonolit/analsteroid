-- Дайджест «Как дела?» (задача владельца 15.09.2026): бот «Аналитик» по расписанию
-- (по умолчанию 12:00, 15:00, 18:00 МСК, будни) рассказывает получателям, как идут
-- продажи дня по филиалам и отделам против дневного плана и «обычного» уровня к
-- этому часу; в 18:00 — ещё итог дня и темп месяца. Текст собирается конструктором
-- фраз (варианты + плейсхолдеры), чтобы сообщения не читались как один шаблон.

INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config) VALUES
  ('how_are_we', 'Дайджест: как дела?',
   'Сводка дня по филиалам и отделам: продажи против дневного плана и обычного уровня к этому часу, герои и провалы, аномалии по товарам; в 18:00 — итог дня и темп месяца. Часы, фразы и получатели — во вкладке «Как дела?».',
   'Аналитик', false, 36, 'Дайджесты', '{"recipients": []}')
ON CONFLICT (key) DO NOTHING;

-- Настройки конструктора: часы отправки и фразы по блокам (jsonb {block: [варианты]}).
-- Пустой phrases = стандартные фразы из кода (features/how-are-we/engine/phrases.ts).
CREATE TABLE IF NOT EXISTS how_are_we_settings (
  id           int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hours        int[] NOT NULL DEFAULT '{12,15,18}',
  weekdays_only boolean NOT NULL DEFAULT true,
  phrases      jsonb NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
INSERT INTO how_are_we_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Журнал отправок: что и кому ушло, чтобы владелец мог перечитать и сверить.
CREATE TABLE IF NOT EXISTS how_are_we_log (
  id          bigserial PRIMARY KEY,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  date_str    text NOT NULL,
  cut_hour    int NOT NULL,
  recipient   text NOT NULL,
  message     text NOT NULL,
  image_url   text,
  test        boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS how_are_we_log_sent_at_idx ON how_are_we_log (sent_at DESC);
