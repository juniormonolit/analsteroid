-- 124: XP-система (опыт как в MMORPG, фича Серёги 01.08).
-- XP — репутация: только растёт, НЕ тратится, НЕ конвертируется в ебаллы,
-- живёт отдельно от кошельков. Начисляется ТОЛЬКО за продажи/отгрузки
-- (за звонки/брони XP нет — принципиально).
--
-- Слот-модель: XP живёт с ЧЕЛОВЕКОМ, не с логином — леджер пересчитывается
-- ночным тиком только по сделкам с даты выхода текущего человека
-- (sa.employee_registry.manual_start_date + история переименований
-- sa.employee_name_history); границы применяются в движке (features/xp).
--
-- DOWN:
--   DROP TABLE IF EXISTS xp_ledger;
--   DROP TABLE IF EXISTS xp_class_map;
--   DROP TABLE IF EXISTS xp_settings;
--   DELETE FROM badge_definitions WHERE key IN ('xp_first_group','xp_class_master','xp_polymath','xp_level_up','xp_necromancer','quest_streak_10','quest_week_all','quest_month_daily');

-- Коэффициенты начисления (редактируются в «Настройки → Награды → XP»).
CREATE TABLE IF NOT EXISTS xp_settings (
  id int PRIMARY KEY CHECK (id = 1),
  sale_fix int NOT NULL DEFAULT 40,          -- фикс за продажу
  sale_per_rub int NOT NULL DEFAULT 10000,   -- +1 XP за каждые N ₽ суммы
  sale_sum_cap int NOT NULL DEFAULT 60,      -- кап суммовой части продажи
  ship_fix int NOT NULL DEFAULT 20,          -- фикс за отгрузку
  ship_per_rub int NOT NULL DEFAULT 20000,
  ship_sum_cap int NOT NULL DEFAULT 30,
  repeat_mult numeric NOT NULL DEFAULT 2,    -- повторная продажа (funnel is_repeat)
  crosssell_mult numeric NOT NULL DEFAULT 2, -- допродажа по рекомендации (матрица переходов)
  regular_bonus int NOT NULL DEFAULT 50,     -- довёл клиента до постоянника (его 2-я продажа)
  speed_bonus numeric NOT NULL DEFAULT 0.25, -- +25% за закрытие быстрее медианы группы (deal_events)
  level_base numeric NOT NULL DEFAULT 500,   -- XP до уровня N = base × N^exp
  level_exp numeric NOT NULL DEFAULT 1.5,
  class_level_base numeric NOT NULL DEFAULT 150, -- та же кривая для классов, меньшая база
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO xp_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Классы (домены): маппинг «головная группа → класс», редактируется админом.
CREATE TABLE IF NOT EXISTS xp_class_map (
  head_group text PRIMARY KEY,
  class_name text NOT NULL
);
INSERT INTO xp_class_map (head_group, class_name) VALUES
  ('Песок', 'Нерудка'), ('Щебень', 'Нерудка'), ('Грунт и навоз', 'Нерудка'),
  ('Керамзит', 'Нерудка'), ('Уголь', 'Нерудка'), ('Асфальт и асфальтобетон', 'Нерудка'),
  ('Вторичные материалы', 'Нерудка'),
  ('Плиты перекрытия ЖБИ', 'ЖБИ'), ('Дорожные плиты', 'ЖБИ'), ('ФБС', 'ЖБИ'),
  ('Лотки и плиты лотков ЖБИ', 'ЖБИ'), ('Кольца ЖБИ', 'ЖБИ'), ('Прочее ЖБИ', 'ЖБИ'),
  ('Аэродромные плиты', 'ЖБИ'), ('Опоры СВ', 'ЖБИ'), ('Заборы ЖБИ', 'ЖБИ'),
  ('Трубы ЖБИ', 'ЖБИ'), ('Сваи ЖБИ', 'ЖБИ'), ('Лестничные марши и площадки', 'ЖБИ'),
  ('Кровельные материалы, водосточные системы', 'Кровля'), ('Ондулин и шифер', 'Кровля'),
  ('Рулонная гидроизоляция', 'Кровля'),
  ('Теплоизоляция и утеплитель', 'Утепление'), ('Плитные материалы', 'Утепление'),
  ('Газобетон', 'Стеновые'), ('Кирпич и другие стеновые материалы', 'Стеновые'),
  ('Облицовочный кирпич', 'Стеновые'), ('Сухие смеси', 'Стеновые'), ('Бетон и раствор', 'Стеновые'),
  ('Арматура стальная и проволока', 'Металл'), ('Прочий металлопрокат', 'Металл'),
  ('Трубы профильные стальные', 'Металл'), ('Ограждения и заборы', 'Металл'),
  ('Сэндвич-панели', 'Металл')
ON CONFLICT (head_group) DO NOTHING;
-- Всё, что не в маппинге, движок относит к классу «Прочее».

-- Леджер XP по сделкам: полный идемпотентный пересчёт каждым тиком
-- (границы людей и коэффициенты применяются на момент пересчёта).
CREATE TABLE IF NOT EXISTS xp_ledger (
  deal_id bigint PRIMARY KEY,
  bitrix_id bigint NOT NULL,
  sold_day date,
  ship_day date,
  sale_xp int NOT NULL DEFAULT 0,   -- база продажи (до множителей)
  ship_xp int NOT NULL DEFAULT 0,   -- база отгрузки (до множителей)
  mult numeric NOT NULL DEFAULT 1,  -- итоговый множитель (повторка/допродажа × скорость)
  bonus_xp int NOT NULL DEFAULT 0,  -- бонус «довёл до постоянника»
  total_xp int NOT NULL,
  classes jsonb NOT NULL DEFAULT '{}'::jsonb, -- {класс: xp} — распределение total_xp
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS xp_ledger_bitrix_idx ON xp_ledger (bitrix_id);

-- Награды XP-пула (цены — сид, дальше правятся в настройках).
INSERT INTO badge_definitions (key, name, description, icon, category, tiered, criteria, sort_order) VALUES
  ('xp_first_group', 'Первая кровь', 'Первая продажа в новой для вас товарной группе.', '🩸', 'milestone', false, '{"xp":"first_group"}', 90),
  ('xp_class_master', 'Мастер класса', 'Класс прокачан до 10 уровня. Счётчик растёт с каждым классом-десяткой.', '🎓', 'milestone', false, '{"xp":"class_master","level":10}', 91),
  ('xp_polymath', 'Полимат', 'Три класса прокачаны до 5 уровня и выше.', '📚', 'milestone', false, '{"xp":"polymath","classes":3,"level":5}', 92),
  ('xp_level_up', 'Level Up', 'Новый уровень! Тихое начисление: на полке не показывается, только в выписке.', '⬆️', 'milestone', false, '{"xp":"level_up","silent":true}', 93),
  ('xp_necromancer', 'НЕКРОМАНТ', 'Оживил мёртвого: продажа клиенту, который молчал больше года.', '💀', 'rare', false, '{"xp":"necromancer","silenceDays":365}', 94),
  ('quest_streak_10', 'Квестоман', 'Десять выполненных квестов подряд без провала. Активируется с запуском квестов.', '🗺️', 'rare', false, '{"quest":"streak","count":10,"stub":true}', 95),
  ('quest_week_all', 'Пятилетка за неделю', 'Все недельные квесты недели закрыты. Активируется с запуском квестов.', '📅', 'rare', false, '{"quest":"week_all","stub":true}', 96),
  ('quest_month_daily', 'Без пропусков', 'Месяц без единого проваленного дневного квеста. Активируется с запуском квестов.', '🛡️', 'rare', false, '{"quest":"month_daily","stub":true}', 97)
ON CONFLICT (key) DO NOTHING;

-- Квесты ещё не реализованы — определения выключены до запуска.
UPDATE badge_definitions SET enabled = false WHERE key IN ('quest_streak_10','quest_week_all','quest_month_daily') AND criteria ? 'stub';

INSERT INTO badge_prices (badge_key, tier, price) VALUES
  ('xp_first_group', '-', 15),
  ('xp_class_master', '-', 150),
  ('xp_polymath', '-', 200),
  ('xp_level_up', '-', 5),
  ('xp_necromancer', '-', 100),
  ('quest_streak_10', '-', 50),
  ('quest_week_all', '-', 30),
  ('quest_month_daily', '-', 100)
ON CONFLICT (badge_key, tier) DO NOTHING;
