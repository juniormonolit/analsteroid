-- 125: Квесты (миссии) в ЛК менеджера — по дизайн-доку Софьи
-- (owners-inbox/monolitika-quests-design.md), сценарий наград В, тиры сложности
-- по объективной шкале (схема v2: тир = сложность цели относительно медианного
-- менеджера компании; персонализация определяет, какой тир выпадает).
--
-- DOWN:
--   DROP TABLE IF EXISTS quests;
--   DROP TABLE IF EXISTS quest_settings;
--   ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
--   ALTER TABLE badge_coin_ledger ADD CONSTRAINT chk_ledger_source
--     CHECK (source IN ('auto','manual_bonus','manual_penalty','convert','payout',
--                       'shop_purchase','shop_refund','expiry','release_zero','release_grant',
--                       'gacha_spin','gacha_prize','transfer_out','transfer_in','transfer_fee'));
--   UPDATE badge_definitions SET enabled=false, criteria = criteria || '{"stub":true}'
--    WHERE key IN ('quest_streak_10','quest_week_all','quest_month_daily');

CREATE TABLE IF NOT EXISTS quest_settings (
  id int PRIMARY KEY CHECK (id = 1),
  -- Номиналы наград сценария В = БАЗА СИНЕГО тира (объективная шкала v2).
  reward_day int NOT NULL DEFAULT 5,
  reward_week int NOT NULL DEFAULT 15,
  reward_month int NOT NULL DEFAULT 60,
  -- Множители тиров (белый/зелёный/синий/эпик/легендарный).
  tier_mult jsonb NOT NULL DEFAULT '{"white":0.4,"green":0.7,"blue":1,"epic":2,"legendary":4}',
  -- XP за квест = xp_mult × ебаллы награды (дизайн: 5×).
  xp_mult numeric NOT NULL DEFAULT 5,
  -- Реролл (синк ебаллов): цены замены по типу периода; доп. дневной.
  reroll_day int NOT NULL DEFAULT 10,
  reroll_week int NOT NULL DEFAULT 20,
  reroll_month int NOT NULL DEFAULT 50,
  extra_day int NOT NULL DEFAULT 30,   -- растёт ×2 за каждый следующий в неделе
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO quest_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS quests (
  id bigserial PRIMARY KEY,
  bitrix_id bigint NOT NULL,
  slot text NOT NULL CHECK (slot IN ('day','week1','week2','month','extra')),
  period_type text NOT NULL CHECK (period_type IN ('day','week','month')),
  period_start date NOT NULL,
  period_end date NOT NULL,               -- включительно (последний день периода)
  category text NOT NULL CHECK (category IN
    ('sales_count','sales_amount','group_sales','repeat_sales','crosssell','distinct_groups')),
  target numeric NOT NULL CHECK (target > 0),
  target_group text,                       -- group_sales / crosssell: что продать
  pair_first text,                         -- crosssell: что клиент купил раньше
  title text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('white','green','blue','epic','legendary')),
  reward_eballs int NOT NULL,
  reward_xp int NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','failed','rerolled')),
  progress numeric NOT NULL DEFAULT 0,
  done_at timestamptz,
  coin_ledger_id bigint,                   -- начисление награды (идемпотентность зачёта)
  reroll_of bigint,                        -- этот квест выдан рероллом вместо reroll_of
  meta jsonb NOT NULL DEFAULT '{}'::jsonb, -- аудит генерации: медианы/пороги/слабость
  generated_at timestamptz NOT NULL DEFAULT now()
);
-- Один живой квест на слот-период (реролл переводит старый в 'rerolled').
CREATE UNIQUE INDEX IF NOT EXISTS quests_slot_uni
  ON quests (bitrix_id, slot, period_start) WHERE status <> 'rerolled' AND slot <> 'extra';
CREATE INDEX IF NOT EXISTS quests_mgr_idx ON quests (bitrix_id, period_start DESC);
CREATE INDEX IF NOT EXISTS quests_active_idx ON quests (status) WHERE status = 'active';

-- Новые источники леджера: награда за квест, реролл, докупка доп. квеста.
ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_source
  CHECK (source IN ('auto','manual_bonus','manual_penalty','convert','payout',
                    'shop_purchase','shop_refund','expiry','release_zero','release_grant',
                    'gacha_spin','gacha_prize','transfer_out','transfer_in','transfer_fee',
                    'quest','quest_reroll','quest_extra'));

-- Активация квестовых наград (были заглушками enabled=false в 124).
UPDATE badge_definitions
   SET enabled = true, criteria = criteria - 'stub',
       description = replace(description, ' Активируется с запуском квестов.', '')
 WHERE key IN ('quest_streak_10','quest_week_all','quest_month_daily');
