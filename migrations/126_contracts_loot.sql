-- 126: Доска контрактов + лутдроп (дополнения Серёги к квестам, 01.08).
--  * Контракты: общий пул квестов, менеджер берёт сам; цели/сроки рандомизированы
--    вокруг тир-порогов; брать может любой любой тир («управляемое мошенничество»);
--    депозит 30% награды (параметр) — вернулся при успехе, сгорел при провале;
--    лимит 2 активных, кулдаун 24ч после провала; пул обновляется еженедельно.
--  * Лутдроп: за выполнение квеста/контракта с шансом падает предмет магазина в
--    инвентарь (механика гачи); шанс по тиру: 5/10/15/25/100%.
--
-- DOWN:
--   DROP TABLE IF EXISTS quest_contracts;
--   ALTER TABLE quest_settings DROP COLUMN IF EXISTS deposit_pct,
--     DROP COLUMN IF EXISTS contract_limit, DROP COLUMN IF EXISTS contract_cooldown_h,
--     DROP COLUMN IF EXISTS contract_pool_size, DROP COLUMN IF EXISTS loot_table;
--   ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
--   (вернуть CHECK из 125)

ALTER TABLE quest_settings
  ADD COLUMN IF NOT EXISTS deposit_pct numeric NOT NULL DEFAULT 0.3,
  ADD COLUMN IF NOT EXISTS contract_limit int NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS contract_cooldown_h int NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS contract_pool_size int NOT NULL DEFAULT 8,
  -- Дроп-таблица по тиру: шанс 0..1 + пул shop_item_id (реальные предметы магазина).
  ADD COLUMN IF NOT EXISTS loot_table jsonb NOT NULL DEFAULT '{
    "white":     {"chance": 0.05, "items": [14]},
    "green":     {"chance": 0.10, "items": [14, 1]},
    "blue":      {"chance": 0.15, "items": [14, 2]},
    "epic":      {"chance": 0.25, "items": [2, 3, 6]},
    "legendary": {"chance": 1.00, "items": [5, 15]}
  }'::jsonb;

CREATE TABLE IF NOT EXISTS quest_contracts (
  id bigserial PRIMARY KEY,
  week_start date NOT NULL,               -- пул какой недели
  category text NOT NULL CHECK (category IN
    ('sales_count','sales_amount','group_sales','repeat_sales','crosssell','distinct_groups')),
  target numeric NOT NULL CHECK (target > 0),
  target_group text,
  pair_first text,
  title text NOT NULL,
  days int NOT NULL CHECK (days BETWEEN 1 AND 31),  -- срок с момента взятия
  tier text NOT NULL CHECK (tier IN ('white','green','blue','epic','legendary')),
  reward_eballs int NOT NULL,
  reward_xp int NOT NULL,
  deposit int NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','taken','done','failed','expired')),
  taken_by bigint,
  taken_at timestamptz,
  deadline date,
  progress numeric NOT NULL DEFAULT 0,
  done_at timestamptz,
  coin_ledger_id bigint,                  -- начисление награды
  deposit_ledger_id bigint,               -- списание депозита
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quest_contracts_open_idx ON quest_contracts (week_start) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS quest_contracts_taken_idx ON quest_contracts (taken_by) WHERE status = 'taken';

ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_source
  CHECK (source IN ('auto','manual_bonus','manual_penalty','convert','payout',
                    'shop_purchase','shop_refund','expiry','release_zero','release_grant',
                    'gacha_spin','gacha_prize','transfer_out','transfer_in','transfer_fee',
                    'quest','quest_reroll','quest_extra',
                    'contract_deposit','contract_deposit_return','contract_deposit_burn'));
