-- 169: рандомайзер косметики профиля за MLT (задача 63, п.1).
--
-- Владелец 06.08.2026: «Фоны, шапки и рамки предлагаю сделать там рандомайзер,
-- генерирующий за MLT. <…> Надо раскачать идею».
-- Владелец 07.08.2026 про «свою картинку в шапку»: «нахуй» — значит хранилища
-- изображений и модерации в этой задаче нет вовсе, и это упрощает всё.
--
-- ЧТО ХРАНИМ. Только сид и факт прокрута. Внешний вид считается из сида
-- функцией (`lib/profile/generated.ts`), поэтому в БД нет ни CSS, ни картинок,
-- а чужой профиль рисуется по одному тексту в `profile_cosmetics.frame_id`.
--
-- ТРИ ОГРАНИЧИТЕЛЯ, БЕЗ КОТОРЫХ МЕХАНИКА ОБЕСЦЕНИВАЕТСЯ (заложены сразу, как и
-- договаривались в бэклоге: «по сути это вторая гача»):
--   1. цена прокрута — иначе это не трата, а кнопка;
--   2. лимит прокрутов в день — иначе человек крутит до посинения в поисках
--      «того самого» варианта, и уникальность превращается в шум;
--   3. закрепление — понравившийся вариант остаётся навсегда, незакреплённые
--      прошлые прокруты вытесняются новыми. Без закрепления единственной
--      стратегией был бы «крутить, пока не выпадет идеальное», а это и есть
--      бесконечный прокрут из пункта 2.
--
-- СИСТЕМНАЯ БД (YC). 07.08.2026 применена ТОЛЬКО НА DEV (junibaseone).
-- DOWN: DROP TABLE profile_generated_cosmetics; вернуть chk_ledger_source из 167.

CREATE TABLE IF NOT EXISTS profile_generated_cosmetics (
  id           bigserial PRIMARY KEY,
  bitrix_id    integer NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('frame','background','cover')),
  cosmetic_id  text NOT NULL,        -- gen-frame-7f3a91 — из него же считается вид
  pinned       boolean NOT NULL DEFAULT false,
  price_paid   int NOT NULL CHECK (price_paid >= 0),
  ledger_id    bigint REFERENCES badge_coin_ledger(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bitrix_id, cosmetic_id)
);
CREATE INDEX IF NOT EXISTS profile_generated_mine_idx
  ON profile_generated_cosmetics (bitrix_id, kind, created_at DESC);

-- Настройки рандомайзера — рядом с остальной экономикой, а не константами в
-- коде: цену и лимит владелец будет крутить, и пересборка ради этого не нужна.
CREATE TABLE IF NOT EXISTS cosmetic_randomizer_settings (
  id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  roll_price     int NOT NULL DEFAULT 40  CHECK (roll_price >= 0),
  rolls_per_day  int NOT NULL DEFAULT 5   CHECK (rolls_per_day > 0),
  keep_unpinned  int NOT NULL DEFAULT 6   CHECK (keep_unpinned > 0),
  pin_price      int NOT NULL DEFAULT 100 CHECK (pin_price >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cosmetic_randomizer_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_source
  CHECK (source IN ('auto','manual_bonus','manual_penalty','convert','payout',
                    'shop_purchase','shop_refund','expiry','release_zero','release_grant',
                    'gacha_spin','gacha_prize','transfer_out','transfer_in','transfer_fee',
                    'quest','quest_reroll','quest_extra',
                    'contract_deposit','contract_deposit_return','contract_deposit_burn',
                    'cosmetic_purchase','skill_level_up','cosmetic_roll','cosmetic_pin'));

COMMENT ON TABLE profile_generated_cosmetics IS
  'Прокруты рандомайзера косметики. Вид считается из cosmetic_id (сид), в БД только факт и закрепление.';
