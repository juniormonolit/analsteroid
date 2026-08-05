-- Категория «Командные товары» (решение владельца 05.08): пицца на отдел,
-- командные бусты и прочее «на всех». Ключевая правка смысла: покупать
-- командное МОЖЕТ КТО УГОДНО («не вижу смысла запрещать покупать командные
-- бусты кому угодно. Просто они будут в разделе командные товары») — то есть
-- ограничение buyer_scope='rop_only' перестаёт быть способом «спрятать
-- командное», оно остаётся отдельной, редко нужной настройкой доступа.
--
-- Существующие rop_only-позиции НЕ трогаем автоматически: какие из них должны
-- стать общими командными, решает владелец в «Настройки → Магазин».
--
-- СИСТЕМНАЯ БД (YC) — применяется вручную migrations/run_system.mjs, ОТДЕЛЬНО
-- на dev (junibaseone) и на prod (system).
-- DOWN: ALTER TABLE shop_items DROP CONSTRAINT shop_items_category_check;
--       ALTER TABLE shop_items ADD CONSTRAINT shop_items_category_check
--         CHECK (category IN ('material','immaterial','boost'));
--       ПЕРЕД этим перевести строки category='team' в другую категорию.

ALTER TABLE shop_items DROP CONSTRAINT IF EXISTS shop_items_category_check;
ALTER TABLE shop_items ADD CONSTRAINT shop_items_category_check
  CHECK (category IN ('material', 'immaterial', 'boost', 'team'));

COMMENT ON COLUMN shop_items.category IS
  'material — вещь; immaterial — привилегия (отгул, поздний старт); boost — множитель; team — командное (пицца на отдел, командные бусты): покупать может любой, это НЕ ограничение доступа, а полка витрины.';
