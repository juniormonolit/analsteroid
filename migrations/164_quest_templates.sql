-- 164: конструктор квестов — шаблоны выдачи (задача 60).
--
-- Решение владельца: делать СРАЗУ уровень 3, то есть не только «шаблон на одной
-- из встроенных категорий», но и квест на ПРОИЗВОЛЬНУЮ метрику каталога
-- (`metrics`). Поэтому у шаблона два вида:
--
--   kind='category' — встроенная категория (`quests.category`), у каждой своя
--                     логика подбора цели и подсчёта прогресса в движке;
--   kind='metric'   — любая collected-метрика каталога источника `deals`
--                     (и calculated поверх таких). Прогресс считает общий
--                     вычислитель через buildCollectedSQL — тот же SQL, что
--                     строит ячейку отчёта, никаких параллельных формул.
--
-- Что НЕ поддержано у kind='metric' и почему: метрики source='deal_events',
-- external (планы, звонки, снимки стадий) и calculated поверх них. У них свои
-- движки без универсальной разбивки по (менеджер × период) — ровно то же
-- ограничение, что у графика метрики (features/reports/engine/metricSeries.ts).
-- Форма конструктора такие метрики не предлагает, а API их отклоняет.

CREATE TABLE IF NOT EXISTS quest_templates (
  id bigserial PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  name text NOT NULL,                       -- админское имя шаблона (в выдаче не видно)
  kind text NOT NULL CHECK (kind IN ('category','metric')),
  category text CHECK (category IN
    ('sales_count','sales_amount','group_sales','repeat_sales','crosssell',
     'distinct_groups','bookings_count')),
  metric_id text,                           -- metrics.id, когда kind='metric'
  period_type text NOT NULL CHECK (period_type IN ('day','week','month')),

  -- Способ расчёта цели. personal_p75 — как у встроенных кандидатов: планка по
  -- личному p75, пол по медиане компании, потолок по личному p90.
  target_mode text NOT NULL DEFAULT 'personal_p75'
    CHECK (target_mode IN ('personal_p75','personal_median','company_median','fixed')),
  target_fixed numeric CHECK (target_fixed IS NULL OR target_fixed > 0),
  target_floor numeric,                     -- NULL = медиана компании за период
  target_ceiling numeric,                   -- NULL = личный p90

  reward_eballs int CHECK (reward_eballs IS NULL OR reward_eballs >= 0),  -- NULL = по тиру
  weight numeric NOT NULL DEFAULT 1 CHECK (weight >= 0),  -- балл в сортировке кандидатов
  audience jsonb NOT NULL DEFAULT '{}'::jsonb,            -- {deptIds:[],managerIds:[],minLevel:n}
  title_template text,                      -- «Забронируй {target} до конца недели»; NULL = авто

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quest_templates_kind_target CHECK (
    (kind = 'category' AND category IS NOT NULL AND metric_id IS NULL) OR
    (kind = 'metric'   AND metric_id IS NOT NULL AND category IS NULL)
  ),
  CONSTRAINT quest_templates_fixed_needs_value CHECK (
    target_mode <> 'fixed' OR target_fixed IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS quest_templates_live_idx
  ON quest_templates (period_type) WHERE enabled;

-- Квест, выданный по шаблону, помнит какому. Нужно и для аудита («откуда это
-- взялось»), и чтобы выключенный шаблон не мешал уже выданным квестам дожить
-- свой период: прогресс считается по metric_id из самой строки квеста, а не по
-- шаблону, который к тому времени могли отредактировать.
ALTER TABLE quests ADD COLUMN IF NOT EXISTS template_id bigint;
ALTER TABLE quests ADD COLUMN IF NOT EXISTS metric_id text;

-- Категория 'metric' — квест на произвольную метрику каталога. Отдельным
-- значением, а не NULL-ом в category: колонка NOT NULL, и весь движок читает
-- её как дискриминатор.
ALTER TABLE quests DROP CONSTRAINT IF EXISTS quests_category_check;
ALTER TABLE quests ADD CONSTRAINT quests_category_check CHECK (category IN
  ('sales_count','sales_amount','group_sales','repeat_sales','crosssell',
   'distinct_groups','bookings_count','metric'));
ALTER TABLE quests DROP CONSTRAINT IF EXISTS quests_metric_needs_id;
ALTER TABLE quests ADD CONSTRAINT quests_metric_needs_id CHECK (
  category <> 'metric' OR metric_id IS NOT NULL
);

-- Доска контрактов категорию 'metric' НЕ получает: контракты генерятся пулом
-- без шаблонов, а разрешить значение, которое там некому создать, — значит
-- завести мёртвую ветку в contractProgress.
