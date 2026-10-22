-- 244: анкеты по товарным группам (владелец 22.10, правка №10 по канбану повторных: «для каждой
-- товарной группы — своего рода анкета/форма кастомная»). Редактор — «Ещё» → «Что предложить»,
-- вкладка «Анкеты». Ответы менеджеров (бриф в карточке клиента → комментарий в сделку) — отдельной
-- задачей, поэтому вопросы НЕ удаляются, а архивируются (archived_at): на них будут ссылаться ответы.
-- group_name — head-группа (как в cross_sell_priorities); '*' — общие вопросы для любого заказчика.
-- kind: text — свободный ответ; single — один вариант; multi — несколько вариантов (options).
-- БД: system. Идемпотентна. Откат: DROP TABLE group_questions;

CREATE TABLE IF NOT EXISTS group_questions (
  id           serial PRIMARY KEY,
  group_name   text NOT NULL,
  position     int  NOT NULL DEFAULT 0,
  question     text NOT NULL CHECK (length(question) BETWEEN 1 AND 500),
  hint         text,
  kind         text NOT NULL CHECK (kind IN ('text', 'single', 'multi')),
  options      text[] NOT NULL DEFAULT '{}',
  required     boolean NOT NULL DEFAULT false,
  archived_at  timestamptz,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_questions_choice_needs_options CHECK (kind = 'text' OR cardinality(options) >= 2)
);
CREATE INDEX IF NOT EXISTS group_questions_group_idx ON group_questions (group_name, position) WHERE archived_at IS NULL;

-- Права — как у cross_sell_priorities (урок 239/240: миграция идёт под суперпользователем контейнера).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs FROM (
      SELECT grantee::text, privilege_type::text FROM information_schema.role_table_grants
       WHERE table_name = 'cross_sell_priorities' AND table_schema = current_schema()
      UNION ALL
      SELECT tableowner::text, 'OWNER' FROM pg_tables WHERE tablename = 'cross_sell_priorities' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON group_questions TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE group_questions_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON group_questions TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на cross_sell_priorities: %)', r.grantee, r.privs;
  END LOOP;
END $$;
