-- 268: состав очередей канбана запросов логистам = участники проекта Битрикса (решение владельца 19.11:
-- «так понятно, кто за какую группу товаров отвечает»). Источник правды — Битрикс (sonet_group.user.get),
-- синк периодический (фоновая задача logistQueueMembers) + кнопка «обновить» в настройках; ручных правок нет.
-- БД: monolitika (systemDb), накат под monolitik, после 267. Идемпотентна. Гранты не нужны — новые только колонки.
-- Откат: ALTER TABLE logist_queue_members DROP COLUMN source, DROP COLUMN synced_at, DROP COLUMN bx_role, DROP COLUMN work_position;
--        ALTER TABLE logist_queues DROP COLUMN members_synced_at, DROP COLUMN members_sync_error;

ALTER TABLE logist_queue_members
  ADD COLUMN IF NOT EXISTS source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('bitrix', 'manual')),
  ADD COLUMN IF NOT EXISTS synced_at     timestamptz,
  ADD COLUMN IF NOT EXISTS bx_role       text,          -- роль в проекте: A владелец, E модератор, K участник
  ADD COLUMN IF NOT EXISTS work_position text;          -- должность из user.get (видно, кто не логист)

ALTER TABLE logist_queues
  ADD COLUMN IF NOT EXISTS members_synced_at  timestamptz,
  ADD COLUMN IF NOT EXISTS members_sync_error text;     -- последняя ошибка синка (нет прав на проект и т.п.); состав при ошибке не трогается
