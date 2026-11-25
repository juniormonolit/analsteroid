-- 297: «Большой брат», пакет сбора данных (поток A, 26.11; владелец одобрил: «писать то, что задним числом не восстановить»).
--   bot_message_log — журнал исходящих сообщений бота «Аналитик» (lib/bitrix/notify.ts: sendBitrixBotMessage /
--     sendBitrixBotMessageWithImage). Строка заводится ДО отправки: её id уходит в ссылки Монолитики внутри сообщения
--     как ?src=bot&m=<id>, трекер кладёт src/m в первый mono_view — так видно, кто открыл ссылку из какого сообщения.
--     Текст сообщения НЕ храним (ПДн клиентов), только форма: канал, получатель, kind, сущность, id сообщения в Битриксе.
--   changelog_entries.section — к какому разделу относится запись «Что изменилось?» (для связи «прочитал → зашёл»).
-- БД: monolitika (systemDb), накат — под monolitik. Идемпотентна.
-- Откат: DROP TABLE bot_message_log; ALTER TABLE changelog_entries DROP COLUMN section;

CREATE TABLE IF NOT EXISTS bot_message_log (
  id                  bigserial PRIMARY KEY,
  ts                  timestamptz NOT NULL DEFAULT now(),
  channel             text NOT NULL,           -- BotChannel (gamification, how_are_we, idle_watch, …)
  recipient_bitrix_id text NOT NULL,
  kind                text,                    -- что за сообщение (по умолчанию = channel)
  entity_type         text,
  entity_id           text,
  has_image           boolean NOT NULL DEFAULT false,
  links               int NOT NULL DEFAULT 0,  -- сколько ссылок Монолитики помечено src=bot&m=<id>
  bitrix_message_id   bigint,                  -- NULL — не ушло (ошибка / канал выключен)
  status              text NOT NULL DEFAULT 'pending' -- pending | sent | failed | disabled
);
CREATE INDEX IF NOT EXISTS bot_message_log_recipient_idx ON bot_message_log (recipient_bitrix_id, ts);
CREATE INDEX IF NOT EXISTS bot_message_log_ts_idx ON bot_message_log (ts);

ALTER TABLE changelog_entries ADD COLUMN IF NOT EXISTS section text;

-- ── Гранты роли приложения (как 296: копируем с repeat_kanban_events) ─────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs FROM (
      SELECT grantee::text, privilege_type::text FROM information_schema.role_table_grants
       WHERE table_name = 'repeat_kanban_events' AND table_schema = current_schema()
      UNION ALL
      SELECT tableowner::text, 'OWNER' FROM pg_tables WHERE tablename = 'repeat_kanban_events' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON bot_message_log TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE bot_message_log_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON bot_message_log TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
