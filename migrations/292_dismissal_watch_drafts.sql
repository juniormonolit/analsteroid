-- 292: «Сторож увольнений» v5 (владелец 24.11): эскалация по ЛЮБОМУ черновику Увольнятора, удаление черновика = отмена.
--   dismissal_watch_cases: кейс = прогон (unique run_id); чатовые поля необязательны (ручной черновик — без сообщения);
--     origin 'chat' | 'manual'; resolution 'started' | 'cancelled' (NULL — открыт); cancelled_by — кто удалил черновик.
--   dismissal_runs: cancelled_by / cancelled_by_name / cancelled_at — кто отменил (команда cancel из сессии).
-- БД: monolitika (systemDb), накат — под monolitik. Идемпотентна. Новых таблиц нет — гранты из 287/291 действуют.
-- Откат: DROP COLUMN origin/resolution/cancelled_by (+ у runs), DROP INDEX dismissal_watch_cases_run_uniq,
--        вернуть NOT NULL (если нет ручных кейсов).

ALTER TABLE dismissal_watch_cases ALTER COLUMN chat_id      DROP NOT NULL;
ALTER TABLE dismissal_watch_cases ALTER COLUMN message_id   DROP NOT NULL;
ALTER TABLE dismissal_watch_cases ALTER COLUMN message_text DROP NOT NULL;
ALTER TABLE dismissal_watch_cases ALTER COLUMN line         DROP NOT NULL;
-- UNIQUE (message_id, source_bitrix_id) остаётся: для ручных message_id NULL — ограничение их не касается.

ALTER TABLE dismissal_watch_cases ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'chat';
ALTER TABLE dismissal_watch_cases ADD COLUMN IF NOT EXISTS resolution text;
ALTER TABLE dismissal_watch_cases ADD COLUMN IF NOT EXISTS cancelled_by text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_watch_cases_origin_check') THEN
    ALTER TABLE dismissal_watch_cases ADD CONSTRAINT dismissal_watch_cases_origin_check CHECK (origin IN ('chat', 'manual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_watch_cases_resolution_check') THEN
    ALTER TABLE dismissal_watch_cases ADD CONSTRAINT dismissal_watch_cases_resolution_check CHECK (resolution IS NULL OR resolution IN ('started', 'cancelled'));
  END IF;
END $$;
UPDATE dismissal_watch_cases SET resolution = 'started' WHERE resolved_at IS NOT NULL AND resolution IS NULL;

-- Кейс = прогон. v4 мог привязать к одному прогону два кейса (повторное объявление после запуска) — оставляем
-- самый свежий, у прочих отвязываем run_id (resolved_run_id и история остаются).
UPDATE dismissal_watch_cases c SET run_id = NULL
 WHERE run_id IS NOT NULL AND EXISTS (SELECT 1 FROM dismissal_watch_cases d WHERE d.run_id = c.run_id AND d.id > c.id);
CREATE UNIQUE INDEX IF NOT EXISTS dismissal_watch_cases_run_uniq ON dismissal_watch_cases (run_id) WHERE run_id IS NOT NULL;

ALTER TABLE dismissal_runs ADD COLUMN IF NOT EXISTS cancelled_by text;
ALTER TABLE dismissal_runs ADD COLUMN IF NOT EXISTS cancelled_by_name text;
ALTER TABLE dismissal_runs ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
