-- 277: Задачник — оценка эффективности обучений (TASKER_SPEC.md «Обучения → Эффективность», 23.11).
-- Пример владельца: «Будковский провёл 10 менеджерам обучение по первичным продажам; связанные показатели
-- в течение следующих двух недель выросли у 8 из 10».
--  1) событие: привязанные показатели (tasker_metrics) + окно замера «до/после» (по умолчанию 14/14 дней);
--  2) запись: цель (показатели + «зачем отправили»), снимок задачи, если записали из неё; журнал записей/отписок;
--  3) посещаемость: тренер отмечает «был / не был» (NULL — не отмечено, в оценку не идёт);
--  4) результаты замера: по посетившему × показателю — значение до/после и изменение отдела за те же окна,
--     вердикт по логике автозамера ядра (features/tasker/engine/measure.ts → verdictOf).
-- БД: monolitika (systemDb). Накат — под monolitik; гранты роли приложения — по образцу 272/275. Идемпотентна.
-- Откат: DROP TABLE tasker_training_results, tasker_training_enrollment_log;
--        ALTER TABLE tasker_training_events DROP COLUMN metric_ids, DROP COLUMN measure_before_days, DROP COLUMN measure_after_days;
--        ALTER TABLE tasker_training_enrollments DROP COLUMN goal_metric_ids, goal_note, task_metric_id, task_snapshot,
--          attended, attendance_marked_by, attendance_marked_at;

ALTER TABLE tasker_training_events
  ADD COLUMN IF NOT EXISTS metric_ids          text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS measure_before_days integer NOT NULL DEFAULT 14 CHECK (measure_before_days BETWEEN 7 AND 90),
  ADD COLUMN IF NOT EXISTS measure_after_days  integer NOT NULL DEFAULT 14 CHECK (measure_after_days BETWEEN 7 AND 90);

ALTER TABLE tasker_training_enrollments
  ADD COLUMN IF NOT EXISTS goal_metric_ids      text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS goal_note            text,
  ADD COLUMN IF NOT EXISTS task_metric_id       text,    -- метрика задачи, из которой записали
  ADD COLUMN IF NOT EXISTS task_snapshot        jsonb,   -- её снимок на момент постановки
  ADD COLUMN IF NOT EXISTS attended             boolean, -- NULL = посещение не отмечено
  ADD COLUMN IF NOT EXISTS attendance_marked_by uuid,
  ADD COLUMN IF NOT EXISTS attendance_marked_at timestamptz;
-- задача → запись: досинхронизация «записать из формы задачи» ищет задачи без записи
CREATE INDEX IF NOT EXISTS tasker_training_enrollments_task_idx ON tasker_training_enrollments (tasker_task_id) WHERE tasker_task_id IS NOT NULL;

-- Журнал: enroll | unenroll | goal | attended | absent | attendance_cleared | enroll_failed (из задачи, напр. нет мест)
CREATE TABLE IF NOT EXISTS tasker_training_enrollment_log (
  id                     bigserial PRIMARY KEY,
  event_id               bigint NOT NULL REFERENCES tasker_training_events(id) ON DELETE CASCADE,
  manager_bitrix_user_id text NOT NULL,
  action                 text NOT NULL,
  actor_user_id          uuid,
  tasker_task_id         bigint,
  details                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasker_training_enrollment_log_mgr_idx ON tasker_training_enrollment_log (manager_bitrix_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasker_training_enrollment_log_event_idx ON tasker_training_enrollment_log (event_id, created_at DESC);
-- одна попытка записи из задачи (чтобы «нет мест» не писалось в журнал каждую минуту)
CREATE UNIQUE INDEX IF NOT EXISTS tasker_training_enrollment_log_task_once_idx
  ON tasker_training_enrollment_log (tasker_task_id, action) WHERE tasker_task_id IS NOT NULL AND action = 'enroll_failed';

CREATE TABLE IF NOT EXISTS tasker_training_results (
  id                     bigserial PRIMARY KEY,
  event_id               bigint NOT NULL REFERENCES tasker_training_events(id) ON DELETE CASCADE,
  manager_bitrix_user_id text NOT NULL,
  metric_id              text NOT NULL,
  before_from            date NOT NULL,
  before_to              date NOT NULL,
  after_from             date NOT NULL,
  after_to               date NOT NULL,
  value_before           numeric,
  value_after            numeric,
  dept_before            numeric,
  dept_after             numeric,
  dept_name              text,
  enough_before          boolean,
  enough_after           boolean,
  -- achieved | improved | no_change | not_enough_data (как tasker_tasks.verdict); NULL — замер не удался, повтор
  verdict                text CHECK (verdict IS NULL OR verdict IN ('achieved', 'improved', 'no_change', 'not_enough_data')),
  attempts               integer NOT NULL DEFAULT 0,
  error                  text,
  measured_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, manager_bitrix_user_id, metric_id)
);
CREATE INDEX IF NOT EXISTS tasker_training_results_mgr_idx ON tasker_training_results (manager_bitrix_user_id);

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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tasker_training_enrollment_log, tasker_training_results TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tasker_training_enrollment_log_id_seq, tasker_training_results_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON tasker_training_enrollment_log, tasker_training_results TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
