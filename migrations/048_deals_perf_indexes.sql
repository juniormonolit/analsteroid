-- Индексы производительности для sa.deals (аналитическая БД сделок).
-- БД: YC analytics (run_analytics.mjs) в проде — analyticsDb() фолбэчит на YC "analytics",
-- т.к. SA_PG_* на сервере не заданы (см. SECRETS_AND_STORAGE.md). На self-hosted Supabase
-- (dev, schema `sa`) DDL этим индексам НЕ применить — наш юзер там read-only
-- (junior_user, не supabase_admin); там эти индексы нужно ставить отдельно через
-- владельца БД (Артём/сервер), если dev-контур когда-либо станет прод-источником.
--
-- НЕ ПРИМЕНЕНО К БАЗЕ — только файл миграции (см. задачу #1277).
--
-- Обоснование см. в owners-inbox/analsteroid-night-db-20260708.md.
-- Таблица боевая и предположительно большая (растёт с каждой сделкой за все годы) —
-- при реальном применении рекомендуется CREATE INDEX CONCURRENTLY по одному индексу
-- за раз (не одним batch-файлом, как остальные миграции), чтобы не блокировать
-- запись во время построения индекса.

-- Каждый collected-метрика фильтрует по РОВНО ОДНОЙ из этих дат через
-- `d.<dateField> >= $1 AND d.<dateField> < $2` (lib/metrics/sqlGen.ts genDealsExpr),
-- а /api/reports/deal(s) собирает OR по всем шести сразу — Postgres может покрыть
-- эту OR-комбинацию BitmapOr по отдельным индексам на каждую колонку.
CREATE INDEX IF NOT EXISTS idx_deals_created_at   ON deals (created_at);
CREATE INDEX IF NOT EXISTS idx_deals_reserved_at  ON deals (reserved_at);
CREATE INDEX IF NOT EXISTS idx_deals_confirmed_at ON deals (confirmed_at);
CREATE INDEX IF NOT EXISTS idx_deals_sold_at      ON deals (sold_at);
CREATE INDEX IF NOT EXISTS idx_deals_delivered_at ON deals (delivered_at);
CREATE INDEX IF NOT EXISTS idx_deals_lost_at      ON deals (lost_at);

-- Измерение отчёта «по менеджерам» — GROUP BY d.current_manager_id, WHERE в
-- drilldown (managerId=), фильтр «Итого» по списку менеджеров отдела.
CREATE INDEX IF NOT EXISTS idx_deals_manager_id ON deals (current_manager_id);

-- Измерение «по товарным группам» (режим kc) — GROUP BY / WHERE d.product_group_id.
CREATE INDEX IF NOT EXISTS idx_deals_product_group_id ON deals (product_group_id);

-- Измерение «по товарным группам» (режим by_max, каталожная категория) — строковая
-- колонка, используется в GROUP BY и WHERE d.head_group_name = '...' (drilldown).
CREATE INDEX IF NOT EXISTS idx_deals_head_group_name ON deals (head_group_name);

-- Измерение «по источникам» (bySources) + WHERE d.source_id IN (...) в drilldown.
CREATE INDEX IF NOT EXISTS idx_deals_funnel_id ON deals (funnel_id);
CREATE INDEX IF NOT EXISTS idx_deals_source_id ON deals (source_id);

-- Метрики «повторная покупка» (_ppp/_ppo в lib/metrics/sqlGen.ts resolveFilterClause):
-- ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY sold_at/delivered_at) поверх
-- WHERE sold_at/delivered_at IS NOT NULL — частичный индекс покрывает и WHERE, и
-- сортировку внутри партиции без отдельного Sort-узла на всю таблицу.
CREATE INDEX IF NOT EXISTS idx_deals_contact_sold_at
  ON deals (contact_id, sold_at) WHERE sold_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deals_contact_delivered_at
  ON deals (contact_id, delivered_at) WHERE delivered_at IS NOT NULL;
