-- Курс MLT → рубли (решение владельца 05.08: «7.5 ₽ за 1 MLT… вынеси курс вообще
-- в настройки»). Нужен, чтобы админ на дашборде видел ФАКТИЧЕСКУЮ стоимость
-- геймификации в рублях: сколько роздано, сколько на руках, сколько реально
-- потрачено.
--
-- ВАЖНО: это НЕ rub_to_eball_rate из миграции 116. Тот курс — про обмен
-- рублёвого кошелька сотрудника на MLT (внутренняя операция сотрудника).
-- Здесь — оценочная стоимость единицы MLT для КОМПАНИИ, база для сметы затрат
-- и будущего авторасчёта цены товара из себестоимости (price_mlt = cost_rub / rate).
--
-- СИСТЕМНАЯ БД (YC) — вручную через migrations/run_system.mjs, ОТДЕЛЬНО на dev
-- (junibaseone) и prod (system).
-- DOWN: ALTER TABLE badge_coin_settings DROP COLUMN mlt_rub_rate;

ALTER TABLE badge_coin_settings
  ADD COLUMN IF NOT EXISTS mlt_rub_rate numeric NOT NULL DEFAULT 7.5
    CHECK (mlt_rub_rate > 0);

COMMENT ON COLUMN badge_coin_settings.mlt_rub_rate IS
  'Сколько рублей стоит 1 MLT для компании (решение владельца: 7.5). База для рублёвой сметы на дашборде и авторасчёта цены товара из себестоимости. НЕ путать с rub_to_eball_rate — тот про обмен рублёвого кошелька сотрудника.';
