-- Бриф владельца от 09.07 (owners-inbox/analsteroid-edits-spec-20260709.md), пп.2-3.
--
-- П.2 «Корзина отчётов»: удаление сохранённого отчёта (личного или витринного)
-- перестаёт быть настоящим DELETE — вместо него проставляется deleted_at/deleted_by,
-- запись остаётся в таблице и попадает в раздел «Корзина» (сайдбар), откуда можно
-- «Восстановить» (deleted_at = NULL) или «Удалить навсегда» (настоящий DELETE,
-- см. app/api/saved-reports/[id]/permanent/route.ts). Автоочистка (>30 дней) —
-- ленивая, при обращении к списку корзины (GET /api/saved-reports/trash), без крона.
--
-- Партиционные уникальные индексы 058 (личное имя) и 055 (имя витрины) сужены ещё раз:
-- добавлен deleted_at IS NULL, чтобы новый отчёт мог занять имя, которое сейчас лежит
-- в корзине (иначе создать репорт с тем же именем нельзя, пока корзина не очищена).
--
-- П.3 «Масштаб таблиц» в ЛК: users.table_scale — серверная персонализация per-user,
-- тот же паттерн, что users.ui_mode (миграция под Права v2 не заводилась отдельно —
-- ui_mode колонка появилась раньше этого брифа). Три фиксированных шага 85/100/115% —
-- см. отчёт задачи (сегмент-переключатель, а не слайдер 80-120 — решение по вкусу,
-- тот же UI-паттерн, что «Про/Лайт»).
--
-- БД: YC system. НЕ применять локально — накатывает Артём на проде атомарно.

ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;
ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS deleted_by text NULL;

CREATE INDEX IF NOT EXISTS saved_reports_deleted_at_idx
  ON saved_reports (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Пересоздаём партиционные unique-индексы 058/055 с добавленным deleted_at IS NULL
-- (совпадает с ON CONFLICT ... WHERE в app/api/saved-reports/route.ts — Postgres
-- требует буквального совпадения выражения индекса и ON CONFLICT).
DROP INDEX IF EXISTS saved_reports_personal_user_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS saved_reports_personal_user_name_unique
  ON saved_reports (user_login, name)
  WHERE NOT is_shared AND deleted_at IS NULL;

DROP INDEX IF EXISTS saved_reports_shared_section_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS saved_reports_shared_section_name_unique
  ON saved_reports (shared_section, name)
  WHERE is_shared = true AND shared_section IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS table_scale SMALLINT NOT NULL DEFAULT 100;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_table_scale_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_table_scale_check
      CHECK (table_scale IN (85, 100, 115));
  END IF;
END $$;
