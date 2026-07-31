-- TTL ебаллов (задача Арнольда/Серёги 31.07): начисления EBALL живут
-- badge_coin_settings.ttl_months (дефолт 6 мес — согласован), затем сгорают
-- ночным тиком записью source='expiry'. РУБЛИ (currency='RUB') НЕ сгорают.
-- СИСТЕМНАЯ БД (YC, dbname=system) — применяется вручную migrations/run_system.mjs.
--
-- ── Схема FIFO: колонка remaining на положительных EBALL-записях леджера ──────
-- Каждая положительная EBALL-запись = «лот». remaining лота — сколько из него
-- ещё не потрачено. Все EBALL-списания (магазин, штрафы, вывод и пр.) гасят лоты
-- строго FIFO (по created_at, id). remaining ПОЛНОСТЬЮ ВЫВОДИМ из леджера:
--   remaining = clamp(cum_i − D, 0, amount_i),
-- где cum_i — накопленная сумма положительных лотов юзера по порядку, D — сумма
-- всех его EBALL-списаний. Пересчёт — один UPDATE с оконной функцией
-- (recomputeFifoRemaining в features/badges/engine/wallet.ts), идемпотентный,
-- вызывается после каждой мутации леджера и в ночном тике. Отдельная таблица
-- лотов не нужна: объёмы ~7 тыс. строк, O(1 UPDATE) на весь леджер, и колонка
-- не может разъехаться с историей — её всегда можно пересчитать с нуля.
-- Долг (баланс в минусе от штрафов): лоты гасятся до нуля, излишек списаний
-- просто держит SUM(amount) < 0 — вьюха балансов это отражает сама.
--
-- Вьюха балансов НЕ меняется: SUM(amount) WHERE currency='EBALL'. Инвариант
-- «баланс = сумма живых остатков» держится тем, что сгоревшие остатки закрыты
-- явными минус-записями 'expiry' (SUM(amount) = SUM(remaining) при балансе ≥ 0).
-- Все потребители (полка, рейтинг, магазин, конвертация, ручные операции)
-- читают вьюху — живые остатки видят все.
--
-- ── Релизный старт (дополнение Серёги 31.07, МЕХАНИЗМ ЗАЛОЖЕН, НЕ ЗАПУЩЕН) ──
-- На публичном релизе: ретро-награды (полки) остаются, EBALL-балансы выравниваются
-- нулём (source='release_zero' на минус-баланс каждого) и всем активным менеджерам
-- начисляется одинаковый старт (source='release_grant', дефолт 3000, параметр).
-- Одноразовость — release_started_at IS NULL; повторный запуск отбивается API.
-- RUB и badge_awards не трогаются. Кнопка в Настройки → Награды (двойное
-- подтверждение), НЕ нажималась.
-- DOWN: ALTER TABLE badge_coin_ledger DROP COLUMN remaining;
--       ALTER TABLE badge_coin_settings DROP COLUMN ttl_months, DROP COLUMN release_started_at;
--       вернуть chk_ledger_source из 118.

ALTER TABLE badge_coin_settings
  ADD COLUMN IF NOT EXISTS ttl_months int NOT NULL DEFAULT 6 CHECK (ttl_months > 0),
  ADD COLUMN IF NOT EXISTS release_started_at timestamptz;

ALTER TABLE badge_coin_ledger
  ADD COLUMN IF NOT EXISTS remaining int;

ALTER TABLE badge_coin_ledger DROP CONSTRAINT IF EXISTS chk_ledger_source;
ALTER TABLE badge_coin_ledger
  ADD CONSTRAINT chk_ledger_source
  CHECK (source IN ('auto','manual_bonus','manual_penalty','convert','payout',
                    'shop_purchase','shop_refund','expiry','release_zero','release_grant'));

-- Сгорание и остатки ищутся по положительным EBALL-лотам — частичный индекс.
CREATE INDEX IF NOT EXISTS idx_ledger_eball_lots
  ON badge_coin_ledger (bitrix_id, created_at, id)
  WHERE currency = 'EBALL' AND amount > 0;

-- Первичный расчёт remaining (та же формула, что в recomputeFifoRemaining).
WITH deb AS (
  SELECT bitrix_id, coalesce(sum(-amount), 0)::bigint AS d
    FROM badge_coin_ledger WHERE currency = 'EBALL' AND amount < 0 GROUP BY 1
),
pos AS (
  SELECT id, bitrix_id, amount,
         sum(amount) OVER (PARTITION BY bitrix_id ORDER BY created_at, id) AS cum
    FROM badge_coin_ledger WHERE currency = 'EBALL' AND amount > 0
)
UPDATE badge_coin_ledger l
   SET remaining = greatest(0, least(l.amount, p.cum - coalesce(deb.d, 0)))::int
  FROM pos p
  LEFT JOIN deb ON deb.bitrix_id = p.bitrix_id
 WHERE l.id = p.id
   AND l.remaining IS DISTINCT FROM greatest(0, least(l.amount, p.cum - coalesce(deb.d, 0)))::int;
