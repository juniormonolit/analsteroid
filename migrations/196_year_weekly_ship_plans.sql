-- Миграция 196: месячные планы ОТГРУЗОК 2026 по сущностям «Данных по годам»
-- БД: YC system. Накат:
--   node migrations/run_local.mjs migrations/196_year_weekly_ship_plans.sql
--
-- Владелец 02.09: «планы отгрузок на 2026 год берём с листа "Основной"
-- [файл «2026 Декомпозиция (Основная).xlsx», лист «Общая»]. Плановые показатели
-- сильно отличаются». До этого план отгрузок отчёта = Σ manager_plans менеджеров
-- сущности ÷ 4 в неделю — три расхождения с листом: (1) у Краснодара в августе
-- планов менеджеров нет вовсе (0 против 21,8 млн); (2) «Нулевой СПБ» суммировал
-- планы ВСЕХ менеджеров Департамента НЦ, а в листе строка «СПБ (НЦ)» — только
-- нерудка (Металл/ЖБИ/ЖБИ-рег — отдельными строками); (3) «÷ 4 × число недель
-- блока» в 5-недельных месяцах (апрель, июль, октябрь, декабрь) давало ИТОГО
-- план = 125 % месячного.
--
-- Сопоставление строк листа с сущностями (по структуре листа: подстроки
-- складываются в ИТОГО — проверено на всех 12 месяцах):
--   СПБ ИТОГО   = «ИТОГО (СПБ)»           Общестрой СПБ = «СПБ (ОС)»
--   Нулевой СПБ = «СПБ (НЦ)» + «СПБ (НЦ Металл)» + «СПБ (НЦ ЖБИ)» + «СПБ (НЦ ЖБИ-рег)»
--   Нерудка СПБ = «СПБ (НЦ)»              ЖБИ СПБ = «СПБ (НЦ ЖБИ)»   Металл СПБ = «СПБ (НЦ Металл)»
--   МСК ИТОГО   = «ИТОГО (МСК)»           ОС МСК = «МСК (ОС)»
--   НЦ МСК      = «МСК (НЦ)» + «МСК (НЦ Металл)»   ЖБИ МСК = «МСК (ЖБИ)»
--   Краснодар   = «ИТОГО (КРД)»
-- Открытый вопрос владельцу: «СПБ (НЦ ЖБИ-рег)» (115 млн/год) учтён в Нулевом
-- и в СПБ ИТОГО, но НЕ в «ЖБИ СПБ» — если ЖБИ-рег сидит в «Отделе ЖБИ», его
-- надо добавить туда (одна UPDATE-строка).
--
-- Движок (yearWeekly.ts): при наличии metric='ship_sum' план отгрузок берётся
-- отсюда, иначе — прежний путь через manager_plans. Неделя = месяц ÷ число
-- ISO-недель месяца (4 или 5), чтобы ИТОГО план месяца был РОВНО месячным.
-- Повторный накат безопасен (ON CONFLICT DO UPDATE).

ALTER TABLE year_weekly_plans DROP CONSTRAINT IF EXISTS year_weekly_plans_metric_check;
ALTER TABLE year_weekly_plans ADD CONSTRAINT year_weekly_plans_metric_check
  CHECK (metric IN ('deals', 'cr_sale', 'cr_ship', 'avg_check', 'ship_sum'));

INSERT INTO year_weekly_plans (year, month, entity_key, metric, value) VALUES
  (2026, 1, 'spb_total', 'ship_sum', 87536761.36),
  (2026, 2, 'spb_total', 'ship_sum', 113966298.2),
  (2026, 3, 'spb_total', 'ship_sum', 135177208.2),
  (2026, 4, 'spb_total', 'ship_sum', 157472537.7),
  (2026, 5, 'spb_total', 'ship_sum', 207719296.9),
  (2026, 6, 'spb_total', 'ship_sum', 221266762.3),
  (2026, 7, 'spb_total', 'ship_sum', 246822608.1),
  (2026, 8, 'spb_total', 'ship_sum', 250797914.3),
  (2026, 9, 'spb_total', 'ship_sum', 286157448.6),
  (2026, 10, 'spb_total', 'ship_sum', 244023502.5),
  (2026, 11, 'spb_total', 'ship_sum', 203404709.8),
  (2026, 12, 'spb_total', 'ship_sum', 166174601.9),
  (2026, 1, 'spb_os', 'ship_sum', 53897251.33),
  (2026, 2, 'spb_os', 'ship_sum', 67018823.33),
  (2026, 3, 'spb_os', 'ship_sum', 88328104.33),
  (2026, 4, 'spb_os', 'ship_sum', 95373107.33),
  (2026, 5, 'spb_os', 'ship_sum', 116806196.3),
  (2026, 6, 'spb_os', 'ship_sum', 133184134.3),
  (2026, 7, 'spb_os', 'ship_sum', 147260920.3),
  (2026, 8, 'spb_os', 'ship_sum', 153225631.3),
  (2026, 9, 'spb_os', 'ship_sum', 159374855.3),
  (2026, 10, 'spb_os', 'ship_sum', 141188896.3),
  (2026, 11, 'spb_os', 'ship_sum', 110432279.3),
  (2026, 12, 'spb_os', 'ship_sum', 95316338.33),
  (2026, 1, 'spb_nc', 'ship_sum', 33639510.03),
  (2026, 2, 'spb_nc', 'ship_sum', 46947474.88),
  (2026, 3, 'spb_nc', 'ship_sum', 46849103.89),
  (2026, 4, 'spb_nc', 'ship_sum', 62099430.41),
  (2026, 5, 'spb_nc', 'ship_sum', 90913100.56),
  (2026, 6, 'spb_nc', 'ship_sum', 88082628.01),
  (2026, 7, 'spb_nc', 'ship_sum', 99561687.77),
  (2026, 8, 'spb_nc', 'ship_sum', 97572282.99),
  (2026, 9, 'spb_nc', 'ship_sum', 126782593.25),
  (2026, 10, 'spb_nc', 'ship_sum', 102834606.21),
  (2026, 11, 'spb_nc', 'ship_sum', 92972430.46),
  (2026, 12, 'spb_nc', 'ship_sum', 70858263.61),
  (2026, 1, 'spb_nerudka', 'ship_sum', 9341134.55),
  (2026, 2, 'spb_nerudka', 'ship_sum', 10335716.8),
  (2026, 3, 'spb_nerudka', 'ship_sum', 10736595.4),
  (2026, 4, 'spb_nerudka', 'ship_sum', 15325493.9),
  (2026, 5, 'spb_nerudka', 'ship_sum', 29886660.5),
  (2026, 6, 'spb_nerudka', 'ship_sum', 29707796.35),
  (2026, 7, 'spb_nerudka', 'ship_sum', 38701323.4),
  (2026, 8, 'spb_nerudka', 'ship_sum', 39880867.6),
  (2026, 9, 'spb_nerudka', 'ship_sum', 54095920.4),
  (2026, 10, 'spb_nerudka', 'ship_sum', 39099878.8),
  (2026, 11, 'spb_nerudka', 'ship_sum', 32290189.92),
  (2026, 12, 'spb_nerudka', 'ship_sum', 22388945.92),
  (2026, 1, 'spb_zhbi', 'ship_sum', 18288711.48),
  (2026, 2, 'spb_zhbi', 'ship_sum', 25663860.68),
  (2026, 3, 'spb_zhbi', 'ship_sum', 21895676.69),
  (2026, 4, 'spb_zhbi', 'ship_sum', 24182354.91),
  (2026, 5, 'spb_zhbi', 'ship_sum', 31160063.46),
  (2026, 6, 'spb_zhbi', 'ship_sum', 27586683.06),
  (2026, 7, 'spb_zhbi', 'ship_sum', 28361353.17),
  (2026, 8, 'spb_zhbi', 'ship_sum', 25092404.19),
  (2026, 9, 'spb_zhbi', 'ship_sum', 39987661.65),
  (2026, 10, 'spb_zhbi', 'ship_sum', 32946578.81),
  (2026, 11, 'spb_zhbi', 'ship_sum', 30894091.94),
  (2026, 12, 'spb_zhbi', 'ship_sum', 25156408.94),
  (2026, 1, 'spb_metal', 'ship_sum', 5009664.0),
  (2026, 2, 'spb_metal', 'ship_sum', 7947897.4),
  (2026, 3, 'spb_metal', 'ship_sum', 11216831.8),
  (2026, 4, 'spb_metal', 'ship_sum', 14091588.6),
  (2026, 5, 'spb_metal', 'ship_sum', 17366383.6),
  (2026, 6, 'spb_metal', 'ship_sum', 18288147.6),
  (2026, 7, 'spb_metal', 'ship_sum', 19999010.2),
  (2026, 8, 'spb_metal', 'ship_sum', 20099010.2),
  (2026, 9, 'spb_metal', 'ship_sum', 20199010.2),
  (2026, 10, 'spb_metal', 'ship_sum', 18288147.6),
  (2026, 11, 'spb_metal', 'ship_sum', 17288147.6),
  (2026, 12, 'spb_metal', 'ship_sum', 10812907.75),
  (2026, 1, 'msk_total', 'ship_sum', 23665027.0),
  (2026, 2, 'msk_total', 'ship_sum', 33403371.0),
  (2026, 3, 'msk_total', 'ship_sum', 53536976.0),
  (2026, 4, 'msk_total', 'ship_sum', 70092705.0),
  (2026, 5, 'msk_total', 'ship_sum', 78808446.0),
  (2026, 6, 'msk_total', 'ship_sum', 83527981.0),
  (2026, 7, 'msk_total', 'ship_sum', 95291272.0),
  (2026, 8, 'msk_total', 'ship_sum', 103647945.0),
  (2026, 9, 'msk_total', 'ship_sum', 107653297.0),
  (2026, 10, 'msk_total', 'ship_sum', 107571773.0),
  (2026, 11, 'msk_total', 'ship_sum', 93097500.0),
  (2026, 12, 'msk_total', 'ship_sum', 70049233.0),
  (2026, 1, 'msk_os', 'ship_sum', 13836315.0),
  (2026, 2, 'msk_os', 'ship_sum', 20593861.0),
  (2026, 3, 'msk_os', 'ship_sum', 31231879.0),
  (2026, 4, 'msk_os', 'ship_sum', 39544686.0),
  (2026, 5, 'msk_os', 'ship_sum', 43996632.0),
  (2026, 6, 'msk_os', 'ship_sum', 48023336.0),
  (2026, 7, 'msk_os', 'ship_sum', 55755832.0),
  (2026, 8, 'msk_os', 'ship_sum', 60396545.0),
  (2026, 9, 'msk_os', 'ship_sum', 64437062.0),
  (2026, 10, 'msk_os', 'ship_sum', 64355538.0),
  (2026, 11, 'msk_os', 'ship_sum', 53491227.0),
  (2026, 12, 'msk_os', 'ship_sum', 38532613.0),
  (2026, 1, 'msk_nc', 'ship_sum', 4328712.0),
  (2026, 2, 'msk_nc', 'ship_sum', 6059510.0),
  (2026, 3, 'msk_nc', 'ship_sum', 10305097.0),
  (2026, 4, 'msk_nc', 'ship_sum', 13748019.0),
  (2026, 5, 'msk_nc', 'ship_sum', 15011814.0),
  (2026, 6, 'msk_nc', 'ship_sum', 15204645.0),
  (2026, 7, 'msk_nc', 'ship_sum', 16735440.0),
  (2026, 8, 'msk_nc', 'ship_sum', 18451400.0),
  (2026, 9, 'msk_nc', 'ship_sum', 18416235.0),
  (2026, 10, 'msk_nc', 'ship_sum', 18416235.0),
  (2026, 11, 'msk_nc', 'ship_sum', 17256273.0),
  (2026, 12, 'msk_nc', 'ship_sum', 13516620.0),
  (2026, 1, 'msk_zhbi', 'ship_sum', 5500000.0),
  (2026, 2, 'msk_zhbi', 'ship_sum', 6750000.0),
  (2026, 3, 'msk_zhbi', 'ship_sum', 12000000.0),
  (2026, 4, 'msk_zhbi', 'ship_sum', 16800000.0),
  (2026, 5, 'msk_zhbi', 'ship_sum', 19800000.0),
  (2026, 6, 'msk_zhbi', 'ship_sum', 20300000.0),
  (2026, 7, 'msk_zhbi', 'ship_sum', 22800000.0),
  (2026, 8, 'msk_zhbi', 'ship_sum', 24800000.0),
  (2026, 9, 'msk_zhbi', 'ship_sum', 24800000.0),
  (2026, 10, 'msk_zhbi', 'ship_sum', 24800000.0),
  (2026, 11, 'msk_zhbi', 'ship_sum', 22350000.0),
  (2026, 12, 'msk_zhbi', 'ship_sum', 18000000.0),
  (2026, 1, 'krd', 'ship_sum', 8780000.0),
  (2026, 2, 'krd', 'ship_sum', 8780000.0),
  (2026, 3, 'krd', 'ship_sum', 13120000.0),
  (2026, 4, 'krd', 'ship_sum', 13120000.0),
  (2026, 5, 'krd', 'ship_sum', 17460000.0),
  (2026, 6, 'krd', 'ship_sum', 17460000.0),
  (2026, 7, 'krd', 'ship_sum', 13120000.0),
  (2026, 8, 'krd', 'ship_sum', 21800000.0),
  (2026, 9, 'krd', 'ship_sum', 26140000.0),
  (2026, 10, 'krd', 'ship_sum', 26140000.0),
  (2026, 11, 'krd', 'ship_sum', 26140000.0),
  (2026, 12, 'krd', 'ship_sum', 26140000.0)
ON CONFLICT (year, month, entity_key, metric) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

SELECT month, sum(value) FILTER (WHERE entity_key IN ('spb_total','msk_total','krd'))::bigint AS russia
FROM year_weekly_plans WHERE year = 2026 AND metric = 'ship_sum' GROUP BY month ORDER BY month;
