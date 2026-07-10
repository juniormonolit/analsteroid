-- Карточка менеджера v2 (owners-inbox бриф от 10.07): веса скоринга 6 осей паутины,
-- настраиваются супер-админом в /settings/scoring-weights. Singleton-таблица —
-- тот же паттерн, что plan_settings (миграция 016/050).
--
-- Оси = AXIS_DEFS в features/manager-card/engine/managerCard.ts (порядок и ключи
-- зафиксированы там же, ключи колонок совпадают буквально с AxisKey):
--   cr_deal_to_reservation, cr_reservation_to_sale, sales_amount, avg_check,
--   touch_speed, refusal_rate.
-- Шкала 0-10 (не проценты) — совпадает с UI-слайдерами (0-10, шаг 1), сумма
-- НЕ обязана быть 10: нормировка (деление на сумму) происходит в коде при чтении
-- (lib/settings/scoringWeights.ts), значит абсолютные числа могут быть любыми
-- неотрицательными; ставить все 0 бессмысленно — код фолбэкает на равные веса.
-- Дефолт = все по 5 (равные веса, эквивалентно текущему невзвешенному среднему,
-- см. WORKLOG задачи «Карточка менеджера v2» — не регрессит рейтинг существующей
-- карточки v1 сразу после наката).
--
-- БД: YC system. НЕ применять локально — накатывает Артём на проде атомарно.

CREATE TABLE IF NOT EXISTS scoring_weights (
  id INT PRIMARY KEY DEFAULT 1,
  cr_deal_to_reservation NUMERIC NOT NULL DEFAULT 5,
  cr_reservation_to_sale NUMERIC NOT NULL DEFAULT 5,
  sales_amount NUMERIC NOT NULL DEFAULT 5,
  avg_check NUMERIC NOT NULL DEFAULT 5,
  touch_speed NUMERIC NOT NULL DEFAULT 5,
  refusal_rate NUMERIC NOT NULL DEFAULT 5,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT scoring_weights_single_row CHECK (id = 1)
);

INSERT INTO scoring_weights (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
