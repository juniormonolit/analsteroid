-- 279: «Задачник» — правки с собрания пользователей 23.11 (ai_docs/fresh_docs/TASKER_FEEDBACK_2026-11-23.md, п.1, 2, 5, 10).
-- 1) Исполнитель задачи (= RESPONSIBLE_ID) — РОП/постановщик («practice») или тренер («theory»), не менеджер:
--    executor_bitrix_id/executor_name + kind. Старые задачи: исполнителем в Битриксе был менеджер — так и
--    переносим (executor = manager, kind = 'practice'). training_event_id — уже есть с 274, здесь не трогаем.
-- 1) Наблюдатели задачи (AUDITORS Битрикса) — auditor_ids: видят задачу в Задачнике.
-- 2) Без «Ждёт контроля» (TASK_CONTROL='N'): завершение — с обязательным «Что сделано» (done_note).
-- 10) Событие календаря исполнителя для задачи со слотом без сессии (менеджер — участник).
-- 5) Окно замера по умолчанию — 7 дней (у обучений «до/после» тоже 7/7).
-- Тренер по умолчанию — tasker_settings.trainer = 2054 (Будковский).
-- БД: monolitika (systemDb). Новых таблиц нет — гранты 274/277 покрывают. Идемпотентна.
-- Откат: ALTER TABLE tasker_tasks DROP COLUMN kind, executor_bitrix_id, executor_name, auditor_ids, done_note, done_at,
--        done_by, calendar_event_id, calendar_owner_id; DELETE FROM tasker_settings WHERE key = 'trainer';
--        ALTER TABLE tasker_training_events ALTER measure_before_days SET DEFAULT 14, ALTER measure_after_days SET DEFAULT 14;

ALTER TABLE tasker_tasks
  ADD COLUMN IF NOT EXISTS kind               text NOT NULL DEFAULT 'practice' CHECK (kind IN ('theory', 'practice')),
  ADD COLUMN IF NOT EXISTS executor_bitrix_id text,
  ADD COLUMN IF NOT EXISTS executor_name      text,
  ADD COLUMN IF NOT EXISTS auditor_ids        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS done_note          text,
  ADD COLUMN IF NOT EXISTS done_at            timestamptz,
  ADD COLUMN IF NOT EXISTS done_by            text,
  ADD COLUMN IF NOT EXISTS calendar_event_id  bigint,
  ADD COLUMN IF NOT EXISTS calendar_owner_id  text;

UPDATE tasker_tasks SET executor_bitrix_id = manager_bitrix_id, executor_name = manager_name WHERE executor_bitrix_id IS NULL;
UPDATE tasker_tasks
   SET auditor_ids = ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[director_bitrix_id]) x WHERE x IS NOT NULL)
 WHERE auditor_ids = '{}' AND director_bitrix_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasker_tasks_executor_idx ON tasker_tasks (executor_bitrix_id);
CREATE INDEX IF NOT EXISTS tasker_tasks_auditors_idx ON tasker_tasks USING gin (auditor_ids);

INSERT INTO tasker_settings (key, value) VALUES ('trainer', '"2054"'::jsonb) ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  IF to_regclass('tasker_training_events') IS NOT NULL THEN
    ALTER TABLE tasker_training_events ALTER COLUMN measure_before_days SET DEFAULT 7, ALTER COLUMN measure_after_days SET DEFAULT 7;
  END IF;
END $$;
