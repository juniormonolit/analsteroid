-- 242: старые отчёты «Маркетинга» — на группировки маркетолога (решение владельца 22.10).
-- builtin_key связывает группировку со встроенным разрезом справочника (brand, ad_channel, …):
-- где отчёт/сохранённый отчёт/ссылка просит встроенный разрез, движок берёт связанную группировку
-- (lib/marketing/groupings.ts: canonicalDimension). Удалили группировку — разрез вернётся на колонку.
-- Связываются стартовые группировки из засева 239 (по имени, только если связи ещё нет).
-- БД: system. Идемпотентна. Откат: ALTER TABLE marketing_groupings DROP COLUMN builtin_key;
ALTER TABLE marketing_groupings ADD COLUMN IF NOT EXISTS builtin_key text;
CREATE UNIQUE INDEX IF NOT EXISTS marketing_groupings_builtin_key_uq
  ON marketing_groupings (builtin_key) WHERE builtin_key IS NOT NULL;

UPDATE marketing_groupings g SET builtin_key = v.key
  FROM (VALUES ('Канал (крупно)', 'channel_group'), ('Канал', 'ad_channel'), ('Бренд', 'brand'),
               ('Витрина', 'platform'), ('Тип контакта', 'contact_type')) AS v(name, key)
 WHERE g.name = v.name
   AND NOT EXISTS (SELECT 1 FROM marketing_groupings x WHERE x.builtin_key = v.key);
