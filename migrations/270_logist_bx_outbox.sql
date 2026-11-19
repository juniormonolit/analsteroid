-- 270: «Канбан запросов логистам», S4 — очередь записи в Битрикс (дубль-задача, комментарии).
-- Действие в Монолитике коммитится сразу; хук afterLogistChange кладёт сюда операции, синк
-- (features/logist-kanban/engine/bitrix/sync.ts) выполняет их по порядку внутри запроса, с ретраем и бэкоффом.
-- Сбой операции → logist_requests.bx_sync_status = 'error' + bx_sync_error (видно в карточке), следующие
-- операции того же запроса ждут (порядок в задаче не ломается). Спека — LOGIST_REQUESTS_SPEC.md, «Дублирование».
-- БД: monolitika (systemDb), накат под monolitik; гранты — по образцу 267. Идемпотентна.
-- Откат: DROP TABLE logist_bx_outbox;

CREATE TABLE IF NOT EXISTS logist_bx_outbox (
  id            bigserial PRIMARY KEY,
  request_id    bigint NOT NULL REFERENCES logist_requests(id) ON DELETE CASCADE,
  -- create_task | take | release | transfer | reassign | answer | withdraw_offer | return | accept | cancel | add_items | message
  op            text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ok', 'error', 'skipped')),
  attempts      int NOT NULL DEFAULT 0,
  next_at       timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  -- ответ Битрикса (id задачи / комментария), для разбора
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz
);
CREATE INDEX IF NOT EXISTS logist_bx_outbox_req_idx  ON logist_bx_outbox (request_id, id);
CREATE INDEX IF NOT EXISTS logist_bx_outbox_todo_idx ON logist_bx_outbox (next_at) WHERE status IN ('pending', 'error', 'running');

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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON logist_bx_outbox TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE logist_bx_outbox_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON logist_bx_outbox TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
