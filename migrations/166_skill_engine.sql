-- 166: движок дерева скиллов — цены, семантика ступеней, уровни (задача 49).
--
-- Владелец 07.08.2026: «Цены ставь как чувствуешь, поменяем если что потом.
-- Мы пока что строим концепт, ошибиться с ними не страшно».
--
-- ── 1. Цены ступеней ×0,25 ───────────────────────────────────────────────────
-- Замер 07.08 (WORKLOG): четыре новые оси на пересчитанных порогах печатали
-- ~9 900 MLT/мес на входе и ~24 700 при полной прокачке, против июльской
-- эмиссии 47 963 и потолка 60 000. Срез вчетверо ставит полную прокачку всех
-- десяти веток примерно в 10 % потолка.
-- Множитель ОДИН на все ступени — это важно: правило «прокачка не должна
-- снижать доход» держится на ОТНОШЕНИИ цен соседних ступеней (×1,8), а
-- равномерное масштабирование отношения не трогает.
--
-- ── 2. Семантика ступеней двух осей приведена к тому, что реально считается ──
-- Пороги миграции 159 писались под предполагаемое поведение наград:
--   * `planning_discipline` — порог был `{"minBookings": 3}`, но награда не про
--     количество броней вообще: она за НЕДЕЛЮ, где все активные брони получили
--     исходящий звонок (`planningBadges.ts`). Число броней там ни при чём.
--     Честная лесенка для такой награды — недели подряд: 1 / 2 / 4 / 6 / 10.
--   * `quest_streak_10` — ступени хотят 10 / 20 / 35 / 60 / 100 подряд, а
--     `questTick` считал серии по 10 (`run % 10 === 0`) и длину серии не знал.
--     Пороги оставляем, движок научен считать САМУЮ ДЛИННУЮ серию (см. код).
--
-- ── 3. Уровни веток ──────────────────────────────────────────────────────────
-- Уровень нельзя купить целиком (PROGRESSION_IDEAS §5-бис): нужны и события
-- нужного типа (заработал), и оплата MLT (вложил). Прогресс ветки — сколько
-- наград этой ветки человек получил; цена уровня n = 5·n^1,5. Откат уровня
-- невозможен по замыслу, поэтому DELETE по таблице не предусмотрен.
--
-- СИСТЕМНАЯ БД (YC). 07.08.2026 применена ТОЛЬКО НА DEV (junibaseone).
-- DOWN: восстановить цены из skill_branch_steps_backup_166;
--   DROP TABLE skill_level_ups, skill_levels.

CREATE TABLE IF NOT EXISTS skill_branch_steps_backup_166 AS
  SELECT * FROM skill_branch_steps WHERE false;
INSERT INTO skill_branch_steps_backup_166
  SELECT * FROM skill_branch_steps
   WHERE NOT EXISTS (SELECT 1 FROM skill_branch_steps_backup_166);

UPDATE skill_branch_steps SET price = GREATEST(1, round(price * 0.25)::int);

-- Дисциплина планирования: недели подряд, а не количество броней.
UPDATE skill_branch_steps SET threshold = '{"minStreakWeeks": 1}'  WHERE branch_key='planning' AND step=1;
UPDATE skill_branch_steps SET threshold = '{"minStreakWeeks": 2}'  WHERE branch_key='planning' AND step=2;
UPDATE skill_branch_steps SET threshold = '{"minStreakWeeks": 4}'  WHERE branch_key='planning' AND step=3;
UPDATE skill_branch_steps SET threshold = '{"minStreakWeeks": 6}'  WHERE branch_key='planning' AND step=4;
UPDATE skill_branch_steps SET threshold = '{"minStreakWeeks": 10}' WHERE branch_key='planning' AND step=5;

-- badge_prices — рабочая таблица начисления, держим в согласии со ступенями.
UPDATE badge_prices p SET price = s.price, updated_at = now()
  FROM skill_branch_steps s
 WHERE p.badge_key = s.badge_key AND p.tier = s.tier AND p.price <> s.price;

-- ── уровни веток у менеджера ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_levels (
  bitrix_id  bigint NOT NULL,
  branch_key text   NOT NULL REFERENCES skill_branches(key) ON DELETE CASCADE,
  level      int    NOT NULL DEFAULT 0 CHECK (level >= 0 AND level <= 20),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bitrix_id, branch_key)
);

-- Каждая покупка уровня — строка аудита со ссылкой на списание в леджере.
CREATE TABLE IF NOT EXISTS skill_level_ups (
  id             bigserial PRIMARY KEY,
  bitrix_id      bigint NOT NULL,
  branch_key     text   NOT NULL,
  level          int    NOT NULL CHECK (level >= 1),
  price          int    NOT NULL CHECK (price >= 0),
  progress_at_up int    NOT NULL,          -- сколько наград ветки было на момент покупки
  coin_ledger_id bigint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bitrix_id, branch_key, level)    -- один уровень покупается один раз
);
CREATE INDEX IF NOT EXISTS skill_level_ups_mgr_idx ON skill_level_ups (bitrix_id, created_at DESC);

-- Списание MLT за уровень ветки — новый источник в леджере.
ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_source
  CHECK (source IN ('auto','manual_bonus','manual_penalty','convert','payout',
                    'shop_purchase','shop_refund','expiry','release_zero','release_grant',
                    'gacha_spin','gacha_prize','transfer_out','transfer_in','transfer_fee',
                    'quest','quest_reroll','quest_extra',
                    'contract_deposit','contract_deposit_return','contract_deposit_burn',
                    'skill_level_up'));

-- Четыре оси, заведённые выключенными миграцией 159, включает движок веток —
-- теперь он есть, поэтому включаем.
UPDATE badge_definitions SET enabled = true
 WHERE key IN ('primary_week','shipments_month','ppp_month','booking_conv_month');
