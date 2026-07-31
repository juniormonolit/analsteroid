-- Магазин призов, MVP (задача Арнольда/Серёги 31.07, дизайн owners-inbox/monolitika-shop-design.md):
-- каталог + инвентарь + заявки активации. Гача и сезоны — НЕ здесь (фазы 2-3).
-- СИСТЕМНАЯ БД (YC, dbname=system) — применяется вручную migrations/run_system.mjs.
--
-- Цены каталога хранятся в ЕДИНИЦАХ ИНДЕКСАЦИИ (price_units): сейчас курс
-- единицы = 1 ебалл (константа UNIT_EBALL_RATE=1 в features/shop/engine/shop.ts),
-- при вводе индексации (owners-inbox/monolitika-eball-indexation.md) курс единицы
-- станет расчётным (k × I_мед / I_топ) — цены в витрине поедут сами, без правки
-- каталога. Цена В МОМЕНТ ПОКУПКИ фиксируется в inventory_items.price_paid и в
-- леджере (принцип price_at_award) — индексация не трогает оформленное.
--
-- Покупка = запись в badge_coin_ledger source='shop_purchase' (сумма со знаком
-- минус, валюта по выбору из allowed_currencies, RUB-цена по курсу
-- rub_to_eball_rate из badge_coin_settings) + предмет в inventory_items.
-- Возврат 50% цены при истечении срока предмета = source='shop_refund'.
-- DOWN: DROP TABLE inventory_items, shop_items; вернуть chk_ledger_source из 116.

CREATE TABLE IF NOT EXISTS shop_items (
  id                 bigserial PRIMARY KEY,
  name               text NOT NULL,
  description        text,
  category           text NOT NULL CHECK (category IN ('material','immaterial','team')),
  price_units        numeric NOT NULL CHECK (price_units > 0),  -- единицы индексации; сейчас 1 ед = 1 ебалл
  allowed_currencies text[] NOT NULL DEFAULT '{EBALL}',
  enabled            boolean NOT NULL DEFAULT true,
  stock              int CHECK (stock IS NULL OR stock >= 0),   -- NULL = безлимит; декремент при покупке
  ttl_months         int NOT NULL DEFAULT 3 CHECK (ttl_months > 0),  -- срок годности предмета в инвентаре
  sort               int NOT NULL DEFAULT 100,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Инвентарь: покупка НЕ исполняет приз — кладёт предмет со сроком годности.
-- Workflow активации — клон payout_requests: owned → activation_requested →
-- (approve) used / (reject) ОБРАТНО в owned с обязательной причиной — reject
-- не сжигает предмет, отказ касается конкретной даты, а не права (дизайн-док 3.1).
-- expired: срок вышел, менеджеру возвращено 50% цены (shop_refund в леджер).
CREATE TABLE IF NOT EXISTS inventory_items (
  id               bigserial PRIMARY KEY,
  bitrix_id        integer NOT NULL,
  shop_item_id     bigint NOT NULL REFERENCES shop_items(id),
  item_name        text NOT NULL,                -- снимок названия на момент покупки
  purchased_at     timestamptz NOT NULL DEFAULT now(),
  price_paid       int NOT NULL CHECK (price_paid > 0),
  currency         text NOT NULL DEFAULT 'EBALL' CHECK (currency IN ('EBALL','RUB')),
  status           text NOT NULL DEFAULT 'owned'
                   CHECK (status IN ('owned','activation_requested','used','expired','refunded')),
  expires_at       timestamptz NOT NULL,
  activation_comment text,                       -- пожелание менеджера (дата и т.п.)
  requested_at     timestamptz,
  resolver_login   text,
  resolved_at      timestamptz,
  resolve_comment  text,                         -- причина reject (менеджер видит)
  ledger_id        bigint REFERENCES badge_coin_ledger(id),        -- списание покупки
  refund_ledger_id bigint REFERENCES badge_coin_ledger(id)         -- возврат 50% при истечении
);
CREATE INDEX IF NOT EXISTS idx_inventory_items_mgr ON inventory_items (bitrix_id, purchased_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_items_status ON inventory_items (status);

-- Леджер: новые source покупки/возврата магазина.
ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_source
  CHECK (source IN ('auto','manual_bonus','manual_penalty','convert','payout','shop_purchase','shop_refund'));

ALTER TABLE badge_coin_ledger
  ADD COLUMN IF NOT EXISTS inventory_item_id bigint REFERENCES inventory_items(id);

-- ── Первичный каталог из дизайн-дока (идемпотентно: только если таблица пуста) ──
-- Материальные — плейсхолдеры, Серёга поправит названия/цены в настройках.
INSERT INTO shop_items (name, description, category, price_units, allowed_currencies, ttl_months, sort)
SELECT * FROM (VALUES
  ('Титул / кастомная рамка бейджа на месяц', 'Заметный титул рядом с именем на месяц', 'immaterial', 50::numeric,  '{EBALL}'::text[], 3, 10),
  ('Поздний старт +2 часа',                   'Прийти на 2 часа позже в согласованный день', 'immaterial', 100::numeric, '{EBALL}'::text[], 3, 20),
  ('Сброс мёртвых сделок',                    'До 10 сделок из личной воронки без штрафа по метрикам', 'immaterial', 150::numeric, '{EBALL}'::text[], 3, 30),
  ('Приоритет распределения лидов на 1 день', 'Первым в очереди лидов один день (лимиты — у руководителя)', 'immaterial', 250::numeric, '{EBALL}'::text[], 3, 40),
  ('Отгул (полный оплачиваемый день)',        'Целый день отдыха в согласованную дату', 'immaterial', 500::numeric, '{EBALL}'::text[], 6, 50),
  ('Термокружка',                             'Плейсхолдер — фирменная термокружка', 'material', 150::numeric, '{EBALL,RUB}'::text[], 3, 100),
  ('Наушники беспроводные',                   'Плейсхолдер — уточняется', 'material', 300::numeric,  '{EBALL,RUB}'::text[], 3, 110),
  ('Рабочее кресло',                          'Плейсхолдер — уточняется', 'material', 1000::numeric, '{EBALL,RUB}'::text[], 3, 120),
  ('Монитор',                                 'Плейсхолдер — уточняется', 'material', 2000::numeric, '{EBALL,RUB}'::text[], 3, 125),
  ('Смартфон',                                'Плейсхолдер — флагманский, уточняется', 'material', 10000::numeric, '{EBALL,RUB}'::text[], 3, 130),
  ('Пицца-день отдела',                       'Купон руководителю отдела на пиццу для всех', 'team', 800::numeric,  '{EBALL}'::text[], 3, 210),
  ('Поздний старт всего отдела (+1 час)',     'Активация руководителем, согласование с РОПом', 'team', 1500::numeric, '{EBALL}'::text[], 3, 220),
  ('Тимбилдинг / выезд отдела',               'Крупный командный приз: заявка и одобрение сверху', 'team', 5000::numeric, '{EBALL}'::text[], 3, 230)
) AS seed(name, description, category, price_units, allowed_currencies, ttl_months, sort)
WHERE NOT EXISTS (SELECT 1 FROM shop_items);
