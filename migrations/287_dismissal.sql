-- 287: «Увольнятор» (задача владельца 24.11) — прогоны передачи дел уволенного сотрудника.
-- Контракт: features/dismissal/types.ts. Движок: features/dismissal/engine (воркер в процессе
-- приложения, instrumentation.ts, env DISMISSAL_WORKER).
--   dismissal_runs  — один прогон = один уволенный: статус, план (правила + исключения), блокировка воркера;
--   dismissal_items — что нашли на аккаунте при сканировании (живое чтение Битрикса) и итог по строке.
-- Плюс функция бота «Аналитик» 'dismissal' (bot_channels) — сообщение инициатору «прогон завершён».
-- БД: monolitika (systemDb). Накат — под monolitik; гранты роли приложения — по образцу 274
-- (копируем с repeat_kanban_events). Идемпотентна. На прод — только владелец.
-- Откат: DROP TABLE dismissal_items, dismissal_runs; DELETE FROM bot_channels WHERE key = 'dismissal';

CREATE TABLE IF NOT EXISTS dismissal_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_bitrix_id      bigint NOT NULL,
  source                jsonb NOT NULL,                 -- DismissalUser на момент создания
  status                text NOT NULL DEFAULT 'scanning'
                        CHECK (status IN ('scanning', 'draft', 'queued', 'running', 'paused', 'done', 'failed', 'cancelled')),
  plan                  jsonb NOT NULL DEFAULT '{"rules": {}, "overrides": {}}',
  created_by            text,                           -- login инициатора
  created_by_name       text NOT NULL DEFAULT '',
  created_by_bitrix_id  bigint,                         -- кому бот напишет «готово» (нет — не пишем)
  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  finished_at           timestamptz,
  error                 text,
  -- Воркер: кто держит прогон и когда последний раз отметился. Протухший heartbeat (рестарт/деплой) —
  -- прогон подхватывается заново и продолжает с первой pending-строки.
  locked_by             text,
  heartbeat_at          timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dismissal_runs_created_idx ON dismissal_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS dismissal_runs_active_idx ON dismissal_runs (status) WHERE status IN ('scanning', 'queued', 'running');

CREATE TABLE IF NOT EXISTS dismissal_items (
  run_id     uuid NOT NULL REFERENCES dismissal_runs(id) ON DELETE CASCADE,
  key        text NOT NULL,                             -- `${kind}:${entityId}`
  kind       text NOT NULL,
  ord        int NOT NULL DEFAULT 0,                    -- порядок внутри вида (как нашли) — для «по кругу» и исполнения
  entity_id  bigint NOT NULL,
  title      text NOT NULL DEFAULT '',
  url        text,
  subtitle   text,
  meta       jsonb NOT NULL DEFAULT '{}',              -- служебное со сканирования (роль в задаче, тип дела, owner и т.п.)
  action     text CHECK (action IS NULL OR action IN ('transfer', 'close', 'remove', 'skip')),
  target     bigint,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'error')),
  detail     text,
  attempts   int NOT NULL DEFAULT 0,
  done_at    timestamptz,
  PRIMARY KEY (run_id, key)
);
CREATE INDEX IF NOT EXISTS dismissal_items_pending_idx ON dismissal_items (run_id, ord) WHERE status = 'pending';

INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config) VALUES
  ('dismissal', 'Увольнятор: прогон завершён',
   'Инициатору прогона «Увольнятора» — итог: сколько передано, пропущено и с ошибкой, ссылка на прогон.',
   'Аналитик', true, 14, 'Служебные', '{}')
ON CONFLICT (key) DO NOTHING;

-- ── Гранты роли приложения (как 274: копируем с repeat_kanban_events) ─────────
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
    FOREACH t IN ARRAY ARRAY['dismissal_runs', 'dismissal_items'] LOOP
      IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      ELSE
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END IF;
    END LOOP;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
