-- Модуль «Карточка клиента», v2 (решение владельца 13.10): объекты ведутся
-- ТОЛЬКО в Монолитике — смарт-процесс «Объекты» (1108) в Битриксе упразднён.
-- АНАЛИТИЧЕСКАЯ БД sa (self-hosted Supabase 62.113.100.67).
--
-- ПРИМЕНЯЕТСЯ СУПЕР-ЮЗЕРОМ ВРУЧНУЮ (docker exec -i supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -1 < файл):
-- у app-юзера junior_user нет CREATE/ALTER в схеме sa. До наката модуль работает:
-- статусы считаются автоматически, «Завершить вручную», подтверждение адреса,
-- перепривязка сделки и настройка N недоступны (виджет об этом пишет).
--
-- Что добавляет:
--  1) sa.client_module_objects:
--     status_manual  — ручной статус объекта: 'done' («Завершён» вручную) или NULL (авто);
--     address_source — откуда адрес: '1c' (заявки Пульта/1С), 'bitrix' (адрес сделки), 'manual';
--     address_confirmed — менеджер подтвердил/поправил автоматический адрес
--                         (пока false — в карточке плашка «Проверь адрес»).
--  2) sa.client_module_deal_objects — ручная привязка сделки к объекту (если
--     автоматическая по адресу ошиблась). Одна сделка — один объект.
--  3) sa.client_module_settings — настройки модуля (ключ → jsonb): пока
--     'object_active_days' — N дней после последней отгрузки, в течение которых
--     объект «В работе» (дальше и без активных сделок — «Завершён»).
--
-- Статусы объекта (правило владельца 13.10):
--   «Новый»     — заведён менеджером вручную, сделок ещё нет;
--   «В работе»  — есть активная сделка или с последней отгрузки прошло ≤ N дней;
--   «Завершён»  — вручную менеджером, либо > N дней с последней отгрузки и нет активных сделок.
--
-- DOWN:
--   DROP TABLE IF EXISTS sa.client_module_settings; DROP TABLE IF EXISTS sa.client_module_deal_objects;
--   ALTER TABLE sa.client_module_objects DROP COLUMN IF EXISTS status_manual,
--     DROP COLUMN IF EXISTS address_source, DROP COLUMN IF EXISTS address_confirmed;

ALTER TABLE sa.client_module_objects
  ADD COLUMN IF NOT EXISTS status_manual     text,
  ADD COLUMN IF NOT EXISTS address_source    text,
  ADD COLUMN IF NOT EXISTS address_confirmed boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS sa.client_module_deal_objects (
  deal_id     bigint PRIMARY KEY,
  client_ref  text NOT NULL,          -- 'c<contact_id>' | 'k<company_id>'
  object_key  text NOT NULL,          -- ключ объекта (как в client_module_objects.object_key)
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_module_deal_objects_ref_idx ON sa.client_module_deal_objects (client_ref);

CREATE TABLE IF NOT EXISTS sa.client_module_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sa.client_module_settings (key, value) VALUES ('object_active_days', '90'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE sa.client_module_deal_objects IS
  'Модуль «Карточка клиента» (analsteroid, 13.10): ручная привязка сделки к объекту клиента, если автоматическая по адресу ошиблась.';
COMMENT ON TABLE sa.client_module_settings IS
  'Модуль «Карточка клиента» (analsteroid, 13.10): настройки модуля (object_active_days и др.).';

GRANT USAGE ON SCHEMA sa TO junior_user;
GRANT SELECT, INSERT, UPDATE ON sa.client_module_deal_objects TO junior_user;
GRANT SELECT, INSERT, UPDATE ON sa.client_module_settings TO junior_user;
REVOKE DELETE ON sa.client_module_deal_objects FROM junior_user;
REVOKE DELETE ON sa.client_module_settings FROM junior_user;
