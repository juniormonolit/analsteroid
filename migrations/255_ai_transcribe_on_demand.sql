-- 255: расшифровка звонков по кнопке перед ИИ-разбором (владелец 23.10; ТЗ разработчиков транскрибации —
-- n8n webhook transcribe-on-demand). Разбор, у заказчика которого есть звонки без текста, сначала отправляет
-- их на расшифровку и ждёт (до 10 мин) — не занимая воркер: строка остаётся status='queued', phase='transcribing',
-- воркер берёт её снова не раньше wait_until.
--   transcribe — состояние ожидания (engine/transcribe.ts TranscribeState): какие звонки ждём, до когда, итог.
-- БД: system. Идемпотентна. Откат: ALTER TABLE ai_analyses DROP COLUMN transcribe, DROP COLUMN wait_until;

ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS transcribe jsonb;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS wait_until timestamptz;
