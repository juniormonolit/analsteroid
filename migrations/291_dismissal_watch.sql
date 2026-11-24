-- 291: «Сторож увольнений» (Увольнятор v4, владелец 24.11). Бот «Аналитик» читает чат «Увольнения» (Битрикс,
-- chat226952) опросом im.dialog.messages.get, на каждое объявление «… уволен» заводит черновик Увольнятора и
-- пишет руководителю уволенного; не запустили до 18:00 следующего рабочего дня — эскалация (РОП → директор →
-- Куликов), дубли — в зеркало «Контроля звонков». Код: features/dismissal/watch/*.
--   dismissal_watch_settings — одна строка (id=1): рубильник, dry_run, чат, курсор (id последнего обработанного
--     сообщения; NULL — при первом опросе встать на последнее сообщение и старое НЕ обрабатывать), next_poll_at —
--     аренда опроса (UPDATE … WHERE next_poll_at <= now() — два процесса не опросят чат одновременно);
--   dismissal_watch_cases — кейс «объявили увольнение» на (сообщение, сотрудник).
-- БД: monolitika (systemDb), накат — под monolitik. Идемпотентна. Откат: DROP TABLE обеих.

CREATE TABLE IF NOT EXISTS dismissal_watch_settings (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled       boolean NOT NULL DEFAULT true,
  dry_run       boolean NOT NULL DEFAULT false,
  chat_id       text NOT NULL DEFAULT 'chat226952',
  cursor        bigint,
  next_poll_at  timestamptz,
  last_poll_at  timestamptz,
  last_error    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO dismissal_watch_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS dismissal_watch_cases (
  id                bigserial PRIMARY KEY,
  chat_id           text NOT NULL,
  message_id        bigint NOT NULL,
  message_text      text NOT NULL,
  line              text NOT NULL,                 -- строка сообщения про этого сотрудника
  source_bitrix_id  bigint NOT NULL,
  source_name       text NOT NULL,
  author_bitrix_id  bigint,
  author_name       text,
  announced_at      timestamptz NOT NULL,
  run_id            uuid REFERENCES dismissal_runs(id) ON DELETE SET NULL,
  level             smallint NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 2), -- 0 РОП, 1 директор, 2 Куликов
  deadline          timestamptz NOT NULL,
  notifications     jsonb NOT NULL DEFAULT '[]',   -- [{level, bitrixId, name, at, messageId, mirrored, error}]
  resolved_at       timestamptz,                   -- прогон запущен (started_at)
  resolved_run_id   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, source_bitrix_id)
);
CREATE INDEX IF NOT EXISTS dismissal_watch_cases_open ON dismissal_watch_cases (deadline) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS dismissal_watch_cases_run ON dismissal_watch_cases (run_id);
CREATE INDEX IF NOT EXISTS dismissal_watch_cases_source ON dismissal_watch_cases (source_bitrix_id);

-- ── Гранты роли приложения (как 287: копируем с repeat_kanban_events) ─────────
DO $$
DECLARE r record; t text;
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
    FOREACH t IN ARRAY ARRAY['dismissal_watch_settings', 'dismissal_watch_cases'] LOOP
      IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      ELSE
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END IF;
    END LOOP;
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE dismissal_watch_cases_id_seq TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
