-- 261: «Канбан логиста» (владелец 09.11) — прототип. Логист фильтрует заявки 1С (sd.requests:
-- филиал, сумма заявки от N, статусы 1С, товар/группа), берёт перспективную в проработку
-- («можно ли сделать дешевле, чем уже продал менеджер») и ставит итог.
-- Колонки: «Можно попробовать» (строки здесь нет) → «В работе» → «Успешно» / «Не вышло».
-- Ключ карточки — номер заявки + покупатель (как дедуп в lib/realizations/sql.ts: id копии
-- заявки в sd меняется при перевыгрузке, ключ «номер + buyer_id» — нет).
-- БД: monolitika (systemDb). Накат — под monolitik; гранты роли приложения — по образцу 257.
-- Откат: DROP TABLE logist_kanban_cards;
--        UPDATE roles SET permissions = array_remove(permissions, 'section.logist_kanban');

CREATE TABLE IF NOT EXISTS logist_kanban_cards (
  request_key   text PRIMARY KEY,                -- '<номер>|<buyer_id>'
  request_id    text,                            -- id последней копии в sd на момент действия
  status        text NOT NULL CHECK (status IN ('in_work', 'success', 'fail')),
  note          text,
  owner_login   text NOT NULL,                   -- кто взял в работу
  owner_name    text,
  updated_by    text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS logist_kanban_cards_status_idx ON logist_kanban_cards (status, updated_at DESC);

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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON logist_kanban_cards TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON logist_kanban_cards TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;

-- Право раздела — роли «Логист». Админ/супер-админ видят пункт «Ещё» и так.
UPDATE roles
   SET permissions = (SELECT ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['section.logist_kanban'])))
 WHERE name = 'Логист'
   AND NOT (permissions @> ARRAY['section.logist_kanban']);

SELECT name, permissions FROM roles WHERE name = 'Логист';
