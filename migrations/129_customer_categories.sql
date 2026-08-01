-- 129: Категории клиентов «Моих заказчиков» (дополнение Серёги 01.08).
-- Именные категории вместо абстрактных RFM-скоров; правила читаемые, пороги
-- редактируются в «Настройки → Категории клиентов» (superadmin). Категория
-- считается на лету поверх кэша движка (classifyCategory) — правка порога
-- действует сразу, без пересчёта кэша.
--
-- Дефолты (распределение по живой базе 01.08, 190 222 клиента):
--   ключевой (отгрузок >=2 И сумма отгрузок >=5 млн — правило Серёги, фикс) — 26;
--   крупный (сумма отгрузок >=1,5 млн ИЛИ отгрузок >=5) — 551;
--   постоянный (2+ покупки по sold_at — текущее постоянничество списка) — 3 868;
--   разовый — 19 802; остальное — потенциальные (есть активные) / прочие.
-- Отгрузки = delivered_at (как «покупка» в отчёте «Повторные»), покупки списка =
-- sold_at (как в «Моих заказчиках») — осознанно две шкалы, как в самих отчётах.
--
-- DOWN:
--   DROP TABLE IF EXISTS customer_category_settings;

CREATE TABLE IF NOT EXISTS customer_category_settings (
  id int PRIMARY KEY CHECK (id = 1),
  key_min_shipments int NOT NULL DEFAULT 2,          -- «Ключевой»: отгрузок >=
  key_min_sum numeric NOT NULL DEFAULT 5000000,      -- … И сумма отгрузок >=
  large_min_sum numeric NOT NULL DEFAULT 1500000,    -- «Крупный»: сумма отгрузок >= ИЛИ
  large_min_shipments int NOT NULL DEFAULT 5,        -- … отгрузок >=
  complex_min_groups int NOT NULL DEFAULT 3,         -- модификатор «комплексный»: разных head-групп в отгрузках >=
  frequent_factor numeric NOT NULL DEFAULT 0.5,      -- «частый»: свой цикл < factor × медианы базы (16 дн)
  fading_factor numeric NOT NULL DEFAULT 2,          -- «затухающий»: текущий/последний интервал > factor × среднего
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

INSERT INTO customer_category_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
