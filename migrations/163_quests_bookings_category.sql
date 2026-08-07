-- 163: категория квестов «Брони» (задача 59).
--
-- Замер 06.08.2026 показал дыру: из шести категорий квестов ни одна не про
-- брони, хотя владелец называет брони одним из ДВУХ главных целевых действий
-- (второе — продажи). За всё время на деве выдано 3433 квеста, из них про брони
-- ноль — их просто нечем было выдать.
--
-- Бронь = сделка с заполненным `reserved_at` в периоде, ровно как метрика
-- каталога `reservations_count` (миграция 034: deals / count_distinct deal_id /
-- дата reserved_at, без фильтра по воронке). Отдельной сущности не заводим.
--
-- Калибровка на живых данных (07.08.2026, 190 дней, менеджеро-периоды с
-- активностью): брони неделя медиана 8 / Q3 14, месяц 15 / 40, день 2 / 4;
-- продажи для сверки — неделя 5 / 10, месяц 10 / 29, день 2 / 3. То есть броней
-- примерно в полтора раза больше продаж, пороги считаются движком от медианы
-- компании и подстраиваются сами — хардкода здесь нет.
--
-- Миграция только расширяет CHECK; данные не трогает.

ALTER TABLE quests DROP CONSTRAINT IF EXISTS quests_category_check;
ALTER TABLE quests ADD CONSTRAINT quests_category_check CHECK (category IN
  ('sales_count','sales_amount','group_sales','repeat_sales','crosssell',
   'distinct_groups','bookings_count'));

-- Доска контрактов (миграция 126) делит справочник категорий с квестами:
-- прогресс контракта считает тот же движок, поэтому категория должна быть
-- допустима и здесь, даже пока пул контрактов брони не генерирует.
ALTER TABLE quest_contracts DROP CONSTRAINT IF EXISTS quest_contracts_category_check;
ALTER TABLE quest_contracts ADD CONSTRAINT quest_contracts_category_check CHECK (category IN
  ('sales_count','sales_amount','group_sales','repeat_sales','crosssell',
   'distinct_groups','bookings_count'));
