-- 275: Задачник — расписание обучений (TASKER_SPEC.md, раздел «Обучения», фаза 1, 23.11).
-- Тренер (право action.tasker.trainings.manage, выдаётся лично) ведёт события; видят все с section.tasker;
-- РОП/директор/админ записывает своих менеджеров (canSeeManager), в том числе из формы задачи (tasker_task_id).
-- Удаление события = отмена (cancelled_at), записи сохраняются для истории.
-- БД: monolitika (systemDb). Накат — под monolitik; гранты роли приложения — по образцу 270/272. Идемпотентна.
-- Фаза 1b — календарь Битрикса (колонки calendar_* ниже).
-- Откат: DROP TABLE tasker_training_enrollments; DROP TABLE tasker_training_events;

CREATE TABLE IF NOT EXISTS tasker_training_events (
  id                      bigserial PRIMARY KEY,
  title                   text NOT NULL,
  description             text NOT NULL DEFAULT '',
  start_at                timestamptz NOT NULL,
  duration_min            integer NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 5 AND 600),
  place                   text,                    -- аудитория или ссылка на видеовстречу
  capacity                integer CHECK (capacity IS NULL OR capacity > 0), -- NULL = без лимита
  trainer_bitrix_user_id  text,                    -- кто проводит (обычно = создатель)
  created_by              uuid,                    -- users.id
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  cancelled_at            timestamptz,
  cancelled_by            uuid
);
CREATE INDEX IF NOT EXISTS tasker_training_events_start_idx ON tasker_training_events (start_at);

-- Фаза 1b (23.11, вебхуку BITRIX_WEBHOOK_URL выдано право calendar): событие = calendar.event.add в календаре
-- тренера, записанные — участники. Ошибка Битрикса не ломает событие в Монолитике: state='failed' + повтор
-- (кнопка тренера и ленивый повтор при чтении расписания). calendar_owner_id — чей календарь (смена тренера = перенос).
ALTER TABLE tasker_training_events
  ADD COLUMN IF NOT EXISTS calendar_event_id      bigint,
  ADD COLUMN IF NOT EXISTS calendar_owner_id      text,
  ADD COLUMN IF NOT EXISTS calendar_sync_state    text NOT NULL DEFAULT 'pending', -- pending | synced | failed
  ADD COLUMN IF NOT EXISTS calendar_sync_error    text,
  ADD COLUMN IF NOT EXISTS calendar_sync_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS calendar_synced_at     timestamptz;
CREATE INDEX IF NOT EXISTS tasker_training_events_calsync_idx ON tasker_training_events (calendar_sync_state)
  WHERE calendar_sync_state <> 'synced';

CREATE TABLE IF NOT EXISTS tasker_training_enrollments (
  id                      bigserial PRIMARY KEY,
  event_id                bigint NOT NULL REFERENCES tasker_training_events(id) ON DELETE CASCADE,
  manager_bitrix_user_id  text NOT NULL,
  enrolled_by             uuid,                    -- users.id того, кто записал (РОП/директор/админ/тренер)
  tasker_task_id          bigint,                  -- задача Задачника, из формы которой записали (без FK: ядро — 274)
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, manager_bitrix_user_id)
);
CREATE INDEX IF NOT EXISTS tasker_training_enrollments_manager_idx ON tasker_training_enrollments (manager_bitrix_user_id);

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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tasker_training_events, tasker_training_enrollments TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tasker_training_events_id_seq, tasker_training_enrollments_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON tasker_training_events, tasker_training_enrollments TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
