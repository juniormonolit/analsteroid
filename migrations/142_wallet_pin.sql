-- БД: YC system (прод) / junibaseone (дев) — НЕ analytics, НЕ sa.
-- Пин-код на денежные операции (задача #2995), спека:
-- owners-inbox/monolitika-pin-code-spec.md (ревизия 2, автор Глеб, AppSec).
--
-- ВАЖНО (порядок выката, спека §1 и §9): эта миграция применяется ТОЛЬКО
-- после того, как PIN_PEPPER выкачен в env процесса и процесс перезапущен.
-- Без перца фича не включается — lib/auth/pin.ts проверяет process.env.PIN_PEPPER
-- на старте и отключает все пин-эндпоинты, если его нет.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS pin_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS pin_source text,
  ADD COLUMN IF NOT EXISTS pin_fail_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_lock_level smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS pin_freeze_until timestamptz,
  ADD COLUMN IF NOT EXISTS pin_threshold_mlt smallint NOT NULL DEFAULT 30;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_users_pin_source
    CHECK (pin_source IS NULL OR pin_source IN ('self','admin_reset'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_users_pin_threshold
    CHECK (pin_threshold_mlt BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_users_pin_lock_level
    CHECK (pin_lock_level BETWEEN 0 AND 3);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Журнал операций с пином (спека §7). Полный разбор спора «я этого не
-- покупал» за один запрос: строка выписки -> событие -> время/IP/UA/поверхность/
-- порог. НИКОГДА не хранит сам пин/хеш/перец.
CREATE TABLE IF NOT EXISTS wallet_pin_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bitrix_id integer,
  event text NOT NULL CHECK (event IN (
    'set','change','reset_by_admin','threshold_change','verify_ok','verify_fail','locked'
  )),
  operation text,
  target_ref text,
  amount integer,
  currency text CHECK (currency IS NULL OR currency IN ('EBALL','RUB')),
  threshold_before smallint,
  threshold_after smallint,
  surface text CHECK (surface IS NULL OR surface IN ('web','bx_iframe','pwa')),
  ip inet,
  user_agent text,
  actor_login text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_pin_events_user ON wallet_pin_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_pin_events_bitrix ON wallet_pin_events (bitrix_id, created_at DESC);

-- Связка с денежными записями (спека §7): каждая денежная строка либо
-- ссылается на конкретную успешную проверку пина, либо (для операций под
-- личным порогом) остаётся NULL — и тогда сама эта NULL-запись видна в
-- разборе спора как «прошла без пина под порогом на тот момент».
ALTER TABLE badge_coin_ledger ADD COLUMN IF NOT EXISTS pin_event_id bigint REFERENCES wallet_pin_events(id);
ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS pin_event_id bigint REFERENCES wallet_pin_events(id);

CREATE INDEX IF NOT EXISTS idx_badge_coin_ledger_pin_event ON badge_coin_ledger (pin_event_id) WHERE pin_event_id IS NOT NULL;

-- Второй слой защиты (спека §3): правило по SOURCE, а не по эндпоинту —
-- страхует будущие фичи (складчина, бусты и т.п.), которые забудут подключить
-- пин на уровне API. transfer_fee сознательно НЕ в списке — она наследует
-- подтверждение через link_id на исходную transfer_out запись (та же операция).
CREATE OR REPLACE FUNCTION trg_badge_coin_ledger_require_pin() RETURNS trigger AS $$
BEGIN
  IF NEW.pin_event_id IS NULL THEN
    IF NEW.source IN ('transfer_out','convert','payout','manual_penalty','manual_bonus') THEN
      RAISE EXCEPTION 'wallet pin: pin_event_id required for source=%', NEW.source;
    END IF;
    IF NEW.source = 'shop_purchase' AND NEW.currency = 'RUB' THEN
      RAISE EXCEPTION 'wallet pin: pin_event_id required for RUB shop_purchase';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_require_pin ON badge_coin_ledger;
CREATE TRIGGER trg_ledger_require_pin
  BEFORE INSERT ON badge_coin_ledger
  FOR EACH ROW EXECUTE FUNCTION trg_badge_coin_ledger_require_pin();

COMMIT;
