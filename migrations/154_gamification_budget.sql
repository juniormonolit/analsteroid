-- Месячный бюджет геймификации (запрос владельца 06.08: «делай счётчик»).
-- Админ задаёт потолок в рублях, дашборд показывает, сколько из него уже
-- «напечатано» эмиссией за текущий месяц и прогноз до конца месяца — чтобы
-- добавление наград и квестов перестало быть игрой вслепую.
--
-- Дефолт 175 000 ₽ — середина названного владельцем коридора 150–200 тыс.
-- СИСТЕМНАЯ БД (YC), вручную через migrations/run_system.mjs, ОТДЕЛЬНО на dev
-- (junibaseone) и prod (system).
-- DOWN: ALTER TABLE badge_coin_settings DROP COLUMN monthly_budget_rub;

ALTER TABLE badge_coin_settings
  ADD COLUMN IF NOT EXISTS monthly_budget_rub numeric NOT NULL DEFAULT 175000
    CHECK (monthly_budget_rub >= 0);

COMMENT ON COLUMN badge_coin_settings.monthly_budget_rub IS
  'Месячный потолок расходов на геймификацию в рублях. Сравнивается с ЭМИССИЕЙ месяца × mlt_rub_rate: каждый начисленный балл — обещание, которое рано или поздно придут обменивать.';
