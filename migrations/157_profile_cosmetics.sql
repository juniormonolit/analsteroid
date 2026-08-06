-- Персонализация профиля: рамки аватара и эмодзи-фоны за MLT (задача #34,
-- список владельца по ЛК-соцсетке от 05.08 — последний невыполненный пункт).
--
-- Каталог косметики живёт В КОДЕ (lib/profile/cosmetics.ts) — как у обложек
-- профиля (миграция 149): рамки и фоны генеративные, чистый CSS, ни картинок,
-- ни модерации, ни веса. БД хранит только «кто чем владеет» и «что надето».
--
-- Почему НЕ через shop_items/inventory_items, хотя магазин уже есть:
--   * inventory_items.expires_at NOT NULL и вся механика вокруг TTL/активации/
--     возврата 50% — про расходуемые блага (отгул, мерч). Косметика вечная,
--     и «истекшая рамка» ничего не значит;
--   * иначе каждую новую рамку админу пришлось бы заводить строкой в магазине,
--     хотя она уже описана в коде.
-- Деньги при этом остаются в ЕДИНОМ источнике правды: списание пишется в
-- badge_coin_ledger (source='cosmetic_purchase'), поэтому дашборд экономики
-- видит эти траты наравне с магазинными, а не мимо кассы.
--
-- СИСТЕМНАЯ БД (YC), вручную, ОТДЕЛЬНО на dev (junibaseone) и prod (system):
--   с ноутбука: node migrations/run_local.mjs migrations/157_profile_cosmetics.sql
--   с сервера:  node migrations/run_system.mjs migrations/157_profile_cosmetics.sql
-- DOWN: DROP TABLE profile_cosmetics_owned, profile_cosmetics; вернуть
--       chk_ledger_source из 126.

-- Что куплено. Цена — снимком на момент покупки: ребаланс экономики не должен
-- задним числом менять историю (то же правило, что у наград и магазина).
CREATE TABLE IF NOT EXISTS profile_cosmetics_owned (
  bitrix_id    integer     NOT NULL,
  cosmetic_id  text        NOT NULL,          -- id из каталога lib/profile/cosmetics.ts
  price_paid   int         NOT NULL CHECK (price_paid >= 0),
  ledger_id    bigint      REFERENCES badge_coin_ledger(id),
  purchased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bitrix_id, cosmetic_id)        -- дважды одно и то же не купить
);

-- Что надето сейчас. NULL = ничего (аватар без рамки / фон по умолчанию).
CREATE TABLE IF NOT EXISTS profile_cosmetics (
  bitrix_id     integer     PRIMARY KEY,
  frame_id      text,
  background_id text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Новый источник траты в леджере.
ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_source
  CHECK (source IN ('auto','manual_bonus','manual_penalty','convert','payout',
                    'shop_purchase','shop_refund','expiry','release_zero','release_grant',
                    'gacha_spin','gacha_prize','transfer_out','transfer_in','transfer_fee',
                    'quest','quest_reroll','quest_extra',
                    'contract_deposit','contract_deposit_return','contract_deposit_burn',
                    'cosmetic_purchase'));

COMMENT ON TABLE profile_cosmetics_owned IS
  'Купленная косметика профиля (рамки, эмодзи-фоны). Каталог — в коде, lib/profile/cosmetics.ts.';
COMMENT ON TABLE profile_cosmetics IS
  'Что надето: frame_id/background_id из каталога. NULL — ничего не надето.';
