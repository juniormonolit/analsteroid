-- 239: структура маркетинговых источников (задача владельца 22.10). Руководитель маркетинга
-- сам заводит ГРУППИРОВКИ (оси разреза: «Канал», «Платный/бесплатный», …), в каждой — свои
-- ГРУППЫ, и раскладывает по ним источники Битрикса (deals.source_id). Источник в одной
-- группировке — максимум в одной группе. Инструмент — «Ещё → Источники» (/marketing-sources),
-- отчёт — «Маркетинг → Общий отчёт» (измерение `g:<id>` в движке by-sources).
-- Стартовые группировки засеваются из колонок marketing_sources (Канал (крупно), Канал, Бренд,
-- Витрина, Тип контакта) — только если таблица группировок пуста, чтобы не начинать с нуля.
-- БД: system. Идемпотентна. Откат: DROP TABLE marketing_source_groups, marketing_groups,
-- marketing_groupings; ALTER TABLE marketing_sources DROP COLUMN note;

ALTER TABLE marketing_sources ADD COLUMN IF NOT EXISTS note text;

CREATE TABLE IF NOT EXISTS marketing_groupings (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  sort       int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_groups (
  id          serial PRIMARY KEY,
  grouping_id int  NOT NULL REFERENCES marketing_groupings(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text,
  sort        int  NOT NULL DEFAULT 0,
  UNIQUE (grouping_id, name)
);

CREATE TABLE IF NOT EXISTS marketing_source_groups (
  grouping_id int  NOT NULL REFERENCES marketing_groupings(id) ON DELETE CASCADE,
  source_id   text NOT NULL,
  group_id    int  NOT NULL REFERENCES marketing_groups(id) ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grouping_id, source_id)
);
CREATE INDEX IF NOT EXISTS marketing_source_groups_group_idx ON marketing_source_groups (group_id);

DO $$
DECLARE
  seed record;
  gid int;
BEGIN
  IF EXISTS (SELECT 1 FROM marketing_groupings) THEN RETURN; END IF;
  FOR seed IN
    SELECT * FROM (VALUES
      (1, 'Канал (крупно)', 'channel_group'),
      (2, 'Канал',          'ad_channel'),
      (3, 'Бренд',          'brand'),
      (4, 'Витрина',        'platform'),
      (5, 'Тип контакта',   'contact_type')
    ) AS v(sort, name, col)
  LOOP
    INSERT INTO marketing_groupings (name, sort) VALUES (seed.name, seed.sort) RETURNING id INTO gid;
    EXECUTE format(
      'INSERT INTO marketing_groups (grouping_id, name, sort)
         SELECT $1, v, (row_number() OVER (ORDER BY count(*) DESC, v))::int
           FROM (SELECT %1$I AS v FROM marketing_sources WHERE %1$I IS NOT NULL AND %1$I <> '''') s
          GROUP BY v', seed.col) USING gid;
    EXECUTE format(
      'INSERT INTO marketing_source_groups (grouping_id, source_id, group_id)
         SELECT $1, ms.source_id, g.id
           FROM marketing_sources ms
           JOIN marketing_groups g ON g.grouping_id = $1 AND g.name = ms.%1$I', seed.col) USING gid;
  END LOOP;
END $$;
