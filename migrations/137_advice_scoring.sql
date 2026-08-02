-- 137: Скоринг подсказок «кому звонить» (задача 2765, правка владельца 02.08).
-- Дословно: «подсказывать что делать по клиентам надо только по тем, где
-- реально высокий шанс... Призывать реинкарнировать заказчика после 2 лет
-- молчания — такое себе занятие».
--
-- Явные веса пяти факторов (давность/личный цикл, частота покупок,
-- сумма+категория, реакция на прошлые касания, сила кросс-перехода) + порог
-- отсечки (ниже — совета нет вовсе, только цифры) + порог «мёртвых»
-- (жёсткое исключение из кандидатов, не просто понижение веса).
--
-- Дефолты калиброваны БЭКТЕСТОМ по всей истории sa.deals (заказчики с 3+
-- покупками, окно 02.08.2026, точные SQL и n на бакет — WORKLOG 02.08):
--   доля возврата по бакетам «давность/личный цикл»:
--     0-1x 89.4% (n=3245) · 1-2x 92.6% (n=2145) · 2-3x 73.5% (n=408) ·
--     3-5x 61.5% (n=410) · 5-10x 43.1% (n=420) · 10x+ 12.7% (n=683).
--   порог «мёртвых» (ratio × дни):
--     3-5x & <=365 дн 62.2% (n=405) — НЕ резать; 5x+ & >365 дн 3.1% (n=295) —
--     резать. Отсюда dead_ratio_threshold=5 (НЕ 3, как в первой прикидке
--     владельца — «условно» и «подбери по данным» сказано явно).
-- advice_score_threshold=55 — подобран прогоном на живых кандидатах
-- нескольких реальных менеджеров в dry-run (см. WORKLOG 02.08, точные цифры
-- прохождения по менеджерам).
--
-- DOWN:
--   ALTER TABLE digest_settings
--     DROP COLUMN IF EXISTS advice_score_threshold,
--     DROP COLUMN IF EXISTS weight_recency, DROP COLUMN IF EXISTS weight_frequency,
--     DROP COLUMN IF EXISTS weight_value, DROP COLUMN IF EXISTS weight_responsive,
--     DROP COLUMN IF EXISTS weight_crosssell,
--     DROP COLUMN IF EXISTS dead_ratio_threshold, DROP COLUMN IF EXISTS dead_days_threshold;

ALTER TABLE digest_settings
  ADD COLUMN IF NOT EXISTS advice_score_threshold numeric NOT NULL DEFAULT 55,
  ADD COLUMN IF NOT EXISTS weight_recency    numeric NOT NULL DEFAULT 35,
  ADD COLUMN IF NOT EXISTS weight_frequency  numeric NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS weight_value      numeric NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS weight_responsive numeric NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS weight_crosssell  numeric NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS dead_ratio_threshold numeric NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS dead_days_threshold  int NOT NULL DEFAULT 365;
