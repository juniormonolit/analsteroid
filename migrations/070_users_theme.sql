-- Тёмная тема (владелец утвердил макет owners-inbox/analsteroid-dark-theme-mock.html,
-- задача Николая): users.theme — серверная персонализация per-user, тот же паттерн,
-- что users.table_scale (миграция 069) / users.ui_mode.
--
-- Дефолт 'light' (п.4 брифа: «Дефолт — светлая»). Значение читает ТОЛЬКО
-- /api/me/theme (см. app/api/me/theme/route.ts) — НАМЕРЕННО не добавлено в
-- lib/auth/session.ts (тот же довод, что и для table_scale: getSession() на пути
-- КАЖДОГО запроса всех layout.tsx — если бы колонка читалась там, эта миграция стала
-- бы блокером всего сайта до наката). Отдельный SELECT — при отсутствующей колонке
-- падает только этот эндпоинт, хук useTheme() фолбэкает на 'light', ЛК и сайт
-- продолжают работать.
--
-- Мгновенное применение без вспышки светлого при загрузке — инлайн-скрипт в
-- app/layout.tsx читает зеркало localStorage.theme ДО первой отрисовки; серверное
-- значение синхронизируется хуком useTheme() после логина/загрузки (на случай смены
-- устройства/сессии).
--
-- БД: YC system. НЕ применять локально — накатывает Артём на проде атомарно.

ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'light';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_theme_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_theme_check
      CHECK (theme IN ('light', 'dark'));
  END IF;
END $$;
