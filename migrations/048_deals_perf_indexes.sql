-- Индексы производительности для sa.deals (БД сделок, self-hosted Supabase на MLT).
-- НЕ ПРИМЕНЕНО К БАЗЕ (задача #1277): DDL в схеме sa требует supabase_admin —
-- проверено вживую 08.07.2026: has_schema_privilege('sa','CREATE') = false у нашего
-- пользователя. Применять — Артём/владелец сервера.
--
-- v2 после замера на живой базе 08.07.2026 (215 063 строки в sa.deals):
-- из первоначального списка УБРАНЫ дубли уже существующих индексов —
-- created_at, reserved_at, confirmed_at, sold_at, delivered_at, current_manager_id,
-- funnel_id, product_group_id уже покрыты (deals_*_idx / idx_sa_deals_*, см. pg_indexes).
-- Остались только 5 реально отсутствующих, каждый подтверждён EXPLAIN (ANALYZE):
-- полный разбор в owners-inbox/analsteroid-night-db-20260708.md, раздел «Замер 08.07».
--
-- При применении на живой базе: CREATE INDEX CONCURRENTLY по одному
-- (вне транзакции/batch-раннера), чтобы не блокировать запись.

-- 1) lost_at — ГЛАВНЫЙ индекс этого набора. Замер показал: из шести дат сделки
-- проиндексированы пять, и одно неиндексированное плечо `lost_at BETWEEN ...` в
-- 6-стороннем OR (окно периода в /api/reports/run и /api/reports/deals) ломает
-- BitmapOr-план ЦЕЛИКОМ — планировщик уходит в Parallel Seq Scan всей таблицы
-- (~96 мс сейчас; без lost_at-плеча тот же запрос идёт по индексам за ~56 мс).
-- Отдельно: метрики отказов (окно только по lost_at, миграция 034) — Seq Scan даже
-- на недельном окне (~63 мс на 1 060 строк из 215 063).
-- Частичный WHERE — в стиле существующих deals_sold_at_idx и т.п.; условие
-- `lost_at >= X` подразумевает NOT NULL, индекс применим ко всем таким запросам.
CREATE INDEX IF NOT EXISTS idx_sa_deals_lost_at
  ON sa.deals (lost_at) WHERE lost_at IS NOT NULL;

-- 2) source_id — отчёт «по источникам» и маркетинговый drilldown
-- (WHERE d.source_id IN (...), lib/marketing/sources.ts::sourceIdsWhere).
-- Замер: на широком окне (полгода) планировщик бросает индексы дат и уходит в
-- Parallel Seq Scan (~70 мс), при том что сделок одного источника за полгода
-- ~1 500 из 215 тысяч (483 уникальных источника — фильтр очень селективный).
CREATE INDEX IF NOT EXISTS idx_sa_deals_source_id
  ON sa.deals (source_id);

-- 3) head_group_name — режим товарных групп by_max: GROUP BY/WHERE идёт по
-- СТРОКОВОМУ имени (features/reports/engine/byProductGroups.ts, byManagers.ts
-- drilldown), а проиндексирован только head_group_id — код по id не фильтрует.
-- Замер: на широком окне то же — Parallel Seq Scan ~70 мс при ~1 300 строках
-- одной группы (51 уникальная группа).
CREATE INDEX IF NOT EXISTS idx_sa_deals_head_group_name
  ON sa.deals (head_group_name);

-- 4-5) Повторные покупки/отгрузки (_ppp/_ppo в lib/metrics/sqlGen.ts):
-- ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY sold_at/delivered_at).
-- Замер: сейчас это Seq Scan + Sort 34 821 строки (quicksort 3.1 МБ, ~180 мс
-- суммарно) на каждый расчёт метрик ППП/ППО. Частичный составной индекс отдаёт
-- строки уже в порядке (contact_id, sold_at) — узел Sort исчезает.
CREATE INDEX IF NOT EXISTS idx_sa_deals_contact_sold_at
  ON sa.deals (contact_id, sold_at) WHERE sold_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sa_deals_contact_delivered_at
  ON sa.deals (contact_id, delivered_at) WHERE delivered_at IS NOT NULL;

-- Попутная находка для владельца БД (НЕ входит в эту миграцию — DROP чужих
-- индексов без владельца не делаем): на sa.deals два полных дубля —
--   deals_created_at_idx ≡ idx_sa_deals_created_at (btree created_at),
--   deals_current_manager_id_idx ≡ idx_sa_deals_current_manager (btree current_manager_id).
-- По одному из каждой пары можно удалить — экономия на каждой записи в таблицу.
