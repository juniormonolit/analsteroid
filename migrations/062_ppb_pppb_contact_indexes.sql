-- ⚠️ Целевая БД — НЕ YC analytics (metrics), а self-hosted Supabase Миши, 62.113.100.67,
-- схема `sa`, таблица sa.deals. Наш обычный юзер (junior_user) READ-ONLY — DDL требует
-- supabase_admin (см. память reference_mlt_postgres_privileges.md). Катить — Артём/владелец БД.
--
-- ⚠️ CONCURRENTLY нельзя выполнять внутри транзакции/пакета с другими операторами —
-- запускать этот файл ОТДЕЛЬНО, одним самостоятельным запросом (например,
-- `psql ... -f 062_ppb_pppb_contact_indexes.sql`, не через мультистейтмент-раннер
-- вместе с 061 или другими файлами).
--
-- Контекст: ППБ/ПППБ (см. 061_scope_independent_ppb_pppb_metrics.sql) ранжируют сделки
-- через ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY reserved_at / confirmed_at).
-- У ППП/ППО (sold_at/delivered_at) под этот паттерн уже есть готовые композитные индексы
-- (idx_sa_deals_contact_sold_at, idx_sa_deals_contact_delivered_at). Для reserved_at и
-- confirmed_at сейчас есть только одноколоночные partial-индексы (deals_reserved_at_idx,
-- deals_confirmed_at_idx) — планировщику приходится делать отдельный Sort по (contact_id,
-- date). На текущем объёме (проверено 09.07.2026: 34405 строк reserved_at IS NOT NULL,
-- 14036 confirmed_at IS NOT NULL) это НЕ проблема — EXPLAIN ANALYZE показал ~47мс на
-- confirmed_at. Индексы ниже — заготовка про запас на будущий рост таблицы, не блокер.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sa_deals_contact_reserved_at
  ON sa.deals (contact_id, reserved_at) WHERE reserved_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sa_deals_contact_confirmed_at
  ON sa.deals (contact_id, confirmed_at) WHERE confirmed_at IS NOT NULL;
