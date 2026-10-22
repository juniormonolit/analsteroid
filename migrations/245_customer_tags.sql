-- 245: теги заказчиков (владелец 22.10, правка №3 по канбану повторных): «неудаляемые теги по
-- умолчанию (базовый набор а-ля „Особое внимание“, штучки 3–4) для всех и кастомные для каждого
-- аккаунта. Чтобы можно было выбрать цвет». Фильтр, сортировка и поиск по тегам — в канбане.
--   customer_tag_defs — словарь: owner_user_id IS NULL — базовые (видят все, удалить нельзя);
--                       иначе — личные теги аккаунта (users.id), видит и ставит только владелец.
--   customer_tags     — тег на заказчике (client_key). Удаление личного тега — archived_at (метки
--                       остаются в базе, но не показываются).
-- color — ключ колонки «Основной палитры» (red, orange, yellow, green, cyan, cornflower, blue,
-- purple, magenta, gray); оттенки фона/текста — в коде.
-- БД: system. Идемпотентна. Откат: DROP TABLE customer_tags; DROP TABLE customer_tag_defs;

CREATE TABLE IF NOT EXISTS customer_tag_defs (
  id             serial PRIMARY KEY,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color          text NOT NULL DEFAULT 'gray',
  owner_user_id  text,
  position       int  NOT NULL DEFAULT 100,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_tag_defs_name_uq
  ON customer_tag_defs (coalesce(owner_user_id, ''), lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_tags (
  client_key          text NOT NULL,
  tag_id              int  NOT NULL REFERENCES customer_tag_defs (id) ON DELETE CASCADE,
  created_by          text,
  created_by_user_id  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_key, tag_id)
);
CREATE INDEX IF NOT EXISTS customer_tags_tag_idx ON customer_tags (tag_id);

-- Базовый набор (один раз).
INSERT INTO customer_tag_defs (name, color, owner_user_id, position)
SELECT v.name, v.color, NULL, v.position
  FROM (VALUES ('Особое внимание', 'red', 1), ('Ключевой клиент', 'yellow', 2),
               ('Сезонная стройка', 'cyan', 3), ('Ждёт предложения', 'cornflower', 4)) AS v(name, color, position)
 WHERE NOT EXISTS (SELECT 1 FROM customer_tag_defs WHERE owner_user_id IS NULL);

-- Права — как у customer_marks (урок 239/240: миграция идёт под суперпользователем контейнера).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs FROM (
      SELECT grantee::text, privilege_type::text FROM information_schema.role_table_grants
       WHERE table_name = 'customer_marks' AND table_schema = current_schema()
      UNION ALL
      SELECT tableowner::text, 'OWNER' FROM pg_tables WHERE tablename = 'customer_marks' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON customer_tag_defs, customer_tags TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE customer_tag_defs_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON customer_tag_defs, customer_tags TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на customer_marks: %)', r.grantee, r.privs;
  END LOOP;
END $$;
