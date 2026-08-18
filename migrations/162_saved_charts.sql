-- Сохранённые графики конструктора (задача владельца 18.08: «сохранить построенный
-- график в списке (как отчёты)»). В отличие от saved_reports (колонка на каждое
-- поле, 6 миграций доработок) конфиг лежит одним jsonb: конструктор графиков будет
-- расти (оси, типы, фильтры), и каждое новое поле не должно требовать миграции.
-- СИСТЕМНАЯ БД (YC), применяется вручную run_local.mjs на system И junibaseone.
-- DOWN: DROP TABLE saved_charts;

CREATE TABLE IF NOT EXISTS saved_charts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_login TEXT NOT NULL,
  name       TEXT NOT NULL,
  config     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_login, name)
);

COMMENT ON TABLE saved_charts IS
  'Сохранённые графики конструктора (раздел «Графики»). config — полное состояние конструктора: измерение, тип графика, метрики осей, пилюли, товарные группы. Схему конфига валидирует app/api/charts/saved/route.ts.';
