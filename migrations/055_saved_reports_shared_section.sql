-- Пункт 3б согласованной спеки: вторая управляемая общая витрина «Роп монитор»,
-- наряду со «Смекалочной» (is_shared, migration 042) — одна механика, два раздела.
-- shared_section различает бакет для is_shared=true отчётов; NULL = личный отчёт
-- (не общий). Существующие общие отчёты («Смекалочная») переезжают в 'smekalochnaya'.
-- Партиционный уникальный индекс на (shared_section, name) даёт «перезаписывание»
-- общего отчёта ЛЮБЫМ админом (не только исходным автором) — app/api/saved-reports
-- ищет существующую строку по (shared_section, name) и обновляет её, а не создаёт
-- дубликат по (user_login, name), как для личных отчётов.
-- БД: YC system (run_system.mjs).
ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS shared_section text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'saved_reports_shared_section_check'
  ) THEN
    ALTER TABLE saved_reports
      ADD CONSTRAINT saved_reports_shared_section_check
      CHECK (shared_section IN ('rop_monitor', 'smekalochnaya'));
  END IF;
END $$;

UPDATE saved_reports
   SET shared_section = 'smekalochnaya'
 WHERE is_shared = true AND shared_section IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS saved_reports_shared_section_name_unique
  ON saved_reports (shared_section, name)
  WHERE is_shared = true AND shared_section IS NOT NULL;
