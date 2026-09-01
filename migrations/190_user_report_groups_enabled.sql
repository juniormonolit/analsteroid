-- Миграция 190: тумблер вкл/выкл у пользовательских групп строк отчёта
-- БД: YC system. Накат:
--   node migrations/run_local.mjs migrations/190_user_report_groups_enabled.sql
--
-- Правка владельца 31.08: «нужно придумать, как сделать так, чтобы эти группы
-- сохранялись на аккаунте и могли легко включаться или выключаться». Группы и
-- так хранятся на аккаунте (110, per-user), но «выключить» можно было только
-- расформировав навсегда. Теперь у группы есть enabled: выключенная остаётся в
-- панели серым бейджем и не сворачивает свои строки; клик по бейджу — тумблер.
-- DOWN: ALTER TABLE user_report_groups DROP COLUMN IF EXISTS enabled;

ALTER TABLE user_report_groups
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
