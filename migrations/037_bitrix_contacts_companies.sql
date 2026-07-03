-- system DB: справочники контактов и компаний из Bitrix24 (разовый бэкфилл)
-- Запуск: node migrations/run_system.mjs migrations/037_bitrix_contacts_companies.sql

CREATE TABLE IF NOT EXISTS bitrix_contacts (
  id             bigint PRIMARY KEY,          -- Bitrix contact ID (= sa.deals.contact_id)
  name           text,
  second_name    text,
  last_name      text,
  company_id     bigint,                      -- основная компания контакта
  type_id        text,
  source_id      text,
  source_description text,
  post           text,
  assigned_by_id bigint,
  created_by_id  bigint,
  phones         jsonb,                       -- массив строк
  emails         jsonb,
  utm            jsonb,                       -- {source,medium,campaign,content,term}
  date_create    timestamptz,
  date_modify    timestamptz,
  raw            jsonb NOT NULL,              -- полный ответ Bitrix как есть
  synced_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bitrix_contacts_company ON bitrix_contacts (company_id);
CREATE INDEX IF NOT EXISTS idx_bitrix_contacts_assigned ON bitrix_contacts (assigned_by_id);

CREATE TABLE IF NOT EXISTS bitrix_companies (
  id             bigint PRIMARY KEY,          -- Bitrix company ID
  title          text,
  company_type   text,
  industry       text,
  employees      text,
  revenue        numeric,
  currency_id    text,
  assigned_by_id bigint,
  created_by_id  bigint,
  phones         jsonb,
  emails         jsonb,
  web            jsonb,
  utm            jsonb,
  date_create    timestamptz,
  date_modify    timestamptz,
  raw            jsonb NOT NULL,
  synced_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bitrix_companies_assigned ON bitrix_companies (assigned_by_id);
