-- Ветки скиллов: 10 веток × 5 ступеней (задачи 2997/2998, решения владельца
-- 06.08.2026, обоснование — PROGRESSION_IDEAS.md §5-бис и §5-тер).
--
-- ЗАМЫСЕЛ. Уровень ветки качается работой + оплачивается MLT; на порогах
-- 2/5/9/14/20 открывается СЛЕДУЮЩАЯ СТУПЕНЬ награды этой ветки — та же награда,
-- но с более высоким порогом и большей ценой. Ротация: пройдя порог, человек
-- перестаёт получать младшую ступень и начинает получать старшую. Железное
-- правило: цена растёт вместе с порогом не медленнее сложности, иначе выгодно
-- сидеть на низком уровне и фармить лёгкое.
--
-- ПОЧЕМУ ОТДЕЛЬНЫЕ ТАБЛИЦЫ, А НЕ tiered=true НА СУЩЕСТВУЮЩИХ НАГРАДАХ.
-- Движок начисления (features/badges/engine/compute.ts) ищет цену по ключу
-- `badge_key:tier ?? '-'`. Если сейчас переключить tiered на существующей
-- награде, движок продолжит писать tier=NULL, цена не найдётся и начисление
-- молча станет НУЛЕВЫМ. Поэтому эта миграция только ОПИСЫВАЕТ структуру веток,
-- ничего не ломая: существующие определения и цены остаются как есть, новые
-- ступени лежат отдельно и включаются движком в задаче 2999.
--
-- СИСТЕМНАЯ БД (YC) — вручную migrations/run_local.mjs, ОТДЕЛЬНО на dev
-- (junibaseone) и на prod (system).
-- DOWN: DROP TABLE skill_branch_steps, skill_branches;
--   DELETE FROM badge_definitions WHERE key IN ('primary_week','shipments_month',
--   'ppp_month','booking_conv_month');

CREATE TABLE IF NOT EXISTS skill_branches (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  emoji       text NOT NULL DEFAULT '⭐',
  description text,
  sort        int  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skill_branch_steps (
  branch_key   text NOT NULL REFERENCES skill_branches(key) ON DELETE CASCADE,
  step         int  NOT NULL CHECK (step BETWEEN 1 AND 5),
  unlock_level int  NOT NULL,
  badge_key    text NOT NULL,
  tier         text NOT NULL,
  threshold    jsonb NOT NULL,
  price        int  NOT NULL CHECK (price > 0),
  PRIMARY KEY (branch_key, step)
);

COMMENT ON TABLE skill_branches IS
  'Ветки прокачки (задача 2998). Уровень ветки — работой + оплатой MLT (цена уровня ≈ 5*n^1.5). Пороги 2/5/9/14/20 открывают ступени наград, см. skill_branch_steps.';
COMMENT ON COLUMN skill_branch_steps.threshold IS
  'Порог ступени — накладывается ПОВЕРХ badge_definitions.criteria одноимённой награды. Пример: {"minRepeats": 8}.';
COMMENT ON COLUMN skill_branch_steps.price IS
  'Цена ступени в MLT. Растёт ×1.8 за ступень — не медленнее, чем растёт порог: прокачка не должна снижать доход.';

INSERT INTO skill_branches (key, name, emoji, description, sort) VALUES
  ('repeat',    'Повторные продажи',      '🔁', 'Клиенты, которые возвращаются к вам снова',          10),
  ('primary',   'Первичные продажи',      '🎯', 'Новые клиенты, купившие впервые',                    20),
  ('shipments', 'Отгрузки',               '🚚', 'Доведение проданного до отгрузки',                   30),
  ('ppp',       'ППП',                    '📈', 'Продажи под потребность: глубина работы с клиентом', 40),
  ('booking',   'Конверсия в бронь',      '📋', 'Умение доводить интерес до брони',                   50),
  ('speed',     'Скорость сделки',        '⚡', 'Сделки, закрытые быстрее медианы группы',            60),
  ('crosssell', 'Кросс-селл',             '🧩', 'Допродажа смежных материалов',                       70),
  ('planning',  'Дисциплина планирования','🗓️', 'Брони, досрочные отгрузки, чистая воронка',          80),
  ('keyclient', 'Ключевые клиенты',       '🔑', 'Портфель крупных постоянных заказчиков',             90),
  ('quests',    'Квесты',                 '✅', 'Регулярное закрытие квестов без пропусков',         100)
ON CONFLICT (key) DO NOTHING;

-- Недостающие оси: наград под них в каталоге нет вообще. Заводим ВЫКЛЮЧЕННЫМИ —
-- начислять их будет движок веток (задача 2999), до него они не должны сработать.
INSERT INTO badge_definitions (key, name, description, icon, category, tiered, criteria, enabled, sort_order)
SELECT v.key, v.name, v.description, v.icon, v.category, false, v.criteria::jsonb, false, v.sort
  FROM (VALUES
    ('primary_week',       'Охотник за новыми', 'Первичные продажи новым клиентам за неделю.',    '🎯', 'repeat',  '{"branch":"primary"}',   210),
    ('shipments_month',    'Грузовой',          'Сумма отгрузок за месяц.',                        '🚚', 'top',     '{"branch":"shipments"}', 220),
    ('ppp_month',          'Глубина',           'ППП за месяц.',                                   '📈', 'record',  '{"branch":"ppp"}',       230),
    ('booking_conv_month', 'Держатель брони',   'Конверсия в бронь за месяц.',                     '📋', 'record',  '{"branch":"booking"}',   240)
  ) AS v(key, name, description, icon, category, criteria, sort)
 WHERE NOT EXISTS (SELECT 1 FROM badge_definitions b WHERE b.key = v.key);

-- Ступени. Пороги открытия — 2/5/9/14/20 уровень ветки; цена ×1.8 за ступень.
INSERT INTO skill_branch_steps (branch_key, step, unlock_level, badge_key, tier, threshold, price) VALUES
  -- Повторные: «Постоянник» — сколько повторов у одного клиента (было minRepeats 3, цена 24)
  ('repeat', 1,  2, 'loyal_client', 's1', '{"minRepeats": 3}',  24),
  ('repeat', 2,  5, 'loyal_client', 's2', '{"minRepeats": 5}',  43),
  ('repeat', 3,  9, 'loyal_client', 's3', '{"minRepeats": 8}',  78),
  ('repeat', 4, 14, 'loyal_client', 's4', '{"minRepeats": 12}', 140),
  ('repeat', 5, 20, 'loyal_client', 's5', '{"minRepeats": 20}', 252),
  -- Первичные: первичных продаж за неделю
  ('primary', 1,  2, 'primary_week', 's1', '{"minCount": 2}',  20),
  ('primary', 2,  5, 'primary_week', 's2', '{"minCount": 4}',  36),
  ('primary', 3,  9, 'primary_week', 's3', '{"minCount": 6}',  65),
  ('primary', 4, 14, 'primary_week', 's4', '{"minCount": 9}',  117),
  ('primary', 5, 20, 'primary_week', 's5', '{"minCount": 13}', 210),
  -- Отгрузки: сумма отгрузок за месяц (₽)
  ('shipments', 1,  2, 'shipments_month', 's1', '{"minAmount": 3000000}',  30),
  ('shipments', 2,  5, 'shipments_month', 's2', '{"minAmount": 6000000}',  54),
  ('shipments', 3,  9, 'shipments_month', 's3', '{"minAmount": 10000000}', 97),
  ('shipments', 4, 14, 'shipments_month', 's4', '{"minAmount": 16000000}', 175),
  ('shipments', 5, 20, 'shipments_month', 's5', '{"minAmount": 25000000}', 315),
  -- ППП за месяц
  ('ppp', 1,  2, 'ppp_month', 's1', '{"minPpp": 15}', 25),
  ('ppp', 2,  5, 'ppp_month', 's2', '{"minPpp": 20}', 45),
  ('ppp', 3,  9, 'ppp_month', 's3', '{"minPpp": 25}', 81),
  ('ppp', 4, 14, 'ppp_month', 's4', '{"minPpp": 30}', 146),
  ('ppp', 5, 20, 'ppp_month', 's5', '{"minPpp": 36}', 262),
  -- Конверсия в бронь за месяц (%)
  ('booking', 1,  2, 'booking_conv_month', 's1', '{"minConv": 20}', 25),
  ('booking', 2,  5, 'booking_conv_month', 's2', '{"minConv": 25}', 45),
  ('booking', 3,  9, 'booking_conv_month', 's3', '{"minConv": 30}', 81),
  ('booking', 4, 14, 'booking_conv_month', 's4', '{"minConv": 35}', 146),
  ('booking', 5, 20, 'booking_conv_month', 's5', '{"minConv": 40}', 262),
  -- Скорость: «Быстрее медианы группы» (было minDeals 3, цена 24)
  ('speed', 1,  2, 'faster_than_median', 's1', '{"minDeals": 3}',  24),
  ('speed', 2,  5, 'faster_than_median', 's2', '{"minDeals": 5}',  43),
  ('speed', 3,  9, 'faster_than_median', 's3', '{"minDeals": 8}',  78),
  ('speed', 4, 14, 'faster_than_median', 's4', '{"minDeals": 12}', 140),
  ('speed', 5, 20, 'faster_than_median', 's5', '{"minDeals": 20}', 252),
  -- Кросс-селл: «Мастер комбо» (было minPairs 5, цена 140 — самая дорогая база каталога)
  ('crosssell', 1,  2, 'combo_master', 's1', '{"minPairs": 5}',  140),
  ('crosssell', 2,  5, 'combo_master', 's2', '{"minPairs": 8}',  238),
  ('crosssell', 3,  9, 'combo_master', 's3', '{"minPairs": 12}', 405),
  ('crosssell', 4, 14, 'combo_master', 's4', '{"minPairs": 18}', 689),
  ('crosssell', 5, 20, 'combo_master', 's5', '{"minPairs": 25}', 1171),
  -- Планирование: «Дисциплина броней» (было 3 брони в неделю, цена 10)
  ('planning', 1,  2, 'planning_discipline', 's1', '{"minBookings": 3}',  10),
  ('planning', 2,  5, 'planning_discipline', 's2', '{"minBookings": 5}',  18),
  ('planning', 3,  9, 'planning_discipline', 's3', '{"minBookings": 8}',  32),
  ('planning', 4, 14, 'planning_discipline', 's4', '{"minBookings": 12}', 58),
  ('planning', 5, 20, 'planning_discipline', 's5', '{"minBookings": 18}', 105),
  -- Ключевые клиенты: «Хранитель ключей» (порог — сколько ключевых в портфеле, цена 21)
  ('keyclient', 1,  2, 'category_keykeeper', 's1', '{"minKeyClients": 3}',  21),
  ('keyclient', 2,  5, 'category_keykeeper', 's2', '{"minKeyClients": 5}',  38),
  ('keyclient', 3,  9, 'category_keykeeper', 's3', '{"minKeyClients": 8}',  68),
  ('keyclient', 4, 14, 'category_keykeeper', 's4', '{"minKeyClients": 12}', 122),
  ('keyclient', 5, 20, 'category_keykeeper', 's5', '{"minKeyClients": 18}', 220),
  -- Квесты: «Квестоман» (было 10 подряд, цена 17)
  ('quests', 1,  2, 'quest_streak_10', 's1', '{"count": 10}',  17),
  ('quests', 2,  5, 'quest_streak_10', 's2', '{"count": 20}',  31),
  ('quests', 3,  9, 'quest_streak_10', 's3', '{"count": 35}',  55),
  ('quests', 4, 14, 'quest_streak_10', 's4', '{"count": 60}',  99),
  ('quests', 5, 20, 'quest_streak_10', 's5', '{"count": 100}', 178)
ON CONFLICT (branch_key, step) DO NOTHING;

-- Цены ступеней дублируются в badge_prices, чтобы движок начисления (который
-- читает ИМЕННО badge_prices по паре ключ+тир) не требовал второго источника
-- правды. skill_branch_steps.price остаётся описанием ветки, badge_prices —
-- рабочей таблицей начисления.
INSERT INTO badge_prices (badge_key, tier, price)
SELECT s.badge_key, s.tier, s.price FROM skill_branch_steps s
 WHERE NOT EXISTS (
   SELECT 1 FROM badge_prices p WHERE p.badge_key = s.badge_key AND p.tier = s.tier);
