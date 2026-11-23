-- 280: «Задачник» — конструктор шаблонов рекомендаций (правки собрания 23.11, TASKER_FEEDBACK_2026-11-23 п.4).
-- Руководители сами пишут пошаговые инструкции на каждый показатель: несколько вариантов, ссылки, картинки,
-- сортировка, архив. Таблица tasker_templates (миграция 274) уже умеет «несколько на метрику» (sort_order)
-- и «архив» (active = false) — добавляем только авторство/время и хранилище картинок.
-- Картинки — байтами в БД (как idea_attachments, 101): прод деплоится тарболом, локальный диск не переживает
-- выкатку. Отдаются без сессии по неугадываемому uuid (GET /api/tasker/templates/images/<uuid>) — ссылку
-- открывают из задачи Битрикса, где сессии Монолитики может не быть. Внутри — скриншоты отчётов, без ПДн.
-- БД: monolitika (systemDb). Накат — под monolitik; гранты — копией с repeat_kanban_events (как 274/278). Идемпотентна.
-- Откат: DROP TABLE tasker_template_images; ALTER TABLE tasker_templates DROP COLUMN created_by, DROP COLUMN updated_by,
--        DROP COLUMN updated_at, DROP COLUMN archived_at;

ALTER TABLE tasker_templates
  ADD COLUMN IF NOT EXISTS created_by  text,          -- login автора (NULL — базовые из миграции 274)
  ADD COLUMN IF NOT EXISTS updated_by  text,          -- login последнего правившего
  ADD COLUMN IF NOT EXISTS updated_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;   -- когда убран в архив (active = false)

CREATE TABLE IF NOT EXISTS tasker_template_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename    text NOT NULL,
  mime_type   text NOT NULL,
  byte_size   int NOT NULL,
  data        bytea NOT NULL,
  uploaded_by text NOT NULL,                          -- login загрузившего
  created_at  timestamptz NOT NULL DEFAULT now()
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
    FOREACH t IN ARRAY ARRAY['tasker_templates', 'tasker_template_images'] LOOP
      IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      ELSE
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END IF;
    END LOOP;
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tasker_templates_id_seq TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
