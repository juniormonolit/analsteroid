-- 252: проверка звонка по закрытой задаче (план повторки, решение владельца 23.10: «НЕ автоматически — владелец
-- контролирует бюджет; пометка „есть звонок — проверить“ и запуск вручную»). Та же очередь ai_analyses:
--   kind = 'client' — разбор всех звонков заказчика (как было), 'task_check' — проверка звонков ПОСЛЕ постановки
--   задачи на соответствие её тексту; check_task_id — какая задача Битрикса проверялась (task_id занят памяткой).
-- Вкладка заказчика, сводка по менеджерам, дедуп и «просил сам» читают только kind = 'client'.
-- БД: system. Идемпотентна. Откат: ALTER TABLE ai_analyses DROP COLUMN kind, DROP COLUMN check_task_id;

ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'client';
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS check_task_id bigint;
DO $$ BEGIN
  ALTER TABLE ai_analyses ADD CONSTRAINT ai_analyses_kind_chk CHECK (kind IN ('client', 'task_check'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS ai_analyses_check_task_idx ON ai_analyses (check_task_id, created_at DESC) WHERE kind = 'task_check';
