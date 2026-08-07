-- Антифарм: товар из магазина может блокировать награду (задача 2997).
--
-- ПРОБЛЕМА. «Почистить хвосты» и «Сброс мёртвых сделок» снимают зависшие сделки.
-- Награда `clean_week` платит MLT за неделю без просроченных сделок, а её
-- знаменатель — сделки, живые на этой неделе (`fetchDealLifecycles`: закрытой
-- считается та, у которой проставлен sold/delivered/lost). Снятые по товару
-- сделки перестают быть просроченными → человек покупает чистку за MLT и
-- получает за неё награду в MLT. Петля самофинансирования.
--
-- ПОЧЕМУ БЛОКИРОВКА, А НЕ ПОМЕТКА КАЖДОЙ СДЕЛКИ. Чистка происходит руками РОПа
-- в Битриксе, и система принципиально не знает, КАКИЕ именно сделки сняты «по
-- купону», а какие в обычном порядке. Заставлять РОПа перечислять id сделок —
-- значит получить пустые списки и ложное чувство контроля. Зато мы достоверно
-- знаем ДРУГОЕ: человек купил чистку и когда её активировали. Этого достаточно,
-- чтобы не платить ему за чистоту воронки в том же окне.
--
-- ОБОБЩЕНИЕ. Делаем не частный случай, а поле в конструкторе товара: любой товар
-- может объявить, какую награду и на сколько дней он глушит. Появится следующий
-- товар с таким же конфликтом — админ настроит его сам, без миграции.
--
-- СИСТЕМНАЯ БД (YC). 06.08.2026 применена ТОЛЬКО НА DEV (junibaseone).
-- DOWN: DROP TABLE badge_award_blocks;
--   ALTER TABLE shop_items DROP COLUMN blocks_badge_key, DROP COLUMN blocks_days;

ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS blocks_badge_key text,
  ADD COLUMN IF NOT EXISTS blocks_days      int CHECK (blocks_days IS NULL OR blocks_days > 0);

COMMENT ON COLUMN shop_items.blocks_badge_key IS
  'Ключ награды, которую этот товар глушит на blocks_days дней после активации. Антифарм: товар, облегчающий условие награды, не должен приносить эту награду (задача 2997).';

CREATE TABLE IF NOT EXISTS badge_award_blocks (
  id                serial PRIMARY KEY,
  bitrix_id         int  NOT NULL,
  badge_key         text NOT NULL,
  blocked_from      date NOT NULL,
  blocked_to        date NOT NULL,
  reason            text,
  inventory_item_id int,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (blocked_to >= blocked_from)
);
CREATE INDEX IF NOT EXISTS badge_award_blocks_lookup
  ON badge_award_blocks (badge_key, bitrix_id, blocked_from, blocked_to);

COMMENT ON TABLE badge_award_blocks IS
  'Окна, в которые конкретному человеку не начисляется конкретная награда. Пишется при активации товара с blocks_badge_key. Движок пересчёта (features/badges/engine/compute.ts) отбрасывает награды, период которых пересекается с окном.';

-- Четыре товара-чистильщика: глушат «Чистую воронку» на 8 недель после
-- активации. 56 дней = 8 недельных окон награды: снятая сделка перестаёт быть
-- просроченной не только в неделю снятия, но и во все последующие, пока не
-- истечёт её собственная отсечка по товарной группе.
UPDATE shop_items SET blocks_badge_key = 'clean_week', blocks_days = 56
 WHERE name IN ('Почистить хвосты ×5', 'Почистить хвосты ×10', 'Почистить хвосты ×20',
                'Сброс мёртвых сделок');

-- Теперь антифарм есть — можно включать обратно (заводились выключенными
-- миграцией 158 именно до этого момента).
UPDATE shop_items SET enabled = true
 WHERE name IN ('Почистить хвосты ×5', 'Почистить хвосты ×10', 'Почистить хвосты ×20',
                'Сброс мёртвых сделок');
