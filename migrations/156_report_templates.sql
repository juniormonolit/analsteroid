-- Шаблоны конструктора отчётов «Мой отчёт» (спека REPORT_CONSTRUCTOR_SPEC.md,
-- ответ владельца №1: «шаблоны сохраняются, причём предустановленные по роли —
-- менеджеру открывается менеджерский, руководителю руководский; перестроил под
-- себя → сохранил как свой»).
--
-- Пресеты ПО РОЛИ живут в коде (lib/reports-builder/presets.ts), а не строками
-- здесь: они зависят от того, какие отделы человеку доступны в момент открытия,
-- то есть считаются на запрос и в таблице протухли бы. Здесь — только ЛИЧНЫЕ
-- шаблоны, то, что человек сохранил сам.
--
-- Состояние одним jsonb, а не колонкой на поле (в отличие от saved_reports, где
-- их четыре десятка): у конструктора состояние маленькое и меняется вместе со
-- спекой, а каждая новая колонка — ещё одна миграция на два стенда.
-- Форма state: { period, entities: [{kind,id?}], metricIds: [] }. Дата НЕ
-- хранится — отчёт всегда про «сегодня», иначе сохранённый шаблон однажды
-- соберёт отчёт за прошлый март и человек этого не заметит.
--
-- СИСТЕМНАЯ БД (YC), вручную, ОТДЕЛЬНО на dev (junibaseone) и prod (system):
--   с ноутбука: node migrations/run_local.mjs migrations/156_report_templates.sql
--   с сервера:  node migrations/run_system.mjs migrations/156_report_templates.sql
-- run_system.mjs — СЕРВЕРНЫЙ (внутри зашиты пути /home/junior/…), на ноутбуке
-- падает с MODULE_NOT_FOUND про pg.
-- DOWN: DROP TABLE report_templates;

CREATE TABLE IF NOT EXISTS report_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_login    text        NOT NULL,
  name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  state         jsonb       NOT NULL,
  -- Шаблон, который открывается сразу при заходе в раздел. Один на человека —
  -- поддерживается частичным уникальным индексом ниже.
  is_default    boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Шаблоны видны ТОЛЬКО автору (как user_report_groups): все запросы жёстко по
-- user_login, чужие недоступны by construction.
CREATE INDEX IF NOT EXISTS report_templates_user_idx
  ON report_templates (user_login, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS report_templates_user_name_uniq
  ON report_templates (user_login, name);

CREATE UNIQUE INDEX IF NOT EXISTS report_templates_user_default_uniq
  ON report_templates (user_login) WHERE is_default;

COMMENT ON TABLE report_templates IS
  'Личные шаблоны конструктора «Мой отчёт». Пресеты по роли — в коде (lib/reports-builder/presets.ts), здесь только сохранённое человеком.';
COMMENT ON COLUMN report_templates.state IS
  'Состояние конструктора: { period, entities, metricIds }. Без даты — отчёт всегда про сегодня.';
