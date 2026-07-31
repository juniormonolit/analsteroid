-- ГАЧА (фаза 2 дизайн-дока monolitika-shop-design.md, «го» Серёги 31.07):
-- крутка 10 ебаллов, серверный RNG, soft pity с 61-й (+2 п.п./крутка к редкому),
-- hard pity 80 (гарантия редкого), лимиты 5/день и 20/нед, шансы публикуются.
-- СИСТЕМНАЯ БД (YC, dbname=system) — применяется вручную migrations/run_system.mjs.
--
-- ── Экономика (пересчёт под джекпот-айфон, требование Серёги) ────────────────
-- Джекпот = «iPhone (актуальный)» ~150 000 ₽, ВНЕ pity, шанс 60 ppm = 0,006%
-- (1 к 16 667) → ожидаемые затраты 150 000 × 0,00006 = 9 ₽/крутку (лимит ~10 ₽).
-- Полный EV-расклад (ppm, сумма ровно 1 000 000):
--   +2 ебалла        394 940 (39,494%)  возврат 0,79 еб   0 ₽
--   +5 ебаллов       250 000 (25%)      возврат 1,25 еб   0 ₽
--   +10 ебаллов      150 000 (15%)      возврат 1,50 еб   0 ₽ («крутка отбилась»)
--   Кофе              80 000 (8%)       ~250 ₽ × 8%   = 20,0 ₽/крутку
--   Поздний старт+2ч  80 000 (8%)       время, 0 ₽ кэш
--   Сброс мёртвых     40 000 (4%)       0 ₽
--   Отгул (редкий)     2 500 (0,25%)    время, 0 ₽ кэш
--   Мерч-бокс (редкий) 2 500 (0,25%)    ~1 500 ₽ × 0,25% = 3,75 ₽/крутку
--   Джекпот iPhone        60 (0,006%)   150 000 ₽ × 0,006% = 9,0 ₽/крутку
-- Итого ₽/крутка ≈ 32,75 ₽ (цель 30–40 ₽). Возврат ебаллов EV = 3,54 еб (35,4%
-- цены) → чистое оседание 6,46 еб/крутка (64,6%). Редкий+ база = 0,506%.
--
-- Механика pity: общий счётчик круток без редкого+ (отгул/мерч/джекпот сбрасывают);
-- с 61-й крутки шанс редкого растёт на 2 п.п. за крутку, на 80-й — гарантия
-- (50/50 отгул/мерч по базовым весам). Джекпот от pity НЕ зависит (всегда 60 ppm).
-- Каждый item-приз идёт в обычный инвентарь (никакой параллельной бухгалтерии):
-- price_paid=1 (получен за крутку, а не за цену каталога — чтобы 50%-возврат при
-- истечении не печатал халявные ебаллы), джекпот — сразу заявкой руководителю.
-- Сток (iPhone stock=1): тир с закончившимся стоком исключается из ролла.
-- DOWN: DROP TABLE gacha_spins, gacha_pool; ALTER TABLE badge_coin_settings DROP
--       COLUMN gacha_enabled/gacha_spin_cost/gacha_daily_limit/gacha_weekly_limit;
--       вернуть chk_ledger_source из 119; DELETE позиции кофе/мерч/iPhone.

ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_source
  CHECK (source IN ('auto','manual_bonus','manual_penalty','convert','payout',
                    'shop_purchase','shop_refund','expiry','release_zero','release_grant',
                    'gacha_spin','gacha_prize'));

ALTER TABLE badge_coin_settings
  ADD COLUMN IF NOT EXISTS gacha_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS gacha_spin_cost int NOT NULL DEFAULT 10 CHECK (gacha_spin_cost > 0),
  ADD COLUMN IF NOT EXISTS gacha_daily_limit int NOT NULL DEFAULT 5 CHECK (gacha_daily_limit > 0),
  ADD COLUMN IF NOT EXISTS gacha_weekly_limit int NOT NULL DEFAULT 20 CHECK (gacha_weekly_limit > 0);

-- Пул тиров. chance_ppm — базовый опубликованный шанс в ppm (1e6 = 100%);
-- админ правит шансы/тиры в настройках, API валидирует сумму включённых = 1e6.
CREATE TABLE IF NOT EXISTS gacha_pool (
  id           bigserial PRIMARY KEY,
  tier_key     text NOT NULL UNIQUE,
  name         text NOT NULL,
  icon         text NOT NULL DEFAULT '🎁',
  rarity       text NOT NULL CHECK (rarity IN ('common','rare','jackpot')),
  prize_type   text NOT NULL CHECK (prize_type IN ('eball','item')),
  eball_amount int CHECK (eball_amount IS NULL OR eball_amount > 0),
  shop_item_id bigint REFERENCES shop_items(id),
  chance_ppm   int NOT NULL CHECK (chance_ppm >= 0),
  enabled      boolean NOT NULL DEFAULT true,
  sort         int NOT NULL DEFAULT 100,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_gacha_prize CHECK (
    (prize_type = 'eball' AND eball_amount IS NOT NULL AND shop_item_id IS NULL) OR
    (prize_type = 'item'  AND eball_amount IS NULL AND shop_item_id IS NOT NULL)
  )
);

-- Лог круток: результат определяется НА СЕРВЕРЕ до анимации; фронт получает
-- готовый tier_key. pity_count — счётчик ДО этой крутки; forced_by_pity —
-- сработала hard-гарантия 80.
CREATE TABLE IF NOT EXISTS gacha_spins (
  id                bigserial PRIMARY KEY,
  bitrix_id         integer NOT NULL,
  tier_key          text NOT NULL,
  rarity            text NOT NULL,
  prize_name        text NOT NULL,
  eball_amount      int,
  inventory_item_id bigint REFERENCES inventory_items(id),
  spend_ledger_id   bigint REFERENCES badge_coin_ledger(id),
  prize_ledger_id   bigint REFERENCES badge_coin_ledger(id),
  pity_count        int NOT NULL DEFAULT 0,
  forced_by_pity    boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gacha_spins_mgr ON gacha_spins (bitrix_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gacha_spins_rare ON gacha_spins (bitrix_id, id) WHERE rarity IN ('rare','jackpot');

-- Каталожные позиции призов гачи (принцип дизайн-дока: всё из гачи можно купить
-- напрямую). iPhone — сток 1 (НЕ безлимит), кофе/мерч — безлимит.
INSERT INTO shop_items (name, description, category, price_units, allowed_currencies, ttl_months, sort)
SELECT v.* FROM (VALUES
  ('Кофе за счёт компании',  'Кофе/снек — купон, показать руководителю', 'material', 25::numeric,    '{EBALL}'::text[], 3, 105),
  ('Фирменный мерч-бокс',    'Набор фирменного мерча',                    'material', 300::numeric,   '{EBALL}'::text[], 3, 115),
  ('iPhone (актуальный)',    'Флагманский iPhone — топ-приз',             'material', 15000::numeric, '{EBALL}'::text[], 3, 140)
) AS v(name, description, category, price_units, allowed_currencies, ttl_months, sort)
WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.name);
UPDATE shop_items SET stock = 1 WHERE name = 'iPhone (актуальный)' AND stock IS NULL;

-- Сид пула (идемпотентно, по tier_key). Сумма ppm = 1 000 000 ровно.
INSERT INTO gacha_pool (tier_key, name, icon, rarity, prize_type, eball_amount, shop_item_id, chance_ppm, sort)
SELECT v.tier_key, v.name, v.icon, v.rarity, v.prize_type, v.eball_amount,
       (SELECT id FROM shop_items s WHERE s.name = v.item_name),
       v.chance_ppm, v.sort
  FROM (VALUES
    ('g_eball_2',   '+2 ебалла',              '🪙', 'common',  'eball', 2,    NULL,                       394940, 10),
    ('g_eball_5',   '+5 ебаллов',             '💰', 'common',  'eball', 5,    NULL,                       250000, 20),
    ('g_eball_10',  '+10 ебаллов — отбилась', '🍀', 'common',  'eball', 10,   NULL,                       150000, 30),
    ('g_coffee',    'Кофе за счёт компании',  '☕', 'common',  'item',  NULL, 'Кофе за счёт компании',     80000, 40),
    ('g_late',      'Поздний старт +2 часа',  '🕙', 'common',  'item',  NULL, 'Поздний старт +2 часа',     80000, 50),
    ('g_reset',     'Сброс мёртвых сделок',   '🧹', 'common',  'item',  NULL, 'Сброс мёртвых сделок',      40000, 60),
    ('g_dayoff',    'Отгул',                  '🏖️', 'rare',    'item',  NULL, 'Отгул (полный оплачиваемый день)', 2500, 70),
    ('g_merch',     'Фирменный мерч-бокс',    '🎁', 'rare',    'item',  NULL, 'Фирменный мерч-бокс',        2500, 80),
    ('g_jackpot',   'ДЖЕКПОТ: iPhone',        '📱', 'jackpot', 'item',  NULL, 'iPhone (актуальный)',          60, 90)
  ) AS v(tier_key, name, icon, rarity, prize_type, eball_amount, item_name, chance_ppm, sort)
 WHERE NOT EXISTS (SELECT 1 FROM gacha_pool g WHERE g.tier_key = v.tier_key);
