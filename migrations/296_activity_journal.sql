-- 296: «Большой брат», фаза 0, поток A — журнал активности в Монолитике (ТЗ: ai_docs/fresh_docs/BIG_BROTHER_SPEC.md).
--   activity_events  — нормализованный журнал действий в Монолитике: mono_view (раздел), mono_action (мутация в
--                      сервисе), session (вход/выход). Пишется только lib/activity/log.ts::logActivity. TTL 90 дней.
--   activity_minutes — присутствие 5-минутными бакетами (heartbeat Монолитики + производные сигналы адаптеров),
--                      ON CONFLICT DO NOTHING. TTL 90 дней.
--   activity_daily   — дневной агрегат (собирает поток D), бессрочно.
-- Таксономия kind/action/surface — lib/activity/types.ts.
-- БД: monolitika (systemDb), накат — под monolitik. Идемпотентна.
-- Откат: DROP TABLE activity_daily, activity_minutes, activity_events;

CREATE TABLE IF NOT EXISTS activity_events (
  id             bigserial PRIMARY KEY,
  ts             timestamptz NOT NULL DEFAULT now(),
  user_id        uuid,
  login          text,
  bitrix_user_id text,
  role_name      text,
  surface        text NOT NULL DEFAULT 'server',
  kind           text NOT NULL,
  action         text,
  section        text,
  entity_type    text,
  entity_id      text,
  deal_id        bigint,
  request_id     text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS activity_events_bx_ts_idx   ON activity_events (bitrix_user_id, ts);
CREATE INDEX IF NOT EXISTS activity_events_kind_ts_idx ON activity_events (kind, ts);
CREATE INDEX IF NOT EXISTS activity_events_ts_idx      ON activity_events (ts);  -- TTL-чистка и «сегодня»

CREATE TABLE IF NOT EXISTS activity_minutes (
  bitrix_user_id text NOT NULL,            -- у пользователя без Битрикс-id — 'u:<users.id>'
  bucket         timestamptz NOT NULL,     -- начало 5-минутного окна
  source         text NOT NULL,            -- mono | call | deal | task | kanban | logist
  surface        text NOT NULL DEFAULT '',
  section        text NOT NULL DEFAULT '',
  PRIMARY KEY (bitrix_user_id, bucket, source, surface, section)
);
CREATE INDEX IF NOT EXISTS activity_minutes_bucket_idx ON activity_minutes (bucket);

CREATE TABLE IF NOT EXISTS activity_daily (
  snap_date        date NOT NULL,
  bitrix_user_id   text NOT NULL,
  user_name        text,
  department_id    text,                   -- на дату, из sa.org_resolved_hierarchy
  department_name  text,
  rop_bitrix_id    text,                   -- РОП на дату
  is_workday       boolean,
  in_work          boolean NOT NULL DEFAULT false,
  mono_minutes     int NOT NULL DEFAULT 0, -- активные минуты Монолитики (бакеты × 5)
  first_signal_at  timestamptz,            -- по всем источникам
  last_signal_at   timestamptz,
  counts           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {kind: n} / {kind.action: n}
  sections         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {section: минут} в Монолитике
  surfaces         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {surface: минут}
  tasks_created    int NOT NULL DEFAULT 0,
  tasks_closed     int NOT NULL DEFAULT 0,
  tasks_overdue    int NOT NULL DEFAULT 0,
  built_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snap_date, bitrix_user_id)
);
CREATE INDEX IF NOT EXISTS activity_daily_dept_idx ON activity_daily (department_id, snap_date);
CREATE INDEX IF NOT EXISTS activity_daily_user_idx ON activity_daily (bitrix_user_id, snap_date);

-- ── Гранты роли приложения (как 291/293/294: копируем с repeat_kanban_events) ─────
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
    FOREACH t IN ARRAY ARRAY['activity_events', 'activity_minutes', 'activity_daily'] LOOP
      IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      ELSE
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END IF;
    END LOOP;
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE activity_events_id_seq TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
