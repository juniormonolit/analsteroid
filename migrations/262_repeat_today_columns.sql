-- 262: «Свои колонки» во вкладке «Сегодня» канбана повторных (владелец 10.11; проект — Fable). РОП проверяет гипотезу
-- («LTV > 2 млн, от 2 отгрузок, сделка в работе — под пристальным вниманием»): колонка = сохранённый набор условий
-- (filters jsonb — ключи как URL-параметры доски), опциональная «тревога» (alert jsonb), личная или общая (shared).
-- Лимит 5 своих — в коде. Плюс одна общая колонка-пример (is_example) «Золотые рыбки в работе». members — история членства (для метрики «дошли до отгрузки за 30 дней против остальных»):
-- заказчик выпадает из колонки, когда отгрузился, поэтому без истории метрику не посчитать.
-- БД: monolitika (systemDb). Накат — под monolitik; гранты роли приложения — по образцу 257/261.
-- Откат: DROP TABLE repeat_today_column_members, repeat_today_columns;
CREATE TABLE IF NOT EXISTS repeat_today_columns (
  id             bigserial PRIMARY KEY,
  owner_user_id  text NOT NULL,                  -- users.id
  owner_name     text,
  name           text NOT NULL,
  shared         boolean NOT NULL DEFAULT false, -- «Показать всем РОПам»
  filters        jsonb NOT NULL DEFAULT '{}'::jsonb,
  alert          jsonb,                          -- { noCallDays?, overdue?, noTask? }
  position       int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  -- Общая колонка-пример (владелец 10.11: «редактируемый пример для всех, выдели визуально»): видна всем, править может
  -- РОП и выше, удалить нельзя; в лимит 5 своих не входит. Владелец — 'system'.
  is_example     boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS repeat_today_columns_owner_idx ON repeat_today_columns (owner_user_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS repeat_today_column_members (
  column_id   bigint NOT NULL REFERENCES repeat_today_columns(id) ON DELETE CASCADE,
  client_key  text NOT NULL,
  first_seen  date NOT NULL,
  last_seen   date NOT NULL,
  PRIMARY KEY (column_id, client_key)
);

-- Пример: гипотеза владельца — «LTV > 2 млн, от 2 отгрузок, сделка в рабочей стадии (дозвон/воронка)»; тревога для
-- наглядности — нет звонка 3 дня или задача просрочена.
INSERT INTO repeat_today_columns (owner_user_id, owner_name, name, shared, filters, alert, position, is_example)
SELECT 'system', 'Пример', 'Золотые рыбки в работе', true,
       '{"ltvMin": 2000000, "ships": ["2", "3", "4-5", "6-9", "10+"], "stage": ["g:touch", "g:stage"]}'::jsonb,
       '{"noCallDays": 3, "overdue": true}'::jsonb, 0, true
 WHERE NOT EXISTS (SELECT 1 FROM repeat_today_columns WHERE is_example);

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
    FOREACH t IN ARRAY ARRAY['repeat_today_columns', 'repeat_today_column_members'] LOOP
      IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      ELSE
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END IF;
    END LOOP;
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE repeat_today_columns_id_seq TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
