-- Задача #5636 (Серёга, стоячая санкция): ТВ-дашборд продаж/броней в реальном
-- времени. Архитектура — owners-inbox/monolitika-tv-realtime-sales-design-20260907.html
-- (Дмитрий). Применяется на Мишиной БД (62.113.100.67) под supabase_admin, как и
-- migrations/sa_org/001-002 — junior_user (роль приложения) DDL не может.
--
-- Накатка:
--   docker exec -i supabase-db psql -U supabase_admin -d postgres \
--     < migrations/sa_org/003_deals_notify_tv.sql
--
-- Колонки sa.deals сверены живым \d sa.deals (07.09.2026, роль junior_user):
-- deal_id (не id), deal_name (не title), current_manager_id, amount, stage_id,
-- is_reserved, sold_at, reserved_at, updated_at. Колонки title/is_test из
-- черновика архитектурного документа в реальной схеме ОТСУТСТВУЮТ — заменены
-- на deal_name (для фильтра ZZZ_-тестов, если он когда-нибудь понадобится SQL
-- «сегодня»; сам этот SQL уже живёт в features/tv/engine/feed.ts и не трогается
-- этой миграцией).

-- 1) Функция уведомления. Триггер AFTER — видит sold_at/reserved_at, которые уже
--    проставил существующий BEFORE-триггер trg_deals_set_event_timestamps_upd/_ins.
CREATE OR REPLACE FUNCTION sa.deals_notify_tv() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE payload text;
BEGIN
  payload := json_build_object(
    'deal_id',     NEW.deal_id,
    'stage_id',    NEW.stage_id,
    'amount',      NEW.amount,
    'manager',     NEW.current_manager_id,
    'sold_at',     NEW.sold_at,
    'reserved_at', NEW.reserved_at,
    'is_reserved', NEW.is_reserved,
    'op',          TG_OP,
    'at',          now()
  )::text;
  -- NOTIFY ограничен 8000 байт; наш payload ~250 байт, запаса хватает.
  -- Экран по этому событию делает refetch SQL «сегодня» целиком — payload
  -- служит фильтром «интересно / не интересно», а не источником правды.
  PERFORM pg_notify('sa_deals_changed', payload);
  RETURN NULL;
END $$;

-- 2) Триггер: вставка + значимые изменения (см. акцептанс задачи #5636).
DROP TRIGGER IF EXISTS trg_deals_notify_tv ON sa.deals;
CREATE TRIGGER trg_deals_notify_tv
AFTER INSERT OR UPDATE OF stage_id, amount, current_manager_id, sold_at, reserved_at
ON sa.deals
FOR EACH ROW
EXECUTE FUNCTION sa.deals_notify_tv();

-- 3) Бизнес-дата продажи из MLT — нужна будущей страховке (шаги 6-8 архитектурного
--    документа, в скоуп этой задачи НЕ входят) для честного diff с mlt.sales.list.
--    Заполняется отдельно, n8n-флоу DEAL Update v2 эта миграция не трогает.
ALTER TABLE sa.deals ADD COLUMN IF NOT EXISTS mlt_date_sale date;
CREATE INDEX IF NOT EXISTS idx_deals_mlt_date_sale
  ON sa.deals (mlt_date_sale) WHERE mlt_date_sale IS NOT NULL;

-- 4) Индексы под sold_at/reserved_at уже существуют в проде
--    (deals_sold_at_idx, deals_reserved_at_idx) — не дублируем, оставлено
--    как IF NOT EXISTS на случай другого имени на другом окружении.
CREATE INDEX IF NOT EXISTS idx_deals_sold_at     ON sa.deals (sold_at)     WHERE sold_at     IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deals_reserved_at ON sa.deals (reserved_at) WHERE reserved_at IS NOT NULL;

-- Проверка после накатки (одна сессия LISTEN, вторая — ручной NOTIFY на тестовом
-- канале, ничего в данных не меняя):
--   psql ... -c "LISTEN sa_deals_changed;" (оставить висеть)
--   -- в другой сессии на прод-сделке с префиксом ZZZ_:
--   -- UPDATE sa.deals SET amount = amount WHERE deal_name LIKE 'ZZZ\_%' LIMIT 1;
