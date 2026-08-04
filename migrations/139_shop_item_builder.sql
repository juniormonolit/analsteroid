-- «Заполнятор товаров» — конструктор карточек магазина/бустов (задача 2960,
-- ТЗ Серёги 04.08): эмодзи вместо фото (изображений НЕ храним нигде), тип
-- позиции (материальный/нематериальный/буст — заменяет часть смысла старого
-- category='team'), минимальный уровень покупки (редкость считается ОТ него,
-- см. features/shop/engine/rarity.ts), ссылка на маркетплейс «для примера»,
-- кто может покупать (все/только РОП — новая замена смысла category='team'),
-- лимит на человека, обязательность подтверждения руководителя при активации,
-- поля буста. MLT — единственная валюта покупки (правка владельца «всё
-- продаётся только в MLT»).
-- СИСТЕМНАЯ БД (YC) — применяется вручную migrations/run_system.mjs,
-- ОТДЕЛЬНО на dev (junibaseone) и на prod (system) — это НЕ одна и та же БД
-- (см. devops.md, инцидент 03.08 #2825).
-- DOWN: ALTER TABLE shop_items DROP COLUMN emoji, min_level, marketplace_url,
--   buyer_scope, per_person_limit, per_person_limit_days, requires_approval,
--   boost_metric, boost_multiplier, boost_window_days, boost_scope;
--   вернуть shop_items_category_check из 118 (material/immaterial/team) —
--   ПЕРЕД этим вручную решить, что делать со строками category='boost'
--   (в 118/120 такого значения не было).

ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS emoji                 text NOT NULL DEFAULT '🎁',
  ADD COLUMN IF NOT EXISTS min_level              int  NOT NULL DEFAULT 0 CHECK (min_level >= 0),
  ADD COLUMN IF NOT EXISTS marketplace_url        text,
  ADD COLUMN IF NOT EXISTS buyer_scope            text NOT NULL DEFAULT 'all'
                                                     CHECK (buyer_scope IN ('all','rop_only')),
  ADD COLUMN IF NOT EXISTS per_person_limit       int CHECK (per_person_limit IS NULL OR per_person_limit > 0),
  ADD COLUMN IF NOT EXISTS per_person_limit_days  int CHECK (per_person_limit_days IS NULL OR per_person_limit_days > 0),
  ADD COLUMN IF NOT EXISTS requires_approval      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS boost_metric           text,
  ADD COLUMN IF NOT EXISTS boost_multiplier       numeric CHECK (boost_multiplier IS NULL OR boost_multiplier > 0),
  ADD COLUMN IF NOT EXISTS boost_window_days      int CHECK (boost_window_days IS NULL OR boost_window_days > 0),
  ADD COLUMN IF NOT EXISTS boost_scope            text;

COMMENT ON COLUMN shop_items.min_level IS
  'Мин. уровень XP (features/xp/engine/xp.ts levelFromXp) для покупки — редкость считается ОТ него автоматически, features/shop/engine/rarity.ts. Шкала обоснована прогоном 04.08 по xp_ledger: медиана 195 менеджеров=4, p90=24, max=44.';
COMMENT ON COLUMN shop_items.buyer_scope IS
  'all — видно и доступно всем; rop_only — только РОП/директор (sa.org_resolved_hierarchy). Замена смысла бывшего category=''team''.';
COMMENT ON COLUMN shop_items.requires_approval IS
  'true (дефолт) — активация идёт через заявку руководителю, как раньше у ВСЕХ позиций; false — activation сразу used, без ручного шага (задел для мгновенных цифровых позиций).';

-- «Тип позиции» — раньше это была та же колонка category (material/immaterial/
-- team). ТЗ владельца называет ровно 3 типа (материальный приз / нематериальный /
-- буст) — «командные» это ДОСТУП (buyer_scope), а не тип: переносим смысл туда,
-- сам тип решаем по факту содержимого существующих 3 строк.
UPDATE shop_items SET buyer_scope = 'rop_only' WHERE category = 'team';
UPDATE shop_items SET category = 'material'   WHERE category = 'team' AND name = 'Пицца-день отдела';
UPDATE shop_items SET category = 'immaterial' WHERE category = 'team';

ALTER TABLE shop_items DROP CONSTRAINT IF EXISTS shop_items_category_check;
ALTER TABLE shop_items
  ADD CONSTRAINT shop_items_category_check CHECK (category IN ('material','immaterial','boost'));

-- MLT — единственная валюта покупки (правка владельца 04.08). Колонки
-- allowed_currencies/inventory_items.currency НЕ дропаем (задел на будущее,
-- и это то, чем помечены уже купленные предметы) — просто лишаем каталог
-- RUB-опции: на 04.08 подтверждено, что ни одной покупки за живые деньги/RUB
-- в inventory_items нет (все 16 существующих строк — EBALL, price_paid=1,
-- призы гачи), так что это безопасная чистка, не переписывающая историю.
UPDATE shop_items SET allowed_currencies = '{EBALL}' WHERE allowed_currencies @> ARRAY['RUB']::text[];

-- Эмодзи вместо плейсхолдерных описаний — для существующих 16 позиций (Серёга
-- заменит на свой вкус через форму; тут только чтобы каталог не был сплошь 🎁).
UPDATE shop_items SET emoji = '🏷️' WHERE name = 'Титул / кастомная рамка бейджа на месяц';
UPDATE shop_items SET emoji = '🕙' WHERE name IN ('Поздний старт +2 часа', 'Поздний старт всего отдела (+1 час)');
UPDATE shop_items SET emoji = '🧹' WHERE name = 'Сброс мёртвых сделок';
UPDATE shop_items SET emoji = '⚡' WHERE name = 'Приоритет распределения лидов на 1 день';
UPDATE shop_items SET emoji = '🏖️' WHERE name = 'Отгул (полный оплачиваемый день)';
UPDATE shop_items SET emoji = '☕' WHERE name IN ('Термокружка', 'Кофе за счёт компании');
UPDATE shop_items SET emoji = '🎧' WHERE name = 'Наушники беспроводные';
UPDATE shop_items SET emoji = '🪑' WHERE name = 'Рабочее кресло';
UPDATE shop_items SET emoji = '🖥️' WHERE name = 'Монитор';
UPDATE shop_items SET emoji = '📱' WHERE name IN ('Смартфон', 'iPhone (актуальный)');
UPDATE shop_items SET emoji = '🍕' WHERE name = 'Пицца-день отдела';
UPDATE shop_items SET emoji = '🎉' WHERE name = 'Тимбилдинг / выезд отдела';
