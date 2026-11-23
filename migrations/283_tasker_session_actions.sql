-- 283: «Задачник» — действия у сессии исполнителя (UX-аудит 23.11, п.39: «Провёл» / «Перенести»).
-- «Провёл» — отметка на сессии (кто и когда), задачи сессии НЕ закрывает: их завершают с «Что сделано».
-- «Перенести» — новый слот (slot_start/duration_min уже есть с 274), событие календаря и плановые даты
-- задач — через outbox (features/tasker/engine/sessionActions.ts).
-- БД: monolitika (systemDb). Новых таблиц нет — гранты 274 покрывают. Идемпотентна.
-- Откат: ALTER TABLE tasker_sessions DROP COLUMN held_at, DROP COLUMN held_by, DROP COLUMN held_by_user;

ALTER TABLE tasker_sessions
  ADD COLUMN IF NOT EXISTS held_at      timestamptz,
  -- имя отметившего (для показа) и id пользователя Монолитики
  ADD COLUMN IF NOT EXISTS held_by      text,
  ADD COLUMN IF NOT EXISTS held_by_user text;
