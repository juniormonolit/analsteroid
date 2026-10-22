-- 247: ИИ-анализ звонков заказчика (BACKLOG «ИИ-анализ звонков заказчика», этап 1; решения владельца
-- 22.10). РОП в карточке клиента жмёт «Запустить анализ» → строка queued → воркер в процессе
-- приложения (instrumentation.ts) собирает звонки, обезличивает, спрашивает модель Cloud.ru и
-- кладёт отчёт сюда же. Таблица — одновременно очередь (status) и хранилище отчётов:
--   * анализ длится ~1 мин (reasoning_effort low), но деплой убивает процесс посреди работы —
--     при старте running → queued (attempts+1), после 2 попыток — error;
--   * дедуп: те же звонки + та же версия промпта (calls_hash) = тот же отчёт, без нового счёта;
--   * токены и ₽ — для журнала расходов; feedback «полезно/неточно» — чтобы мерить пользу;
--   * task_id/memo_inserted_at — памятка, вставленная в задачу менеджеру (этап 1.5).
-- Оценка менеджера и нарушения — чувствительные данные: читаются только по праву
-- action.ai_call_analysis (lib/auth/perms.ts), created_by — кто запустил.
-- БД: system. Идемпотентна. Откат: DROP TABLE ai_analyses;

CREATE TABLE IF NOT EXISTS ai_analyses (
  id                 bigserial PRIMARY KEY,
  client_ref         text NOT NULL,                 -- c<contact> | k<company> (ClientRef карточки клиента)
  status             text NOT NULL DEFAULT 'queued' -- queued | running | done | error
                     CHECK (status IN ('queued', 'running', 'done', 'error')),
  phase              text,                          -- collecting | thinking | writing — для прогресса
  attempts           int NOT NULL DEFAULT 0,
  heartbeat_at       timestamptz,
  prompt_version     text NOT NULL,
  model              text,
  reasoning_effort   text,
  calls_hash         text,                          -- отпечаток входа (analyze.ts:callsHashOf)
  calls_count        int,                           -- расшифровок в анализе
  calls_total        int,                           -- всех звонков по сделкам заказчика
  report_md          text,
  quotes             jsonb,                         -- verify.ts: [{quote, kind, found, callId, calledAt, score}]
  mask_hits          jsonb,
  input_tokens       int,
  cached_tokens      int,
  output_tokens      int,
  reasoning_tokens   int,
  cost_rub           numeric(10, 2),
  seconds            int,
  error              text,
  feedback           text CHECK (feedback IN ('useful', 'inaccurate')),
  feedback_note      text,
  feedback_by        text,
  feedback_at        timestamptz,
  task_id            bigint,
  memo_inserted_at   timestamptz,
  created_by         text NOT NULL,                 -- login
  created_by_name    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

CREATE INDEX IF NOT EXISTS ai_analyses_client_idx ON ai_analyses (client_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_analyses_queue_idx ON ai_analyses (created_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS ai_analyses_day_idx ON ai_analyses (created_by, created_at);

-- Права роли приложения — как у user_sessions (миграции через docker exec идут суперюзером,
-- без GRANT новая таблица отдаёт 500; см. 246_mcp.sql).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs FROM (
      SELECT grantee::text, privilege_type::text
        FROM information_schema.role_table_grants
       WHERE table_name = 'user_sessions' AND table_schema = current_schema()
      UNION ALL
      SELECT tableowner::text, 'OWNER' FROM pg_tables WHERE tablename = 'user_sessions' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ai_analyses TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE ai_analyses_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON ai_analyses TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на user_sessions: %)', r.grantee, r.privs;
  END LOOP;
END $$;
