-- Пункт 3а согласованной спеки (analsteroid-edits-spec-agreed-20260708.md): тумблер
-- «Обычная/Про» в Личном кабинете. Хранится НА СЕРВЕРЕ per-user (не в браузере) —
-- между сессиями и устройствами.
-- NULL = наследовать дефолт от роли: «Администратор»/супер-админ → pro, остальные →
-- basic (см. lib/auth/perms.ts effectiveUiMode). Явное значение — пользователь
-- переключил сам, дефолт роли больше не участвует.
-- БД: YC system (run_system.mjs).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_mode text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_ui_mode_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_ui_mode_check CHECK (ui_mode IN ('basic', 'pro'));
  END IF;
END $$;
