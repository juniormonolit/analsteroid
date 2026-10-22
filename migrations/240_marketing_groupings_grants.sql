-- 240: права на таблицы структуры источников (миграция 239). 239 накатили под суперпользователем
-- контейнера, и роль приложения получила «permission denied» → 500 на /api/marketing/structure
-- и /api/catalog/marketing-sources (выкат 22.10). Выдаём каждой роли, у которой есть права на
-- marketing_sources, те же права на новые таблицы + USAGE/SELECT на их последовательности.
-- БД: system. Идемпотентна.

DO $$
DECLARE
  r record;
  t text;
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs FROM (
      SELECT grantee::text, privilege_type::text
        FROM information_schema.role_table_grants
       WHERE table_name = 'marketing_sources' AND table_schema = current_schema()
      UNION ALL
      -- Владелец marketing_sources (если приложение ходит под ним, грантов в списке выше нет).
      SELECT tableowner::text, 'OWNER' FROM pg_tables
       WHERE tablename = 'marketing_sources' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    -- Запись — только ролям, которые уже писали в marketing_sources (приложение); read-only
    -- роли (sanya_ro) получают только чтение. Первая версия выдавала запись всем — см. 241.
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      FOREACH t IN ARRAY ARRAY['marketing_groupings', 'marketing_groups', 'marketing_source_groups'] LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      END LOOP;
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE marketing_groupings_id_seq, marketing_groups_id_seq TO %I', r.grantee);
    ELSE
      FOREACH t IN ARRAY ARRAY['marketing_groupings', 'marketing_groups', 'marketing_source_groups'] LOOP
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END LOOP;
    END IF;
    RAISE NOTICE 'grants → % (было на marketing_sources: %)', r.grantee, r.privs;
  END LOOP;
END $$;
