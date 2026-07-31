-- Пакет Серёги 31.07 (после гачи): переводы ебаллов между менеджерами,
-- подарки предметов инвентаря, уведомления в ЛК (+пуши ботом «Аналитик» —
-- Bitrix24 imbot BOT_ID 20761, lib/bitrix/notify.ts, DIALOG_ID=bitrix_user_id).
-- СИСТЕМНАЯ БД (YC, dbname=system) — применяется вручную migrations/run_system.mjs.
--
-- Перевод: отправитель платит X, получатель получает X−комиссия; комиссия
-- (transfer_fee_percent, дефолт 5%) СЖИГАЕТСЯ отдельной записью-синком
-- 'transfer_fee' (в выписке видна строкой). Пара связана link_id. Дневной
-- лимит переводов (сумма исходящих X за МСК-сутки) — transfer_daily_limit,
-- дефолт 500 (= цена отгула; больше — уже не «подарок коллеге», а канал
-- перекачки балансов). Списания — FIFO, как любая трата EBALL.
-- Подарок предмета: смена bitrix_id с СОХРАНЕНИЕМ expires_at, без комиссии,
-- история переходов в gift_history (jsonb-массив {from,fromName,at}).
-- DOWN: DROP TABLE notifications; ALTER TABLE inventory_items DROP COLUMN gift_history;
--       ALTER TABLE badge_coin_settings DROP COLUMN transfer_fee_percent, DROP COLUMN transfer_daily_limit;
--       вернуть chk_ledger_source из 120.

ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_source
  CHECK (source IN ('auto','manual_bonus','manual_penalty','convert','payout',
                    'shop_purchase','shop_refund','expiry','release_zero','release_grant',
                    'gacha_spin','gacha_prize','transfer_out','transfer_in','transfer_fee'));

ALTER TABLE badge_coin_settings
  ADD COLUMN IF NOT EXISTS transfer_fee_percent numeric NOT NULL DEFAULT 5
    CHECK (transfer_fee_percent >= 0 AND transfer_fee_percent <= 100),
  ADD COLUMN IF NOT EXISTS transfer_daily_limit int NOT NULL DEFAULT 500 CHECK (transfer_daily_limit > 0);

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS gift_history jsonb NOT NULL DEFAULT '[]';

-- Уведомления ЛК: колокольчик со счётчиком непрочитанных. type: transfer_in /
-- gift_in / activation_resolved / payout_resolved / expiry_soon / gacha_rare /
-- gacha_jackpot. link — относительный путь в приложении.
CREATE TABLE IF NOT EXISTS notifications (
  id         bigserial PRIMARY KEY,
  bitrix_id  integer NOT NULL,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_mgr ON notifications (bitrix_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (bitrix_id) WHERE read_at IS NULL;
