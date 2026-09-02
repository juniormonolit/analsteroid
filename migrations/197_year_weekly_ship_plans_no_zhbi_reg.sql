-- Миграция 197: планы отгрузок СПБ без «СПБ (НЦ ЖБИ-рег)»
-- БД: YC system. Накат:
--   node migrations/run_local.mjs migrations/197_year_weekly_ship_plans_no_zhbi_reg.sql
--
-- Владелец 02.09 (вечер): «ЖБИ-рег — не учитываем. Как и стажёров и ЮЛ».
-- В 196 строка листа «СПБ (НЦ ЖБИ-рег)» (115 млн/год) входила в план «Нулевого
-- СПБ» и «СПБ ИТОГО». Здесь оба пересчитаны без неё:
--   Нулевой СПБ = «СПБ (НЦ)» + «СПБ (НЦ Металл)» + «СПБ (НЦ ЖБИ)»
--   СПБ ИТОГО   = «СПБ (ОС)» + Нулевой СПБ
-- Факты приведены в yearWeekly.ts тем же уточнением (СПБ ИТОГО без Департамента
-- ЮЛ, МСК ИТОГО = ОС + НЦ + ЖБИ без «Стажеров МСК»). Повторный накат безопасен.

INSERT INTO year_weekly_plans (year, month, entity_key, metric, value) VALUES
  (2026, 1, 'spb_nc', 'ship_sum', 32639510.03),
  (2026, 1, 'spb_total', 'ship_sum', 86536761.36),
  (2026, 2, 'spb_nc', 'ship_sum', 43947474.88),
  (2026, 2, 'spb_total', 'ship_sum', 110966298.21),
  (2026, 3, 'spb_nc', 'ship_sum', 43849103.89),
  (2026, 3, 'spb_total', 'ship_sum', 132177208.22),
  (2026, 4, 'spb_nc', 'ship_sum', 53599437.41),
  (2026, 4, 'spb_total', 'ship_sum', 148972544.74),
  (2026, 5, 'spb_nc', 'ship_sum', 78413107.56),
  (2026, 5, 'spb_total', 'ship_sum', 195219303.86),
  (2026, 6, 'spb_nc', 'ship_sum', 75582627.01),
  (2026, 6, 'spb_total', 'ship_sum', 208766761.31),
  (2026, 7, 'spb_nc', 'ship_sum', 87061686.77),
  (2026, 7, 'spb_total', 'ship_sum', 234322607.07),
  (2026, 8, 'spb_nc', 'ship_sum', 85072281.99),
  (2026, 8, 'spb_total', 'ship_sum', 238297913.29),
  (2026, 9, 'spb_nc', 'ship_sum', 114282592.25),
  (2026, 9, 'spb_total', 'ship_sum', 273657447.55),
  (2026, 10, 'spb_nc', 'ship_sum', 90334605.21),
  (2026, 10, 'spb_total', 'ship_sum', 231523501.51),
  (2026, 11, 'spb_nc', 'ship_sum', 80472429.46),
  (2026, 11, 'spb_total', 'ship_sum', 190904708.76),
  (2026, 12, 'spb_nc', 'ship_sum', 58358262.61),
  (2026, 12, 'spb_total', 'ship_sum', 153674600.94)
ON CONFLICT (year, month, entity_key, metric) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

SELECT month, value::bigint AS spb_total FROM year_weekly_plans
WHERE year = 2026 AND metric = 'ship_sum' AND entity_key = 'spb_total' ORDER BY month;
