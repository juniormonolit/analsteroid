-- «Смекалочная»: общие сохранённые отчёты. Видны всем пользователям,
-- сохранять/перезаписывать может только админ (enforced в API по session.isAdmin).
-- Существующие отчёты «Смекалов — *» переезжают туда, префикс убирается из названия.
-- БД: YC system (run_system.mjs).
ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT false;

UPDATE saved_reports
   SET is_shared = true,
       name = regexp_replace(name, '^Смекалов\s*—\s*', '')
 WHERE name ~ '^Смекалов\s*—';
