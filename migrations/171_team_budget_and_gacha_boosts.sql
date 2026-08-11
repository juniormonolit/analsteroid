-- 171: командный бюджет отдела + цена командных товаров от размера отдела +
-- эпические и легендарные бусты в Колесо фортуны (распоряжение владельца 10.08).
--
-- ── 1. ЦЕНА КОМАНДНЫХ ТОВАРОВ ОТ РАЗМЕРА ОТДЕЛА (SHOP_CATALOG_DRAFT §6) ──────
-- Владелец: «командные должны стоить как-то там по формуле, от количества
-- подчинённых вроде бы». Линейная цена не годится: ценность командного буста
-- честно пропорциональна размеру отдела, но директор с 60 подчинёнными заплатил
-- бы ×60, зарабатывая как один человек, — то есть не купил бы никогда, а РОП
-- тройки покупал бы каждый день. Поэтому СУБЛИНЕЙНАЯ:
--
--     цена = база × (1 + 0,5 × (n − 1)),  n — размер отдела на момент покупки
--
-- 3 человека → ×2, 7 → ×4, 15 → ×8, 60 → ×30,5. Флаг на товаре, а не «все
-- команднoe масштабируем»: пицца-день отдела тоже командная, но её цена от
-- числа людей зависит иначе (там реальный чек), и решать это должен владелец
-- флажком, а не движок догадками.
--
-- ── 2. ОТКУДА У РОПа MLT (§6, открытый вопрос) ──────────────────────────────
-- Проблема была не в цене, а в источнике: руководитель зарабатывает валюту как
-- один человек, а тратить должен на весь отдел. Личный кошелёк этого не
-- выдерживает ни при какой формуле.
--
-- Решение — ОТДЕЛЬНЫЙ КОМАНДНЫЙ БЮДЖЕТ, который наполняется результатами самого
-- отдела: при начислении MLT участнику в бюджет его отдела капает доля
-- (`team_budget_share`, по умолчанию 5 %). Свойства, из-за которых выбрано это,
-- а не «выдать РОПу больше личных MLT»:
--   * источник СВЯЗАН с работой отдела — командный буст покупается на то, что
--     отдел заработал, а не на то, что руководителю выписали;
--   * эмиссия растёт строго пропорционально (5 % сверху), а не отдельной
--     непредсказуемой статьёй;
--   * личные кошельки не задеты: у РОПа не появляется соблазна тратить своё на
--     общее и наоборот;
--   * бюджет НЕЛЬЗЯ вывести в рубли и нельзя перевести человеку — он тратится
--     только на командные позиции. Иначе это была бы просто прибавка к зарплате
--     руководителя.
--
-- ── 3. БУСТЫ В КОЛЕСО ФОРТУНЫ ───────────────────────────────────────────────
-- Владелец: «Пусть будут и там». Эпический и легендарный бусты за MLT не
-- продаются (шкала редкости считается от цены — легендарный обязан был бы
-- стоить треть айфона), поэтому их место именно в колесе и лутдропе.
-- Сумма chance_ppm обязана остаться 1 000 000: добираем из самого частого
-- призового слота (+2 MLT), а не размываем всё подряд.
--
-- СИСТЕМНАЯ БД (YC). 10.08.2026 — применяется на dev (junibaseone) и prod (system).
-- DOWN: DROP TABLE team_budget_ledger, team_budgets;
--   ALTER TABLE shop_items DROP COLUMN price_scales_with_team;
--   DELETE FROM gacha_pool WHERE tier_key IN ('g_boost_epic','g_boost_legend');

ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS price_scales_with_team boolean NOT NULL DEFAULT false;

-- Включаем масштабирование там, где цена — это «на весь отдел» по смыслу:
-- бусты и организационные послабления. Пицца и выезд остаются фиксированными:
-- у них за ценой стоит реальный чек компании, а не размер группы.
UPDATE shop_items SET price_scales_with_team = true
 WHERE category = 'team'
   AND name IN ('Сегодня давим — командный буст', 'Отдел уходит в 17:00 в пятницу',
                'Планёрка отменяется')
   AND NOT price_scales_with_team;
UPDATE shop_items SET price_scales_with_team = true
 WHERE buyer_scope = 'rop_only' AND name = 'Поздний старт всего отдела (+1 час)'
   AND NOT price_scales_with_team;

-- Бюджет отдела. Ключ — тот же department_id, что во всей оргструктуре.
CREATE TABLE IF NOT EXISTS team_budgets (
  dept_key   text PRIMARY KEY,
  balance    numeric NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Движение бюджета. Отдельный леджер, а не badge_coin_ledger: тот привязан к
-- bitrix_id (кошелёк человека), а здесь субъект — отдел. Смешивать их значило
-- бы навсегда испортить все выборки «сколько человек заработал».
CREATE TABLE IF NOT EXISTS team_budget_ledger (
  id         bigserial PRIMARY KEY,
  dept_key   text NOT NULL,
  amount     numeric NOT NULL,          -- + пополнение, − трата
  source     text NOT NULL CHECK (source IN ('share','purchase','manual')),
  bitrix_id  bigint,                    -- кто заработал (share) или купил (purchase)
  shop_item_id int,
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_budget_ledger_dept_idx ON team_budget_ledger (dept_key, created_at DESC);
-- Доля начисляется РОВНО ОДИН РАЗ на строку личного начисления: идемпотентность
-- пересчёта наград держится на этом индексе, а не на «надеюсь, не задвоится».
ALTER TABLE team_budget_ledger ADD COLUMN IF NOT EXISTS coin_ledger_id bigint;
CREATE UNIQUE INDEX IF NOT EXISTS team_budget_ledger_share_uniq
  ON team_budget_ledger (coin_ledger_id) WHERE source = 'share';

ALTER TABLE badge_coin_settings ADD COLUMN IF NOT EXISTS team_budget_share numeric NOT NULL DEFAULT 0.05
  CHECK (team_budget_share >= 0 AND team_budget_share <= 1);
COMMENT ON COLUMN badge_coin_settings.team_budget_share IS
  'Доля личного начисления MLT, капающая в бюджет ОТДЕЛА (задача 10.08). Источник командных покупок РОПа: тратится только на командные позиции, в рубли не выводится и человеку не переводится.';

-- ── Колесо фортуны: два буста ────────────────────────────────────────────────
INSERT INTO gacha_pool (tier_key, name, icon, rarity, prize_type, shop_item_id, chance_ppm, enabled, sort)
SELECT 'g_boost_epic', 'Буст «Второе дыхание» (+150 % XP)', '🌟', 'rare', 'item', s.id, 3000, true, 85
  FROM shop_items s WHERE s.name = 'Второе дыхание (эпик)'
   AND NOT EXISTS (SELECT 1 FROM gacha_pool WHERE tier_key = 'g_boost_epic');

INSERT INTO gacha_pool (tier_key, name, icon, rarity, prize_type, shop_item_id, chance_ppm, enabled, sort)
SELECT 'g_boost_legend', 'Буст «Звёздный час» (×3 XP)', '☄️', 'jackpot', 'item', s.id, 400, true, 88
  FROM shop_items s WHERE s.name = 'Звёздный час (легенда)'
   AND NOT EXISTS (SELECT 1 FROM gacha_pool WHERE tier_key = 'g_boost_legend');

-- Сумма шансов обязана остаться 1 000 000 — вычитаем добавленное из «+2 MLT».
UPDATE gacha_pool SET chance_ppm = chance_ppm - (
  SELECT coalesce(sum(chance_ppm), 0) FROM gacha_pool WHERE tier_key IN ('g_boost_epic','g_boost_legend')
) WHERE tier_key = 'g_eball_2'
  AND (SELECT sum(chance_ppm) FROM gacha_pool) > 1000000;
