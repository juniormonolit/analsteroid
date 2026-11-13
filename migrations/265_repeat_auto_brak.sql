-- 265: «Фильтр на колонке с автобраком» канбана повторных (владелец, собрание 12.11 п. 4+7, ответы 13.11).
-- РОП открывает настройки колонки, задаёт фильтр, видит «сколько останется / сколько уйдёт в брак» (заказчики, LTV),
-- жмёт «Применить» (брак — как «Сразу в брак»: отметка + закрыть открытую повторную сделку в отказ по причине правила
-- + закрыть открытые задачи) и ставит галку «Применять автоматически» (будни 8:00 МСК). Кандидаты при включённом авто
-- скрыты с доски (режим «Показывать автобрак» — показывает). Журнал партий и откат партии (только снять брак).
--   repeat_brak_rules  — правило на колонку у РОПа: mode 'brak' (фильтр выбирает, кто уходит) | 'keep' (кто остаётся);
--                        filters — как у своих колонок (customColumns.cleanFilters); reason — причина брака (BRAK_REASONS).
--   repeat_brak_batches / repeat_brak_batch_items — партии автобрака и заказчики в них (для журнала и отката).
-- БД: monolitika. Накат — под monolitik; гранты роли приложения — по образцу 257/261/262.
-- Откат: DROP TABLE repeat_brak_batch_items, repeat_brak_batches, repeat_brak_rules;
CREATE TABLE IF NOT EXISTS repeat_brak_rules (
  id              bigserial PRIMARY KEY,
  owner_user_id   text NOT NULL,
  owner_name      text,
  column_key      text NOT NULL,
  mode            text NOT NULL DEFAULT 'brak' CHECK (mode IN ('brak', 'keep')),
  filters         jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason          text NOT NULL,
  comment         text,
  auto            boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS repeat_brak_rules_owner_col_uq ON repeat_brak_rules (owner_user_id, column_key) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS repeat_brak_batches (
  id              bigserial PRIMARY KEY,
  rule_id         bigint REFERENCES repeat_brak_rules(id),
  column_key      text NOT NULL,
  mode            text NOT NULL,
  filters         jsonb NOT NULL,
  reason          text NOT NULL,
  auto            boolean NOT NULL DEFAULT false,
  run_by          text NOT NULL,             -- users.id
  run_by_name     text,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  total           int NOT NULL DEFAULT 0,
  done            int NOT NULL DEFAULT 0,
  failed          int NOT NULL DEFAULT 0,
  ltv             numeric NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  reverted_at     timestamptz,
  reverted_by     text
);
CREATE INDEX IF NOT EXISTS repeat_brak_batches_rule_idx ON repeat_brak_batches (rule_id, started_at DESC);

CREATE TABLE IF NOT EXISTS repeat_brak_batch_items (
  batch_id        bigint NOT NULL REFERENCES repeat_brak_batches(id) ON DELETE CASCADE,
  client_key      text NOT NULL,
  manager_id      text,
  name            text,
  ltv             numeric,
  deal_id         bigint,
  ok              boolean,
  deal_closed     text,
  tasks_closed    int,
  error           text,
  PRIMARY KEY (batch_id, client_key)
);

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
    FOREACH t IN ARRAY ARRAY['repeat_brak_rules', 'repeat_brak_batches', 'repeat_brak_batch_items'] LOOP
      IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      ELSE
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END IF;
    END LOOP;
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE repeat_brak_rules_id_seq TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE repeat_brak_batches_id_seq TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
