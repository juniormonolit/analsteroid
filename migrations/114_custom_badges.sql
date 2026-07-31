-- Конструктор наград, этап 2 (задача Серёги): кастомные определения в
-- badge_definitions (key с префиксом custom_, criteria.template = тип шаблона).
-- СИСТЕМНАЯ БД (YC, dbname=system) — применяется вручную migrations/run_system.mjs.
--
-- Принцип леджера при УДАЛЕНИИ кастомной награды: определение и её награды
-- удаляются (FK badge_awards → definitions CASCADE), но начисленные «ебаллы»
-- НЕ отзываются — ссылка леджера на награду становится NULL (SET NULL вместо
-- прежнего CASCADE), баланс менеджера не меняется. Для аудита в леджер
-- добавляется снимок badge_key (заполняется при начислении и бэкфиллится).
-- DOWN: ALTER TABLE badge_coin_ledger DROP COLUMN badge_key;
--       ALTER TABLE badge_coin_ledger ALTER COLUMN badge_award_id SET NOT NULL;
--       + вернуть FK ON DELETE CASCADE.

ALTER TABLE badge_coin_ledger ADD COLUMN IF NOT EXISTS badge_key text;

UPDATE badge_coin_ledger l
   SET badge_key = a.badge_key
  FROM badge_awards a
 WHERE a.id = l.badge_award_id AND l.badge_key IS NULL;

ALTER TABLE badge_coin_ledger ALTER COLUMN badge_award_id DROP NOT NULL;

ALTER TABLE badge_coin_ledger
  DROP CONSTRAINT IF EXISTS badge_coin_ledger_badge_award_id_fkey;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT badge_coin_ledger_badge_award_id_fkey
  FOREIGN KEY (badge_award_id) REFERENCES badge_awards(id) ON DELETE SET NULL;
