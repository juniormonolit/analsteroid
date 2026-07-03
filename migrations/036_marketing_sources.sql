-- Справочник маркетинговых источников Битрикса (из temp/Источники битрикс.xlsx),
-- разобранный на измерения. Ключ = deals.source_id (SA DB). БД: YC system (run_system.mjs).
-- Данные заливаются скриптом (см. WORKLOG 2026-07-02), таблица переживает перезаливку upsert'ом.
CREATE TABLE IF NOT EXISTS marketing_sources (
  source_id     text PRIMARY KEY,          -- Bitrix SOURCE_ID, совпадает с sa.deals.source_id
  name          text NOT NULL,             -- исходное название из справочника
  category      text NOT NULL DEFAULT 'marketing', -- marketing | system | manager | hr
  contact_type  text,                      -- Звонок (коллтрекинг) / Авито / Почта / Заявка с сайта / Онлайн-чат / WhatsApp / ...
  branch        text,                      -- Москва/МО, Краснодар, СПб, ... NULL = не определён (вероятно СПб)
  branch_source text,                      -- marker | phone — как определили филиал
  platform      text,                      -- витрина: домен сайта или название аккаунта (Регион, СтройМаркет...)
  brand         text,                      -- бренд/проект: Монолит, Велесарк, БетаБетон...
  ad_channel    text,                      -- Авито / Я.Директ / Я.Директ (фид) / Google / Я.Карты / РСЯ
  phone         text,                      -- коллтрекинговый номер, если есть
  markers       text[] NOT NULL DEFAULT '{}', -- все скобочные маркеры из названия как есть
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_sources_brand_idx    ON marketing_sources (brand);
CREATE INDEX IF NOT EXISTS marketing_sources_contact_idx  ON marketing_sources (contact_type);
CREATE INDEX IF NOT EXISTS marketing_sources_branch_idx   ON marketing_sources (branch);
CREATE INDEX IF NOT EXISTS marketing_sources_platform_idx ON marketing_sources (platform);
