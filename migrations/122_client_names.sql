-- 122: Кэш имён клиентов (контакты/компании Битрикса) для раздела «Мои заказчики».
-- Тот же ленивый паттерн, что manager_avatars (миграция 106): имя тянется из
-- Битрикса (crm.contact.list / crm.company.list, read-only вебхук BITRIX_WEBHOOK_URL)
-- ТОЛЬКО для строк текущей страницы списка и оседает здесь с TTL-штампом; неудача
-- тоже штампует synced_at, чтобы не долбить Битрикс. ПДн: храним только имя
-- (оно и так видно менеджеру в CRM) — телефоны не запрашиваются и не хранятся.
CREATE TABLE IF NOT EXISTS client_names (
  client_key TEXT PRIMARY KEY,          -- 'c<contact_id>' | 'k<company_id>'
  name       TEXT,                      -- NULL = не удалось получить (или пусто в CRM)
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
