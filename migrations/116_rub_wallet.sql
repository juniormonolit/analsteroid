-- Двухвалютная система (доп. Серёги 31.07): второй кошелёк — РУБЛИ.
-- СИСТЕМНАЯ БД (YC, dbname=system) — применяется вручную migrations/run_system.mjs.
--
-- Менеджеры привыкли к «брони+продажи = +500 ₽», поэтому денежные ежедневные
-- бонусы начисляются в рублях (currency='RUB'), геймификация — в ебаллах.
-- Конвертация ТОЛЬКО RUB → EBALL (по курсу из настроек); обратной операции нет
-- ни в API, ни в движке. Вывод рублей в ЗП — заявкой payout_requests, фактическая
-- выплата бухгалтерией вне системы, у нас фиксация и списание по статусу paid.
--
-- ВАЖНО (индексация магазина): индекс считается ТОЛЬКО по ебалльному контуру
-- (currency='EBALL' и source='auto'); рублёвый контур и ручные операции в индекс
-- НЕ входят (см. owners-inbox/monolitika-eball-indexation.md).
-- DOWN: DROP VIEW badge_rub_balances; ALTER TABLE badge_coin_ledger DROP COLUMN currency,
--       DROP COLUMN link_id, DROP COLUMN payout_request_id; DROP TABLE payout_requests;
--       ALTER TABLE badge_coin_settings DROP COLUMN rub_to_eball_rate;
--       + вернуть badge_coin_balances без WHERE currency.

ALTER TABLE badge_coin_ledger
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'EBALL',
  ADD COLUMN IF NOT EXISTS link_id bigint REFERENCES badge_coin_ledger(id);

DO $$ BEGIN
  ALTER TABLE badge_coin_ledger
    ADD CONSTRAINT chk_ledger_currency CHECK (currency IN ('EBALL','RUB'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- source расширяется: convert (пара связанных записей −RUB/+EBALL через link_id)
-- и payout (списание рублей по выплаченной заявке).
ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_source
  CHECK (source IN ('auto','manual_bonus','manual_penalty','convert','payout'));

ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_award_by_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_award_by_source
  CHECK ((source = 'auto') = (badge_award_id IS NOT NULL));

-- Заявки на вывод рублей в ЗП.
CREATE TABLE IF NOT EXISTS payout_requests (
  id             bigserial PRIMARY KEY,
  bitrix_id      integer NOT NULL,
  amount         int NOT NULL CHECK (amount > 0),
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','paid','rejected')),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolver_login text,
  comment        text
);
CREATE INDEX IF NOT EXISTS idx_payout_requests_mgr ON payout_requests (bitrix_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_requests_status ON payout_requests (status);

ALTER TABLE badge_coin_ledger
  ADD COLUMN IF NOT EXISTS payout_request_id bigint REFERENCES payout_requests(id);

-- Курс конвертации RUB → EBALL (дефолт 1 ₽ = 1 ебалл).
ALTER TABLE badge_coin_settings
  ADD COLUMN IF NOT EXISTS rub_to_eball_rate numeric NOT NULL DEFAULT 1 CHECK (rub_to_eball_rate > 0);

-- Балансы: ебалльная вьюха становится валютно-чистой (существующие записи по
-- дефолту EBALL — поведение прежних потребителей не меняется), плюс рублёвая.
CREATE OR REPLACE VIEW badge_coin_balances AS
  SELECT bitrix_id, sum(amount)::bigint AS balance
    FROM badge_coin_ledger WHERE currency = 'EBALL' GROUP BY bitrix_id;

CREATE OR REPLACE VIEW badge_rub_balances AS
  SELECT bitrix_id, sum(amount)::bigint AS balance
    FROM badge_coin_ledger WHERE currency = 'RUB' GROUP BY bitrix_id;
