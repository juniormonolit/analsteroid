-- «Зебра» (правка владельца 09.07): лёгкая полосатость чётных строк ReportTable —
-- опция в объединённой панели «Настройки отчёта» → «Вид». NULL/false = выкл (текущее
-- поведение, вариант C без зебры) — старые сохранённые отчёты без этого поля читаются
-- как выкл (см. SalesReportPage: setZebra(preset.zebra ?? false)). БД: YC system
-- (run_system.mjs).
ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS zebra boolean;
