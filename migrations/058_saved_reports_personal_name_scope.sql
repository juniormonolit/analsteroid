-- Баг (владелец, 09.07): «не работает сохранение в Отчёты Стаса/Роп монитор администратором».
-- Причина — миграция 020 добавила UNIQUE (user_login, name) на ВЕСЬ saved_reports ещё до
-- появления общих разделов (042/055). Когда админ уже имеет ЛИЧНЫЙ отчёт с именем X и
-- пытается сохранить (тем же именем X) отчёт в общий раздел (rop_monitor/smekalochnaya),
-- POST /api/saved-reports не находит существующую строку в shared_section (ищет только
-- среди is_shared=true) и уходит в INSERT с user_login = session.login — который падает
-- на table-wide unique (user_login, name), т.к. личная строка с тем же именем уже есть.
-- API отдаёт 500, фронтенд (SalesReportPage.handleSaveReport) не проверяет res.ok и молча
-- закрывает модалку — выглядит как «ничего не произошло», отчёт остаётся личным.
--
-- Воспроизведено живьём 09.07 (test_alfred_admin): POST personal name=X (200) → POST
-- shared smekalochnaya same name=X (500, unique_violation saved_reports_user_name_unique).
--
-- Фикс: сузить старый constraint до личных отчётов (partial unique index), чтобы одно и
-- то же имя могло одновременно существовать как личный отчёт автора И как общий отчёт —
-- уникальность общих имён внутри раздела уже обеспечена migration 055
-- (saved_reports_shared_section_name_unique).
-- БД: YC system (run_system.mjs).

ALTER TABLE saved_reports DROP CONSTRAINT IF EXISTS saved_reports_user_name_unique;

CREATE UNIQUE INDEX IF NOT EXISTS saved_reports_personal_user_name_unique
  ON saved_reports (user_login, name)
  WHERE NOT is_shared;
