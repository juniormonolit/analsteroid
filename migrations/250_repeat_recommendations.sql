-- 250: журнал рекомендаций канбана повторных — сырьё для самообучения (владелец 23.10: «любые системы строим
-- как „самообучающиеся“ — механизмы полуавтоматической проверки, контроля и выводов»).
-- При каждой постановке задачи из канбана (кнопка, массово, очередь) пишем топ-5 «что можно предложить»
-- (engine/potentialGroups.ts) с источником и отметкой, есть ли группа в тексте задачи (in_text — оставил ли её
-- РОП). Исход НЕ хранится: «отгрузили ли рекомендованную группу за N дней» считается запросом по sa.deals от
-- created_at — так конверсию по паре «отгружено X → предложено Y» и по источнику можно пересчитать за любое окно
-- и после правки правил. Отсюда — калибровка приоритетов /cross-sell полуавтоматом.
-- БД: system. Идемпотентна. Откат: DROP TABLE repeat_recommendations;

CREATE TABLE IF NOT EXISTS repeat_recommendations (
  id            bigserial PRIMARY KEY,
  task_id       bigint,
  deal_id       bigint,
  client_key    text NOT NULL,
  manager_id    text,
  group_name    text NOT NULL,
  rank          smallint NOT NULL,               -- место в топ-5 (1 — первое)
  source        text NOT NULL,                   -- request | priority | chain | history
  from_group    text,                            -- после какой отгруженной группы
  in_text       boolean NOT NULL DEFAULT false,  -- группа упомянута в тексте задачи
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS repeat_recommendations_client_idx ON repeat_recommendations (client_key, created_at DESC);
CREATE INDEX IF NOT EXISTS repeat_recommendations_pair_idx ON repeat_recommendations (from_group, group_name);

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
      EXECUTE format('GRANT SELECT, INSERT ON repeat_recommendations TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE repeat_recommendations_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON repeat_recommendations TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
