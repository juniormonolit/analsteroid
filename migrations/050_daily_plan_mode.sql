-- Пункт 7 согласованной спеки (решение собрания 08.07): дневной план по умолчанию
-- считается как месячный план ÷ 20 (константа, не зависит от факт. числа будней),
-- а не через производственный календарь (working_calendar). Режим — глобальный,
-- переключается ТОЛЬКО супер-админом (/settings/daily-plan-mode), working_calendar
-- и /settings/working-calendar остаются как альтернативный режим 'calendar'.
-- Настройка хранится в plan_settings (singleton, id=1) — тот же паттерн, что и plan_n.
-- БД: YC system.

ALTER TABLE plan_settings ADD COLUMN IF NOT EXISTS daily_plan_mode text NOT NULL DEFAULT 'divide20';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_settings_daily_plan_mode_check'
  ) THEN
    ALTER TABLE plan_settings
      ADD CONSTRAINT plan_settings_daily_plan_mode_check
      CHECK (daily_plan_mode IN ('divide20', 'calendar'));
  END IF;
END $$;
