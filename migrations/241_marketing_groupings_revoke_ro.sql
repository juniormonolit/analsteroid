-- 241: откат лишних прав из 240. 240 выдала запись ВСЕМ ролям с доступом к marketing_sources,
-- включая read-only `sanya_ro` (у неё был только SELECT) — она получила INSERT/UPDATE/DELETE на
-- таблицы структуры и INSERT/UPDATE на marketing_sources. Возвращаем ей только чтение.
-- (240 исправлена: запись — только ролям, у которых был INSERT на marketing_sources.)
-- БД: system. Идемпотентна.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sanya_ro') THEN
    REVOKE INSERT, UPDATE, DELETE ON marketing_groupings, marketing_groups, marketing_source_groups FROM sanya_ro;
    REVOKE INSERT, UPDATE ON marketing_sources FROM sanya_ro;
    REVOKE USAGE ON SEQUENCE marketing_groupings_id_seq, marketing_groups_id_seq FROM sanya_ro;
    GRANT SELECT ON marketing_groupings, marketing_groups, marketing_source_groups, marketing_sources TO sanya_ro;
  END IF;
END $$;
