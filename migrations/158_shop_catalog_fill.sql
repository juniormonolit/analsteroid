-- Наполнение магазина утверждёнными позициями (задача 2996, решения владельца
-- 06.08.2026 по SHOP_CATALOG_DRAFT.md). Два действия:
--   1) ПЕРЕОЦЕНКА существующих 16 позиций под курс 5 ₽/MLT. Старые цены ставились
--      при курсе 7,5 ₽ и по другим прикидкам: айфон стоил 15 000 MLT, а владелец
--      назвал 29 000 (=145 000 ₽ ÷ 5). Кресло стоило 1 000 MLT = 5 000 ₽ — дешевле
--      реальной закупки в 8 раз. Приводим ВСЁ к правилу «цена MLT = цена ₽ ÷ 5»,
--      заодно проставляем cost_rub, чтобы дашборд экономики считал по себестоимости,
--      а не по оценке сверху.
--   2) ДОБАВЛЕНИЕ новых позиций из списка владельца и утверждённых им предложений.
--
-- ЧТО СОЗНАТЕЛЬНО НЕ ЗАВОДИТСЯ:
--   * мерч сверх футболки/мерч-бокса — владелец: «надо дрочиться с расширением
--     линейки, футболки хватит»;
--   * своя продукция (газобетон, кровля на баню и т.п.) — владелец: «нет, у
--     менеджеров и так скидка»;
--   * умные часы — владелец: «точно нет»;
--   * «Выбор лида» и «Снабженец вне очереди» — единственные товары, отбирающие
--     ресурс У КОЛЛЕГИ, а не у компании (см. SHOP_CATALOG_DRAFT §2-бис). До
--     решения про тираж не заводим;
--   * «Почистить хвосты» заведены ВЫКЛЮЧЕННЫМИ (enabled=false) — включать только
--     после антифарм-флага, иначе покупка чистки за MLT приносит награду
--     «Чистая воронка» за MLT (петля самофинансирования). Тем же коммитом
--     выключается и старый «Сброс мёртвых сделок», который этой проверки никогда
--     не проходил.
--
-- СИСТЕМНАЯ БД (YC) — применяется вручную migrations/run_system.mjs, ОТДЕЛЬНО на
-- dev (junibaseone) и на prod (system).
-- DOWN: DELETE FROM shop_items WHERE name IN (...новые...); цены старых 16 позиций
--   восстановить из shop_items_price_backup_20260806.

CREATE TABLE IF NOT EXISTS shop_items_price_backup_20260806 (
  id int, name text, price_units numeric, enabled boolean, backed_up_at timestamptz DEFAULT now()
);
INSERT INTO shop_items_price_backup_20260806 (id, name, price_units, enabled)
  SELECT id, name, price_units, enabled FROM shop_items
   WHERE NOT EXISTS (SELECT 1 FROM shop_items_price_backup_20260806);

-- ── 1. Переоценка существующих под курс 5 ₽ ──────────────────────────────────
UPDATE shop_items SET price_units =  29000, cost_rub = 145000 WHERE name = 'iPhone (актуальный)';
UPDATE shop_items SET price_units =   6000, cost_rub =  30000 WHERE name = 'Смартфон';
UPDATE shop_items SET price_units =   5000, cost_rub =  25000 WHERE name = 'Монитор';
UPDATE shop_items SET price_units =   8000, cost_rub =  40000 WHERE name = 'Рабочее кресло';
UPDATE shop_items SET price_units =   4000, cost_rub =  20000 WHERE name = 'Наушники беспроводные';
UPDATE shop_items SET price_units =    500, cost_rub =   2500 WHERE name = 'Термокружка';
UPDATE shop_items SET price_units =    300, cost_rub =   1500 WHERE name = 'Фирменный мерч-бокс';
UPDATE shop_items SET price_units =     60, cost_rub =    300 WHERE name = 'Кофе за счёт компании';
UPDATE shop_items SET price_units =   1600, cost_rub =   8000 WHERE name = 'Пицца-день отдела';
UPDATE shop_items SET price_units =  12000, cost_rub =  60000 WHERE name = 'Тимбилдинг / выезд отдела';
-- Нематериальные: cost_rub = 0 (рабочее время, а не деньги — решение 06.08).
UPDATE shop_items SET price_units =    800, cost_rub = 0 WHERE name = 'Отгул (полный оплачиваемый день)';
UPDATE shop_items SET price_units =    240, cost_rub = 0 WHERE name = 'Поздний старт +2 часа';
UPDATE shop_items SET price_units =     50, cost_rub = 0 WHERE name = 'Титул / кастомная рамка бейджа на месяц';
UPDATE shop_items SET price_units =    900, cost_rub = 0 WHERE name = 'Поздний старт всего отдела (+1 час)';
-- Ломает clean_week до антифарм-флага (задача 2997).
UPDATE shop_items SET enabled = false WHERE name = 'Сброс мёртвых сделок';

-- ── 2. Новые позиции ─────────────────────────────────────────────────────────
INSERT INTO shop_items
  (name, description, category, price_units, allowed_currencies, enabled, sort, emoji,
   buyer_scope, requires_approval, cost_rub, per_person_limit, per_person_limit_days)
SELECT v.name, v.description, v.category, v.price_units, v.allowed_currencies, v.enabled, v.sort,
       v.emoji, v.buyer_scope, v.requires_approval, v.cost_rub, v.per_person_limit, v.per_person_limit_days
  FROM (VALUES
  -- Поведенческие, список владельца дословно
  ('Ещё 5 минуточек!', 'Прийти на работу на час позже. Предупредить руководителя заранее.',
   'immaterial', 120, '{EBALL}'::text[], true, 21, '😴', 'all', true, 0, 2, 30),
  ('Ой! Мне надо бежать!', 'Уйти с работы на час раньше. Предупредить руководителя заранее.',
   'immaterial', 120, '{EBALL}'::text[], true, 22, '🏃', 'all', true, 0, 2, 30),
  ('Длинные выходные', 'Пятница или понедельник к выходным. Дату согласовать с руководителем заранее.',
   'immaterial', 1000, '{EBALL}'::text[], true, 52, '🌅', 'all', true, 0, 1, 90),
  ('Личное обучение', 'Индивидуальный час обучения с Будковским по любому материалу.',
   'immaterial', 250, '{EBALL}'::text[], true, 60, '🎓', 'all', true, 0, NULL::int, NULL::int),
  ('Разбор сделок с Осиповым', 'Сергей Осипов целый час лично разгребает с вами ваши сделки.',
   'immaterial', 400, '{EBALL}'::text[], true, 61, '🧭', 'all', true, 0, 1, 30),
  ('Разбор сделок с Коваленко', 'Леонид Коваленко целый час лично разгребает с вами ваши сделки.',
   'immaterial', 400, '{EBALL}'::text[], true, 62, '🧭', 'all', true, 0, 1, 30),
  ('Разбор сделок с Поповым', 'Дмитрий Попов целый час лично разгребает с вами ваши сделки.',
   'immaterial', 400, '{EBALL}'::text[], true, 63, '🧭', 'all', true, 0, 1, 30),
  -- Статус в системе: стоят компании ноль, вымывают валюту
  ('Свой титул', 'Придумать себе титул вместо системного на месяц. Проходит модерацию администратора.',
   'immaterial', 50, '{EBALL}'::text[], true, 11, '🏷️', 'all', true, 0, 1, 30),
  ('Право назвать награду', 'Придумываете имя новой ачивке — её реально заводят в систему для всех.',
   'immaterial', 1200, '{EBALL}'::text[], true, 12, '✍️', 'all', true, 0, NULL::int, NULL::int),
  ('Секретка на заказ', 'Персональная секретная ачивка под вашу личную историю. Формулировку утверждает администратор.',
   'immaterial', 2000, '{EBALL}'::text[], true, 13, '🕵️', 'all', true, 0, NULL::int, NULL::int),
  -- Чистка хвостов — ВЫКЛЮЧЕНЫ до антифарм-флага (задача 2997)
  ('Почистить хвосты ×5', 'По согласованию с РОПом чистятся до 5 зависших сделок. Задаётся минимум вопросов.',
   'immaterial', 150, '{EBALL}'::text[], false, 70, '🧹', 'all', true, 0, NULL::int, NULL::int),
  ('Почистить хвосты ×10', 'По согласованию с РОПом чистятся до 10 зависших сделок. Задаётся минимум вопросов.',
   'immaterial', 250, '{EBALL}'::text[], false, 71, '🧹', 'all', true, 0, NULL::int, NULL::int),
  ('Почистить хвосты ×20', 'По согласованию с РОПом чистятся до 20 зависших сделок. Задаётся минимум вопросов.',
   'immaterial', 400, '{EBALL}'::text[], false, 72, '🧹', 'all', true, 0, NULL::int, NULL::int),
  -- Материальные, утверждённые владельцем
  ('Планшет', 'Планшет для работы и жизни. Переходит в собственность сотрудника.',
   'material', 8000, '{EBALL}'::text[], true, 132, '📱', 'all', true, 40000, NULL::int, NULL::int),
  ('Портативная колонка', 'Bluetooth-колонка. Переходит в собственность сотрудника.',
   'material', 1600, '{EBALL}'::text[], true, 134, '🔊', 'all', true, 8000, NULL::int, NULL::int),
  ('Внешний аккумулятор', 'Powerbank, чтобы телефон не умирал на выезде.',
   'material', 800, '{EBALL}'::text[], true, 136, '🔋', 'all', true, 4000, NULL::int, NULL::int)
  ) AS v(name, description, category, price_units, allowed_currencies, enabled, sort, emoji,
         buyer_scope, requires_approval, cost_rub, per_person_limit, per_person_limit_days)
 WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.name);

COMMENT ON COLUMN shop_items.price_units IS
  'Цена в MLT. Правило каталога с 06.08.2026: цена MLT = цена в рублях ÷ курс (badge_coin_settings.mlt_rub_rate, сейчас 5). Нематериальные позиции имеют cost_rub = 0 — это рабочее время, а не деньги.';
