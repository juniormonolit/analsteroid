-- 248: ИИ-анализ звонков, этап 2 (BACKLOG «ИИ-анализ звонков заказчика»; решение владельца 22.10:
-- «промпт правят только админы», редактор с тест-прогоном — этап 2).
--   ai_prompts — версии системного промпта из редактора /settings/ai-analysis. Активна одна
--     (is_active); нет активной — работает встроенный промпт из кода (prompt.ts, версия vN).
--     Версия в отчёте — «db<id>»: старые и новые оценки по разным версиям не сравниваем.
--   ai_analyses.is_test / prompt_body — тест-прогон черновика промпта на заказчике: идёт той же
--     очередью, но не попадает во вкладку клиента, сводку и дедуп.
--   ai_analyses.parsed / main_manager / score — отчёт, разобранный кодом (engine/parse.ts): вердикты
--     по 8 критериям, нарушения, тип заказчика — для сводки по менеджерам и автозаполнения типа.
-- БД: system. Идемпотентна. Откат: DROP TABLE ai_prompts; ALTER TABLE ai_analyses DROP COLUMN is_test,
-- DROP COLUMN prompt_body, DROP COLUMN parsed, DROP COLUMN main_manager, DROP COLUMN score;

CREATE TABLE IF NOT EXISTS ai_prompts (
  id          serial PRIMARY KEY,
  body        text NOT NULL,
  note        text,
  is_active   boolean NOT NULL DEFAULT false,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_prompts_one_active ON ai_prompts ((true)) WHERE is_active;

ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS prompt_body text;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS parsed jsonb;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS main_manager text;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS score numeric(4, 2);
CREATE INDEX IF NOT EXISTS ai_analyses_manager_idx ON ai_analyses (main_manager, created_at DESC) WHERE status = 'done' AND NOT is_test;

-- Права роли приложения — как у user_sessions (см. 247).
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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ai_prompts TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE ai_prompts_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON ai_prompts TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на user_sessions: %)', r.grantee, r.privs;
  END LOOP;
END $$;
