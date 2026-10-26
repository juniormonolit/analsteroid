-- 257: «Запросить разбор» (владелец 26.10). Менеджер в карточке клиента просит ИИ-разбор звонков, если разбора не было
-- или после него появились разговоры. Запрос активен, пока по client_ref нет готового разбора НОВЕЕ запроса — статус
-- не храним, он вычисляется (ai_analyses.created_at > requested_at). РОП видит такие карточки в канбане: индикатор на
-- значке ИИ, фильтр «Просят разбор», колонка во вкладке «Сегодня».
-- Откат: DROP TABLE ai_analysis_requests.
CREATE TABLE IF NOT EXISTS ai_analysis_requests (
  id                  bigserial PRIMARY KEY,
  client_ref          text NOT NULL,              -- c<контакт> | k<компания> (как ai_analyses.client_ref)
  comment             text,
  requested_by        text NOT NULL,              -- логин или актор пропуска вкладки Битрикса
  requested_by_name   text,
  requested_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_analysis_requests_ref_idx ON ai_analysis_requests (client_ref, requested_at DESC);

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
      EXECUTE format('GRANT SELECT, INSERT, DELETE ON ai_analysis_requests TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE ai_analysis_requests_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON ai_analysis_requests TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
