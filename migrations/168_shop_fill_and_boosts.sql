-- 168: магазин наполнен по черновому каталогу + первые товары-бусты (задача 51/57).
--
-- Владелец 07.08.2026: «Ну так придумай товары-бусты как мы с тобой обсуждали и
-- добавь их сам. Вообще наполни магазин из нашего чернового каталога».
-- Источник — SHOP_CATALOG_DRAFT.md §2, §2-бис, §2-тер, §4–§6. Цены оттуда же;
-- якорь прежний: медианный менеджер зарабатывает 150–200 MLT/мес, курс 5 ₽/MLT.
--
-- ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕТ:
--   * «Снабженец вне очереди» — из трёх опасных позиций (§2-бис). Он забирает
--     ресурс У КОЛЛЕГИ, а не у компании: чужой запрос отодвинут, и метрики
--     того, у кого отняли, искажены. «Выбор лида» той же природы уже есть в
--     каталоге с MVP («Приоритет распределения лидов»), плодить второй такой
--     без правила тиража не стал.
--   * «Скинуться отделом» — это механика общего котла, а не товар.
--   * Обложки и рамки за MLT сверх уже существующих — правило §2-бис: за MLT
--     продаётся только та косметика, которой НЕТ в наградах, иначе покупкой
--     обесценивается заслуженное.
--
-- Бусты. Лестница тиров из §4 с правкой §5-бис: MLT-часть убрана со ВСЕХ
-- тиров, множится только XP. Личные — ЗАРЯДЫ (3 события, 7 дней на
-- израсходовать), командные — СУТКИ: у медианного менеджера суточное окно
-- сгорает вхолостую в 54 % случаев, а у отдела из трёх человек день без продаж
-- случается лишь в 16 %. Эпический и легендарный за MLT НЕ продаются
-- (по нынешней шкале редкости легендарный обязан стоить 10 000 MLT = треть
-- айфона за +200 % XP на три события — не купит никто): они заводятся
-- выключенными и раздаются лутдропом с квестов эпик/легендарного тира.
--
-- СИСТЕМНАЯ БД (YC). 07.08.2026 применена ТОЛЬКО НА DEV (junibaseone).
-- DOWN: DELETE FROM shop_items WHERE sort >= 300 OR category = 'boost';

-- Тестовый мусор из отладочных задач — в релизной витрине ему не место.
UPDATE shop_items SET enabled = false WHERE name LIKE 'ZZZ_test%';

-- ── А. Время и график ────────────────────────────────────────────────────────
INSERT INTO shop_items (name, description, category, price_units, emoji, sort,
  ttl_months, requires_approval, per_person_limit, per_person_limit_days, cost_rub, buyer_scope)
SELECT * FROM (VALUES
  ('Неделя совы', 'Поздний старт все пять дней недели. Оптом дешевле, чем пять раз «Ещё 5 минуточек».', 'immaterial', 500, '🦉', 23, 3, true, 1, 30, 0, 'all'),
  ('Я сегодня из дома', 'Один день удалёнки без объяснений. Предупредить руководителя утром.', 'immaterial', 300, '🏠', 24, 3, true, 2, 30, 0, 'all'),
  ('Тихий час', 'Час в день без звонков и задач — всю неделю.', 'immaterial', 250, '🤫', 25, 3, true, 1, 30, 0, 'all'),
  ('День рождения — выходной', 'Выходной в свой день рождения. Дешевле обычного отгула, но раз в год.', 'immaterial', 400, '🎂', 51, 12, true, 1, 365, 0, 'all'),
  ('Отпуск вне очереди', 'Право первым выбрать даты отпуска в квартале.', 'immaterial', 2500, '✈️', 53, 12, true, 1, 365, 0, 'all'),
  ('Обед не по расписанию', 'Плавающий обед на месяц — уходить когда удобно.', 'immaterial', 150, '🍽️', 54, 3, true, 1, 30, 0, 'all')
) v WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.column1);

-- ── Б. Доступ к людям и обучение ─────────────────────────────────────────────
INSERT INTO shop_items (name, description, category, price_units, emoji, sort,
  ttl_months, requires_approval, per_person_limit, per_person_limit_days, cost_rub, buyer_scope)
SELECT * FROM (VALUES
  ('Завтрак с директором', 'Неформальный час один на один. О чём угодно.', 'immaterial', 600, '🥐', 64, 6, true, 1, 90, 0, 'all'),
  ('Тень', 'Целый день рядом с топ-менеджером отдела: смотришь, как он работает.', 'immaterial', 700, '👥', 65, 6, true, 1, 180, 0, 'all'),
  ('Наставник на месяц', 'Закреплённый ментор из сильных продавцов.', 'immaterial', 900, '🧑‍🏫', 66, 6, true, 1, 180, 0, 'all'),
  ('Разбор моего звонка', 'Руководитель слушает запись вашего разговора и разбирает по шагам.', 'immaterial', 200, '🎧', 67, 3, true, 2, 30, 0, 'all'),
  ('Книга за счёт компании', 'Любая профильная книга на выбор.', 'immaterial', 200, '📚', 68, 6, true, 2, 90, 1500, 'all'),
  ('Внешний курс', 'Обучение на стороне до оговорённой суммы.', 'immaterial', 3000, '🎓', 69, 12, true, 1, 365, 30000, 'all'),
  ('Конференция', 'Поездка на отраслевую выставку за счёт компании.', 'immaterial', 6000, '🎪', 70, 12, true, 1, 365, 60000, 'all')
) v WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.column1);

-- ── В. Статус и внимание в системе (цена компании — ноль) ────────────────────
INSERT INTO shop_items (name, description, category, price_units, emoji, sort,
  ttl_months, requires_approval, per_person_limit, per_person_limit_days, cost_rub, buyer_scope)
SELECT * FROM (VALUES
  ('Закреп в Движухе', 'Ваш пост висит наверху ленты сутки.', 'immaterial', 300, '📌', 14, 3, true, 2, 30, 0, 'all'),
  ('Профиль недели', 'Ваш профиль в шапке ЛК у всей компании на неделю.', 'immaterial', 800, '⭐', 15, 6, true, 1, 90, 0, 'all'),
  ('Своя реакция', 'Личная эмодзи-реакция в ленте на месяц.', 'immaterial', 150, '😎', 16, 3, true, 1, 30, 0, 'all'),
  ('Режим невидимки', 'Скрыть свою статистику из публичного профиля на месяц.', 'immaterial', 250, '🥷', 17, 3, true, 1, 30, 0, 'all'),
  ('Переименовать переговорку', 'На месяц. Табличка меняется по-настоящему.', 'immaterial', 300, '🚪', 18, 3, true, 1, 90, 500, 'all')
) v WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.column1);

-- ── Г. Работа и процесс ──────────────────────────────────────────────────────
INSERT INTO shop_items (name, description, category, price_units, emoji, sort,
  ttl_months, requires_approval, per_person_limit, per_person_limit_days, cost_rub, buyer_scope)
SELECT * FROM (VALUES
  ('Пропустить планёрку', 'Один раз, без объяснений.', 'immaterial', 150, '🙅', 73, 3, true, 2, 30, 0, 'all'),
  ('Не звоните мне', 'День без внутренних созвонов и планёрок. Кроме форс-мажора.', 'immaterial', 200, '📵', 74, 3, true, 2, 30, 0, 'all'),
  ('День без отчёта', 'Не сдавать ежедневный отчёт один день.', 'immaterial', 80, '📄', 75, 3, true, 2, 30, 0, 'all'),
  ('Автопродление брони', 'Бронь не сгорает лишние сутки. Один раз.', 'immaterial', 150, '⏳', 76, 3, true, 4, 30, 0, 'all'),
  ('Личный час с РОПом', 'Час один на один по своим сделкам, не групповой разбор.', 'immaterial', 200, '🗣️', 77, 3, true, 1, 30, 0, 'all'),
  ('Расчёт за меня', 'Спецификацию или смету считает специалист.', 'immaterial', 300, '🧮', 78, 3, true, 2, 30, 0, 'all'),
  ('Вопрос в лоб', 'Задать директору публичный вопрос и получить публичный ответ.', 'immaterial', 500, '🎤', 79, 6, true, 1, 90, 0, 'all'),
  ('Идея вне очереди', 'Ваше предложение разбирают на ближайшем собрании.', 'immaterial', 400, '💡', 80, 6, true, 1, 90, 0, 'all')
) v WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.column1);

-- ── Е. Шуточные и культурные ─────────────────────────────────────────────────
INSERT INTO shop_items (name, description, category, price_units, emoji, sort,
  ttl_months, requires_approval, per_person_limit, per_person_limit_days, cost_rub, buyer_scope)
SELECT * FROM (VALUES
  ('Своя музыка в отделе', 'Плейлист дня в колонке отдела.', 'immaterial', 40, '🎵', 90, 3, true, 4, 30, 0, 'all'),
  ('Кресло босса', 'День за столом руководителя или в переговорке как в личном кабинете.', 'immaterial', 100, '💺', 91, 3, true, 2, 30, 0, 'all'),
  ('Мем дня', 'Ваш мем в общем чате от имени компании.', 'immaterial', 60, '🐸', 92, 3, true, 4, 30, 0, 'all'),
  ('Тост на корпоративе', 'Право произнести тост.', 'immaterial', 300, '🥂', 93, 12, true, 1, 180, 0, 'all'),
  ('Обед за счёт компании', 'Доставка обеда на выбор.', 'immaterial', 60, '🍱', 94, 3, true, 4, 30, 700, 'all'),
  ('Парковка у входа', 'Месяц закреплённого места.', 'immaterial', 500, '🅿️', 95, 3, true, 1, 30, 0, 'all')
) v WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.column1);

-- ── Д. Командные (покупает РОП или директор) ─────────────────────────────────
-- Цена — база; сублинейная формула от размера отдела (§6) в движке ещё не
-- реализована, поэтому пока фиксированная. Когда формула появится, эти цены
-- станут базой для неё, менять строки не придётся.
INSERT INTO shop_items (name, description, category, price_units, emoji, sort,
  ttl_months, requires_approval, per_person_limit, per_person_limit_days, cost_rub, buyer_scope)
SELECT * FROM (VALUES
  ('Отдел уходит в 17:00 в пятницу', 'Весь отдел заканчивает раньше в пятницу.', 'team', 250, '🕔', 222, 3, true, 1, 30, 0, 'rop_only'),
  ('Планёрка отменяется', 'Отдел пропускает планёрку.', 'team', 200, '🚫', 223, 3, true, 2, 30, 0, 'rop_only'),
  ('Выездной день', 'Отдел работает из кофейни или коворкинга.', 'team', 500, '🏕️', 224, 3, true, 1, 90, 5000, 'rop_only'),
  ('Караоке или боулинг вечером', 'Вечер отдела за счёт компании.', 'team', 800, '🎤', 225, 6, true, 1, 180, 20000, 'rop_only')
) v WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.column1);

-- ── Материальные: рабочее место (остаётся имуществом компании, §2-тер) ───────
INSERT INTO shop_items (name, description, category, price_units, emoji, sort,
  ttl_months, requires_approval, per_person_limit, per_person_limit_days, cost_rub, buyer_scope)
SELECT * FROM (VALUES
  ('Стол с регулировкой высоты', 'Рабочее место стоя и сидя. Остаётся имуществом компании.', 'material', 9000, '🪑', 121, 6, true, 1, 365, 45000, 'all'),
  ('Второй монитор', 'К уже имеющемуся рабочему. Имущество компании.', 'material', 4000, '🖥️', 126, 6, true, 1, 365, 20000, 'all'),
  ('Ноутбук', 'Рабочий ноутбук. Имущество компании.', 'material', 16000, '💻', 128, 12, true, 1, 730, 80000, 'all'),
  ('Гарнитура для звонков', 'Профессиональная гарнитура Jabra или Poly.', 'material', 2400, '🎙️', 112, 6, true, 1, 365, 12000, 'all'),
  ('Механическая клавиатура', 'На выбор из согласованных моделей.', 'material', 1600, '⌨️', 137, 6, true, 1, 365, 8000, 'all'),
  ('Вертикальная мышь', 'Эргономичная, для тех, у кого устаёт запястье.', 'material', 1000, '🖱️', 138, 6, true, 1, 365, 5000, 'all'),
  ('Веб-камера', 'Нормальная камера для созвонов.', 'material', 1200, '📷', 139, 6, true, 1, 365, 6000, 'all'),
  ('Настольная лампа', 'Свет на рабочее место.', 'material', 800, '💡', 141, 6, true, 1, 365, 4000, 'all')
) v WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.column1);

-- ── БУСТЫ ────────────────────────────────────────────────────────────────────
-- Личные: 3 заряда, 7 дней на израсходовать. Цены §5: обычный 60, необычный
-- 150, редкий 400. Множитель — прибавка к XP события нужной оси.
INSERT INTO shop_items (name, description, category, price_units, emoji, sort,
  ttl_months, requires_approval, per_person_limit, per_person_limit_days, cost_rub, buyer_scope,
  boost_metric, boost_multiplier, boost_window_days, boost_scope, boost_charges)
SELECT * FROM (VALUES
  ('По повторочке!', 'Следующие 3 повторные продажи дают +50 % XP. Сгорает через 7 дней.',
   'boost', 60, '🔁', 300, 3, false, 3, 30, 0, 'all', 'repeat', 1.5, 7, 'personal', 3),
  ('По повторочке! Плюс', 'Следующие 3 повторные продажи дают двойной XP. Сгорает через 7 дней.',
   'boost', 150, '🔁', 301, 3, false, 2, 30, 0, 'all', 'repeat', 2.0, 7, 'personal', 3),
  ('С чистого листа', 'Следующие 3 первичные продажи дают +50 % XP. Сгорает через 7 дней.',
   'boost', 60, '🎯', 302, 3, false, 3, 30, 0, 'all', 'primary', 1.5, 7, 'personal', 3),
  ('С чистого листа. Плюс', 'Следующие 3 первичные продажи дают двойной XP. Сгорает через 7 дней.',
   'boost', 150, '🎯', 303, 3, false, 2, 30, 0, 'all', 'primary', 2.0, 7, 'personal', 3),
  ('А что ещё берут?', 'Следующие 3 допродажи по рекомендации дают двойной XP. Сгорает через 7 дней.',
   'boost', 150, '🧲', 304, 3, false, 2, 30, 0, 'all', 'crosssell', 2.0, 7, 'personal', 3),
  ('Тяжёлая артиллерия', 'Следующие 3 сделки от миллиона дают двойной XP. Сгорает через 7 дней.',
   'boost', 150, '💣', 305, 3, false, 2, 30, 0, 'all', 'big_deal', 2.0, 7, 'personal', 3),
  ('Не тормози', 'Следующие 3 сделки быстрее медианы группы дают двойной XP. Сгорает через 7 дней.',
   'boost', 150, '⚡', 306, 3, false, 2, 30, 0, 'all', 'speed', 2.0, 7, 'personal', 3),
  ('Грузим-грузим', 'Следующие 3 отгрузки дают двойной XP. Сгорает через 7 дней.',
   'boost', 150, '🚚', 307, 3, false, 2, 30, 0, 'all', 'shipments', 2.0, 7, 'personal', 3),
  ('Широкий фронт', 'Следующие 3 продажи ЛЮБОГО типа дают двойной XP. Сгорает через 7 дней.',
   'boost', 400, '🌊', 308, 3, false, 1, 30, 0, 'all', 'all_sales', 2.0, 7, 'personal', 3)
) v WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.column1);

-- Командный: сутки на весь отдел, покупает РОП. Окно честное — у отдела из трёх
-- человек день без продаж случается лишь в 16 % случаев.
INSERT INTO shop_items (name, description, category, price_units, emoji, sort,
  ttl_months, requires_approval, per_person_limit, per_person_limit_days, cost_rub, buyer_scope,
  boost_metric, boost_multiplier, boost_window_days, boost_scope, boost_charges)
SELECT * FROM (VALUES
  ('Сегодня давим — командный буст', 'Сутки: все продажи отдела дают +50 % XP каждому. Виден всему отделу.',
   'team', 300, '🔥', 226, 3, false, 2, 30, 0, 'rop_only', 'all_sales', 1.5, 1, 'team', NULL::int)
) v WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.column1);

-- Эпический и легендарный за MLT НЕ продаются (enabled=false): по нынешней шкале
-- редкости (`features/shop/engine/rarity.ts` считает её ОТ ЦЕНЫ) легендарный
-- обязан стоить 10 000 MLT = треть айфона за +200 % XP на три события. Их место —
-- лутдроп с квестов, где у колеса наконец появляется настоящая ставка.
INSERT INTO shop_items (name, description, category, price_units, emoji, sort, enabled,
  ttl_months, requires_approval, cost_rub, buyer_scope,
  boost_metric, boost_multiplier, boost_window_days, boost_scope, boost_charges)
SELECT * FROM (VALUES
  ('Второе дыхание (эпик)', 'Следующие 3 продажи любого типа дают +150 % XP. Только из лутдропа.',
   'boost', 1, '🌟', 309, false, 3, false, 0, 'all', 'all_sales', 2.5, 7, 'personal', 3),
  ('Звёздный час (легенда)', 'Следующие 3 продажи и отгрузки дают тройной XP. Только из лутдропа.',
   'boost', 1, '☄️', 310, false, 3, false, 0, 'all', 'all_sales', 3.0, 7, 'personal', 3)
) v WHERE NOT EXISTS (SELECT 1 FROM shop_items s WHERE s.name = v.column1);

-- Лутдроп квестов: эпик-тир получает эпический буст, легендарный — легендарный.
-- Списки в `quest_settings.loot_table` дополняем, а не заменяем: там уже лежат
-- подобранные вручную предметы, терять их незачем.
UPDATE quest_settings SET loot_table = jsonb_set(
  jsonb_set(loot_table,
    '{epic,items}',
    (loot_table->'epic'->'items') || to_jsonb(ARRAY(SELECT id FROM shop_items WHERE name = 'Второе дыхание (эпик)'))),
  '{legendary,items}',
  (loot_table->'legendary'->'items') || to_jsonb(ARRAY(SELECT id FROM shop_items WHERE name = 'Звёздный час (легенда)')))
WHERE id = 1
  AND NOT (loot_table->'legendary'->'items') @> to_jsonb(ARRAY(SELECT id FROM shop_items WHERE name = 'Звёздный час (легенда)'));
