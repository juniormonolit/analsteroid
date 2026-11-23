-- 276: «Карта показателей» (задача владельца 23.11) — снимки расчёта карты.
-- Ключ — срез (company | department:<id> | manager:<id> | product_group:<id>) + период + период сравнения;
-- payload — готовый MetricMapResponse (features/metric-map/types.ts). Пишет движок
-- (features/metric-map/engine/service.ts): GET считает и кладёт, кнопка «Пересчитать» и ночная
-- задача metricMapNightly пересчитывают незакрытые периоды.
-- БД: monolitika (systemDb). Накат — под monolitik; гранты роли приложения — по образцу 275. Идемпотентна.
-- Откат: DROP TABLE metric_map_snapshots;

CREATE TABLE IF NOT EXISTS metric_map_snapshots (
  scope_key     text        NOT NULL,
  period_from   date        NOT NULL,
  period_to     date        NOT NULL,
  compare_from  date        NOT NULL,
  compare_to    date        NOT NULL,
  payload       jsonb       NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_key, period_from, period_to, compare_from, compare_to)
);
CREATE INDEX IF NOT EXISTS metric_map_snapshots_period_to_idx ON metric_map_snapshots (period_to);

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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON metric_map_snapshots TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON metric_map_snapshots TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
