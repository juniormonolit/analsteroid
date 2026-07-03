-- Крупная группировка каналов: Авито / Я.Директ / Google / Карты / Сайты (SEO/орг.) / Системные.
-- Заполняется скриптом (см. WORKLOG 2026-07-02). БД: YC system (run_system.mjs).
ALTER TABLE marketing_sources ADD COLUMN IF NOT EXISTS channel_group text;
CREATE INDEX IF NOT EXISTS marketing_sources_chgroup_idx ON marketing_sources (channel_group);
