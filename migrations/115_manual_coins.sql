-- Ручные поощрения/штрафы валютой (доп. Серёги 31.07 к 2657).
-- СИСТЕМНАЯ БД (YC, dbname=system) — применяется вручную migrations/run_system.mjs.
--
-- Леджер расширяется source'ом: 'auto' — начисления движка наград (badge_award_id
-- NOT NULL для них, уникальность одна-награда=одна-транзакция сохраняется UNIQUE
-- индексом по badge_award_id, NULL'ы ручных он не ловит), 'manual_bonus' /
-- 'manual_penalty' — ручные операции руководителей (badge_award_id NULL, суммы
-- со знаком: штраф отрицательный). Баланс = SUM(amount) по ВСЕМ source
-- (вьюха badge_coin_balances не меняется, может уходить в минус).
--
-- ВАЖНО (будущая индексация цен магазина): при расчёте индекса/эмиссии наград
-- учитывать ТОЛЬКО source='auto' — ручные поощрения/штрафы в индекс НЕ входят.
--
-- Сторно: отмена ошибочной ручной операции — НЕ удаление, а компенсирующая
-- запись с reversal_of = id исходной (в выписке видно «отмена операции от даты»).
-- DOWN: ALTER TABLE badge_coin_ledger DROP COLUMN source, DROP COLUMN actor_bitrix_id,
--       DROP COLUMN actor_login, DROP COLUMN comment, DROP COLUMN penalty_type_id,
--       DROP COLUMN reversal_of; DROP TABLE penalty_types;
--       ALTER TABLE badge_coin_settings DROP COLUMN monthly_bonus_budget;

-- Справочник штрафов (админ ведёт в настройках; менеджерам виден read-only).
-- price_mode='fixed' — price в валюте; 'percent' — price = процент от НАКОПЛЕННОГО
-- баланса менеджера на момент операции (прогрессивный штраф для особых косяков);
-- рассчитанная сумма ФИКСИРУЕТСЯ в леджере абсолютным числом и не пересчитывается.
CREATE TABLE IF NOT EXISTS penalty_types (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  price      int  NOT NULL CHECK (price > 0),   -- фикс-сумма ИЛИ процент (по price_mode)
  price_mode text NOT NULL DEFAULT 'fixed' CHECK (price_mode IN ('fixed','percent')),
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_penalty_percent CHECK (price_mode <> 'percent' OR price <= 100)
);

ALTER TABLE badge_coin_ledger
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS actor_bitrix_id integer,
  ADD COLUMN IF NOT EXISTS actor_login text,
  ADD COLUMN IF NOT EXISTS comment text,
  ADD COLUMN IF NOT EXISTS penalty_type_id bigint REFERENCES penalty_types(id),
  ADD COLUMN IF NOT EXISTS reversal_of bigint REFERENCES badge_coin_ledger(id);

DO $$ BEGIN
  ALTER TABLE badge_coin_ledger
    ADD CONSTRAINT chk_ledger_source CHECK (source IN ('auto','manual_bonus','manual_penalty'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- auto-строки обязаны ссылаться на награду; ручные — наоборот, без неё.
DO $$ BEGIN
  ALTER TABLE badge_coin_ledger
    ADD CONSTRAINT chk_ledger_award_by_source
    CHECK ((source = 'auto') = (badge_award_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_badge_coin_ledger_source ON badge_coin_ledger (source, created_at DESC);

-- Месячный бюджет поощрений на руководителя (0 = без лимита). Штрафы без лимита.
ALTER TABLE badge_coin_settings
  ADD COLUMN IF NOT EXISTS monthly_bonus_budget int NOT NULL DEFAULT 2000 CHECK (monthly_bonus_budget >= 0);
