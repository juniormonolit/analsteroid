-- 258: личные настройки интерфейса на аккаунте (владелец 29.10: «выбранный в канбане отдел должен сохраняться на
-- аккаунте»). jsonb — ключи из белого списка /api/me/ui-prefs (сейчас: repeatKanbanDepts). Переживает смену
-- устройства и браузера. Колонка — у существующей таблицы users: права приложения уже есть.
-- Откат: ALTER TABLE users DROP COLUMN ui_prefs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
