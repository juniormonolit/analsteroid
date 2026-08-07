-- 165: перекалибровка порогов новых осей дерева скиллов (задача 49).
--
-- Пороги миграции 159 у четырёх НОВЫХ осей ставились на глаз — под них не было
-- наград в каталоге, а значит и распределения, от которого можно было считать.
-- Замер 07.08.2026 на живых данных (6 полных месяцев, февраль–июль 2026,
-- менеджеро-периоды с активностью) показал, что три оси из четырёх сломаны:
--
--   * ППП: медиана 1 в месяц, а пороги начинались с 15. Ступени 3–5 не взял бы
--     НИКТО и никогда — ветка мертва целиком.
--   * Отгрузки: медиана 1,25 млн ₽/мес, пороги 3–25 млн. Верхние две ступени —
--     ноль срабатываний за полгода на всей компании.
--   * Первичные: «2 продажи за неделю» берут 73 % менеджеро-недель. Это награда
--     за присутствие, а не за достижение — ровно та болезнь, которую лечил
--     августовский аудит наград.
--   * Конверсия в бронь: единственная живая, но и там нижняя ступень (20 %)
--     ниже медианы (24 %), то есть тоже «берут почти все».
--
-- КАК ПЕРЕСЧИТАНО. Пороги — перцентили реального распределения
-- p50 / p60 / p70 / p80 / p88. Выбор перцентилей не произвольный: он подчинён
-- железному правилу §5-тер, п.3 — «прокачка не должна снижать доход». Цена
-- ступени растёт ×1,8 (×10,5 от s1 к s5), значит частота вправе падать не
-- быстрее, чем в 10,5 раза; выбранная лесенка роняет её вчетверо, и доход с
-- ветки РАСТЁТ по мере прокачки в 2,5–2,8 раза. Проверено на тех же данных.
--
-- ЦЕНЫ ЗДЕСЬ НЕ ТРОГАЕМ, кроме двух точечных правок s5: у «первичных» и «ППП»
-- доход на пятой ступени проваливался ниже четвёртой (×2,73 → ×2,51 и
-- ×2,20 → ×2,16) — это нарушение того же правила, лечится подъёмом цены s5.
-- Общий уровень цен — вопрос к владельцу, см. WORKLOG 07.08: четыре оси при
-- нынешних ценах печатают ~9 900 MLT/мес на входе и ~24 700 при полной
-- прокачке, против июльской эмиссии 47 963 и потолка 60 000.
--
-- Шести старых осей миграция НЕ касается: их пороги проверить этим же способом
-- нельзя, пока не сведена семантика ступеней с тем, как награды реально
-- считаются (см. WORKLOG — у `planning_discipline` порог «3 брони» вообще не
-- про то, что делает награда).
--
-- СИСТЕМНАЯ БД (YC). 07.08.2026 применена ТОЛЬКО НА DEV (junibaseone).
-- DOWN: восстановить из skill_branch_steps_backup_165.

CREATE TABLE IF NOT EXISTS skill_branch_steps_backup_165 AS
  SELECT * FROM skill_branch_steps WHERE false;
INSERT INTO skill_branch_steps_backup_165
  SELECT * FROM skill_branch_steps
   WHERE branch_key IN ('primary','ppp','booking','shipments')
     AND NOT EXISTS (SELECT 1 FROM skill_branch_steps_backup_165);

-- Первичные продажи за неделю: было 2/4/6/9/13, берут 73/46/27/10/2 %.
UPDATE skill_branch_steps SET threshold = '{"minCount": 3}' WHERE branch_key='primary' AND step=1;
UPDATE skill_branch_steps SET threshold = '{"minCount": 4}' WHERE branch_key='primary' AND step=2;
UPDATE skill_branch_steps SET threshold = '{"minCount": 5}' WHERE branch_key='primary' AND step=3;
UPDATE skill_branch_steps SET threshold = '{"minCount": 6}' WHERE branch_key='primary' AND step=4;
UPDATE skill_branch_steps SET threshold = '{"minCount": 8}', price = 230 WHERE branch_key='primary' AND step=5;

-- ППП за месяц: было 15/20/25/30/36 при медиане 1 — ветка не срабатывала вовсе.
UPDATE skill_branch_steps SET threshold = '{"minPpp": 1}' WHERE branch_key='ppp' AND step=1;
UPDATE skill_branch_steps SET threshold = '{"minPpp": 2}' WHERE branch_key='ppp' AND step=2;
UPDATE skill_branch_steps SET threshold = '{"minPpp": 4}' WHERE branch_key='ppp' AND step=3;
UPDATE skill_branch_steps SET threshold = '{"minPpp": 5}' WHERE branch_key='ppp' AND step=4;
UPDATE skill_branch_steps SET threshold = '{"minPpp": 7}', price = 270 WHERE branch_key='ppp' AND step=5;

-- Конверсия в бронь за месяц: было 20/25/30/35/40 при медиане 24.
UPDATE skill_branch_steps SET threshold = '{"minConv": 24}' WHERE branch_key='booking' AND step=1;
UPDATE skill_branch_steps SET threshold = '{"minConv": 28}' WHERE branch_key='booking' AND step=2;
UPDATE skill_branch_steps SET threshold = '{"minConv": 33}' WHERE branch_key='booking' AND step=3;
UPDATE skill_branch_steps SET threshold = '{"minConv": 38}' WHERE branch_key='booking' AND step=4;
UPDATE skill_branch_steps SET threshold = '{"minConv": 45}' WHERE branch_key='booking' AND step=5;

-- Сумма отгрузок за месяц: было 3/6/10/16/25 млн при медиане 1,25 млн.
UPDATE skill_branch_steps SET threshold = '{"minAmount": 1500000}' WHERE branch_key='shipments' AND step=1;
UPDATE skill_branch_steps SET threshold = '{"minAmount": 2000000}' WHERE branch_key='shipments' AND step=2;
UPDATE skill_branch_steps SET threshold = '{"minAmount": 3000000}' WHERE branch_key='shipments' AND step=3;
UPDATE skill_branch_steps SET threshold = '{"minAmount": 4000000}' WHERE branch_key='shipments' AND step=4;
UPDATE skill_branch_steps SET threshold = '{"minAmount": 6000000}' WHERE branch_key='shipments' AND step=5;

-- badge_prices — рабочая таблица начисления, держим её в согласии со ступенями.
UPDATE badge_prices p SET price = s.price, updated_at = now()
  FROM skill_branch_steps s
 WHERE p.badge_key = s.badge_key AND p.tier = s.tier AND p.price <> s.price;
