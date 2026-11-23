-- 282: «Задачник» — темы задач правятся в конструкторе (задача владельца 23.11).
-- Тема = строка tasker_metrics (на неё уже ссылаются tasker_tasks/sessions/templates — новую таблицу не заводим,
-- история старых задач сохраняется как есть). Два типа:
--   metric        — показатель каталога отчётов (lib/metrics/catalog.ts, любой, не только 10 базовых);
--                   id темы = id метрики каталога (снимок/замер — ячейка отчёта «По менеджерам», как раньше);
--   product_group — «материалы по товарной группе»: id темы = 'pg_<id группы>_<amount|share>', снимок/замер —
--                   отчёт «По менеджерам» с фильтром по товарной группе (productGroupId, шкала kc —
--                   sa.product_groups), «Сумма продаж» (all_sales_amount) группы или её доля в продажах менеджера.
-- Архив вместо удаления: active = false (+ archived_at); архивная тема пропадает из формы, старые задачи с ней
-- считаются и показываются дальше.
-- Существующие 10 строк → kind = 'metric' (DEFAULT).
-- БД: monolitika (systemDb). Накат — под monolitik; права на tasker_metrics уже выданы в 274
-- (добавились только колонки). Идемпотентна.
-- Откат: ALTER TABLE tasker_metrics DROP COLUMN kind, DROP COLUMN product_group_id, DROP COLUMN pg_measure,
--        DROP COLUMN archived_at, DROP COLUMN created_by, DROP COLUMN updated_by, DROP COLUMN updated_at;
--        вернуть CHECK grp без 'product'.

ALTER TABLE tasker_metrics
  ADD COLUMN IF NOT EXISTS kind             text NOT NULL DEFAULT 'metric',
  ADD COLUMN IF NOT EXISTS product_group_id text,          -- sa.product_groups.id (шкала kc), только kind = product_group
  ADD COLUMN IF NOT EXISTS pg_measure       text,          -- amount — сумма продаж группы, share — доля в продажах менеджера
  ADD COLUMN IF NOT EXISTS archived_at      timestamptz,
  ADD COLUMN IF NOT EXISTS created_by       text,          -- login (NULL — базовые из 274)
  ADD COLUMN IF NOT EXISTS updated_by       text,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasker_metrics_kind_check') THEN
    ALTER TABLE tasker_metrics ADD CONSTRAINT tasker_metrics_kind_check CHECK (
      (kind = 'metric' AND product_group_id IS NULL AND pg_measure IS NULL)
      OR (kind = 'product_group' AND product_group_id IS NOT NULL AND pg_measure IN ('amount', 'share')));
  END IF;
END $$;

-- Группа тем «Товарные группы».
ALTER TABLE tasker_metrics DROP CONSTRAINT IF EXISTS tasker_metrics_grp_check;
ALTER TABLE tasker_metrics ADD CONSTRAINT tasker_metrics_grp_check
  CHECK (grp IN ('conversion', 'check', 'activity', 'repeat', 'product'));

-- Одна тема на товарную группу и способ замера.
CREATE UNIQUE INDEX IF NOT EXISTS tasker_metrics_pg_uniq
  ON tasker_metrics (product_group_id, pg_measure) WHERE kind = 'product_group';
