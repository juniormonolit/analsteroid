-- 167: движок бустов (задача 51).
--
-- РЕШЕНИЯ, НА КОТОРЫХ ВСЁ ДЕРЖИТСЯ (SHOP_CATALOG_DRAFT §4–§5-бис, владелец
-- 06.08.2026):
--
-- 1. **Буст множит ТОЛЬКО XP и не трогает MLT вообще.** Любой множитель на MLT
--    печатает валюту, а буст обязан её вымывать. Владелец дословно: «бустер на
--    рейтинговые награды надо убирать, иначе 31 числа включил и получил дохуя
--    MLT». Поэтому в этой миграции нет ни одного поля про деньги.
-- 2. **Личные бусты — ЗАРЯДЫ, командные — ЧАСЫ.** Разница не произвольная, она
--    из статистики: у медианного менеджера суточный буст сгорает вхолостую в
--    54 % случаев, а узкий («на повторные») — в 79 %. Заряд же тратится только
--    когда событие произошло, пустышка невозможна. У отдела из 3 человек шанс
--    дня без продаж всего 16 %, там окно работает честно и даёт РОПу
--    тактический ход «сегодня давим».
-- 3. **Множитель фиксируется в момент начисления.** `xp_ledger` пересчитывается
--    ЦЕЛИКОМ каждым тиком (DELETE + INSERT). Если применять буст «по факту на
--    момент пересчёта», вчерашние события завтра пересчитаются уже без буста и
--    XP молча уедет вниз. Поэтому расход заряда — строка в `boost_consumptions`
--    с зафиксированной прибавкой, ровно как `price_at_award` у наград.
--
-- СИСТЕМНАЯ БД (YC). 07.08.2026 применена ТОЛЬКО НА DEV (junibaseone).
-- DOWN: ALTER TABLE xp_ledger DROP COLUMN boost_xp;
--   DROP TABLE boost_consumptions, active_boosts;

-- Ось буста — на какие события он действует. Свободный текст `boost_metric` в
-- shop_items остаётся как есть (его правит форма магазина), а здесь список
-- закрыт: движок обязан понимать каждое значение, иначе буст молча не сработает.
CREATE TABLE IF NOT EXISTS active_boosts (
  id             bigserial PRIMARY KEY,
  bitrix_id      bigint NOT NULL,               -- кто активировал
  dept_key       text,                          -- командный: на какой отдел
  kind           text NOT NULL CHECK (kind IN ('personal','team')),
  axis           text NOT NULL CHECK (axis IN
                   ('repeat','primary','crosssell','big_deal','speed','shipments','all_sales')),
  multiplier     numeric NOT NULL CHECK (multiplier > 1),
  charges_total  int CHECK (charges_total IS NULL OR charges_total > 0),
  charges_left   int CHECK (charges_left IS NULL OR charges_left >= 0),
  activated_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  shop_item_id   int,
  inventory_item_id bigint,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','spent','expired')),
  CONSTRAINT active_boosts_shape CHECK (
    -- Личный — заряды и обязательно свой владелец; командный — окно и отдел.
    (kind = 'personal' AND charges_total IS NOT NULL AND charges_left IS NOT NULL) OR
    (kind = 'team'     AND dept_key IS NOT NULL AND charges_total IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS active_boosts_live_idx
  ON active_boosts (bitrix_id, expires_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS active_boosts_dept_idx
  ON active_boosts (dept_key, expires_at DESC) WHERE status = 'active' AND kind = 'team';

-- Расход буста: одна строка на (буст × сделка). Прибавка ЗАФИКСИРОВАНА — это и
-- есть защита от «пересчитали и XP уехал». Уникальный индекс делает пересчёт
-- идемпотентным: повторный прогон видит уже потраченное и не тратит второй раз.
CREATE TABLE IF NOT EXISTS boost_consumptions (
  id          bigserial PRIMARY KEY,
  boost_id    bigint NOT NULL REFERENCES active_boosts(id) ON DELETE CASCADE,
  deal_id     bigint NOT NULL,
  bitrix_id   bigint NOT NULL,
  base_xp     int NOT NULL,        -- XP сделки без буста, для аудита
  boost_xp    int NOT NULL,        -- сколько буст добавил
  consumed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (boost_id, deal_id)
);
CREATE INDEX IF NOT EXISTS boost_consumptions_deal_idx ON boost_consumptions (deal_id, bitrix_id);

-- Бустовая прибавка живёт отдельным полем (решение владельца): уровень и титул
-- считаются по ПОЛНОМУ XP (буст должен ощущаться), а рейтинги — по ЧИСТОМУ,
-- иначе таблицу лидеров выигрывает не тот, кто продал, а тот, кто купил.
-- В `total_xp` прибавка ВКЛЮЧЕНА: так все существующие читатели уровня
-- продолжают работать без правок, а рейтингам достаточно вычесть boost_xp.
ALTER TABLE xp_ledger ADD COLUMN IF NOT EXISTS boost_xp int NOT NULL DEFAULT 0;

-- Заряды личного буста задаются товаром. `boost_window_days` (миграция 139)
-- остаётся сроком годности: для личного это 7 дней «на израсходовать», для
-- командного — длительность самого окна.
ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS boost_charges int
  CHECK (boost_charges IS NULL OR boost_charges > 0);
