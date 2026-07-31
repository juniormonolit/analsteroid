-- Внутренняя валюта за награды («ебаллы»), задача 2657 (правка Серёги 31.07).
-- СИСТЕМНАЯ БД (YC, dbname=system) — применяется вручную migrations/run_system.mjs.
-- Решение по ценам: НЕ колонка в badge_definitions, а таблица badge_prices по
-- (badge_key, tier) — у tiered-наград цена зависит от уровня (бронза≠платина).
-- tier='-' для наград без уровней (та же нормализация NULL, что в uq_badge_awards).
-- Леджер: одно начисление на награду (badge_award_id UNIQUE) — идемпотентность
-- ретро/ночных прогонов; изменение цены в настройках НЕ переоценивает прошлое.
-- DOWN: DROP VIEW badge_coin_balances; DROP TABLE badge_coin_ledger, badge_prices, badge_coin_settings;

CREATE TABLE IF NOT EXISTS badge_prices (
  badge_key  text NOT NULL REFERENCES badge_definitions(key) ON DELETE CASCADE,
  tier       text NOT NULL DEFAULT '-',   -- bronze|silver|gold|platinum|'-'
  price      int  NOT NULL CHECK (price >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (badge_key, tier)
);

-- Глобальные настройки валюты (одна строка). Дефолт названия — «ебаллы»
-- (решение Серёги 31.07), переименовывается в «Настройки → Награды».
CREATE TABLE IF NOT EXISTS badge_coin_settings (
  id            int  PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  currency_name text NOT NULL DEFAULT 'ебаллы',
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO badge_coin_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS badge_coin_ledger (
  id             bigserial PRIMARY KEY,
  bitrix_id      integer NOT NULL,
  badge_award_id bigint  NOT NULL UNIQUE REFERENCES badge_awards(id) ON DELETE CASCADE,
  amount         int     NOT NULL,
  price_at_award int     NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_badge_coin_ledger_mgr ON badge_coin_ledger (bitrix_id);

-- Баланс = SUM по леджеру (материализация вьюхой; объёмы малы — live-агрегат).
CREATE OR REPLACE VIEW badge_coin_balances AS
  SELECT bitrix_id, sum(amount)::bigint AS balance
    FROM badge_coin_ledger GROUP BY bitrix_id;

-- ── Первичные цены ИЗ ДАННЫХ (идемпотентно, ON CONFLICT DO NOTHING) ──────────
-- Формула: обратно пропорционально фактической частоте выдачи, лог-шкала:
--   price_raw = 5 * 100 ^ ( ln(max_n / n) / ln(max_n / min_n) )
-- т.е. самая частая награда (max_n выдач) → 5, самая редкая (min_n) → 500,
-- остальные — по логарифму отношения частот (иначе линейная обратная пропорция
-- сплющила бы всё, кроме уникальных, в минимум). Затем «красивое» округление:
-- <20 → кратно 5, <100 → кратно 10, ≥100 → кратно 25; кламп [5..500].
-- Комбинации (награда × уровень) без единой выдачи — 500 (редчайшее = дорогое).
WITH counts AS (
  SELECT badge_key, coalesce(tier, '-') AS tier, count(*)::float8 AS n
    FROM badge_awards GROUP BY 1, 2
),
bounds AS (SELECT max(n) AS maxn, min(n) AS minn FROM counts),
combos AS (
  SELECT d.key AS badge_key, t.tier
    FROM badge_definitions d
   CROSS JOIN LATERAL unnest(
     CASE WHEN d.tiered THEN ARRAY['bronze','silver','gold','platinum'] ELSE ARRAY['-'] END
   ) AS t(tier)
),
raw AS (
  SELECT cb.badge_key, cb.tier,
         CASE WHEN c.n IS NULL THEN 500::float8
              WHEN b.maxn <= b.minn THEN 50::float8
              ELSE 5 * power(100, ln(b.maxn / c.n) / ln(b.maxn / b.minn))
         END AS p
    FROM combos cb
    LEFT JOIN counts c USING (badge_key, tier)
   CROSS JOIN bounds b
)
INSERT INTO badge_prices (badge_key, tier, price)
SELECT badge_key, tier,
       greatest(5, least(500,
         CASE WHEN p < 20  THEN round(p / 5)  * 5
              WHEN p < 100 THEN round(p / 10) * 10
              ELSE              round(p / 25) * 25
         END))::int
  FROM raw
ON CONFLICT (badge_key, tier) DO NOTHING;
