-- Индексы производительности для sa.deal_events (события по сделкам — звонки и т.п.).
-- БД: YC analytics (run_analytics.mjs), тот же контур/оговорки, что в 048_deals_perf_indexes.sql.
--
-- НЕ ПРИМЕНЕНО К БАЗЕ — только файл миграции (см. задачу #1277).
-- При реальном применении — CREATE INDEX CONCURRENTLY по одному, вне общего batch-запуска.
--
-- Правило из COWORK_DB_GUIDE.md: "deal_events не JOIN-ить напрямую к deals — создаёт
-- дубли строк", поэтому весь доступ к этой таблице в коде идёт либо через коррелированный
-- подзапрос `WHERE de.deal_id = d.deal_id AND de.<dateField> BETWEEN ...`
-- (lib/metrics/sqlGen.ts genEventsExpr — по одному такому подзапросу на event-метрику,
-- выполняется на каждую строку deals), либо через EXISTS с тем же условием
-- (buildCollectedSQL), либо через отдельный `SELECT DISTINCT deal_id ... WHERE event_at
-- BETWEEN ...` в /api/reports/deal(s) (extraJoin для event-метрики в drilldown).

-- Основной паттерн доступа — по конкретной сделке + диапазон дат события; без индекса
-- каждый коррелированный подзапрос/EXISTS — это seq scan deal_events на каждую строку
-- deals, что при большой таблице событий даёт O(N_deals × N_events) в худшем случае.
CREATE INDEX IF NOT EXISTS idx_deal_events_deal_id_event_at ON deal_events (deal_id, event_at);

-- Второй паттерн — независимый скан по диапазону дат события в /api/reports/deal(s)
-- (`SELECT DISTINCT deal_id FROM deal_events WHERE event_at >= $1 AND event_at < $2 ...`),
-- до JOIN с deals.
CREATE INDEX IF NOT EXISTS idx_deal_events_event_at ON deal_events (event_at);

-- Фильтр по типу события идёт через `stage_id IN (SELECT id FROM stages WHERE
-- event_type = '...')` — обычная колонка-джойн, где stages — маленький справочник.
CREATE INDEX IF NOT EXISTS idx_deal_events_stage_id ON deal_events (stage_id);
