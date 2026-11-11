-- Сид: правка планов отгрузок НОЯБРЯ 2026 (поручение владельца 11.11)
-- Источник: «2026 Декомпозиция (Основная) (4).xlsx», лист «Менеджеры», B/O, строки 7–232
-- (тот же разбор, что seed_plans_november2026.sql). Изменился только блок КРД:
--   #302 5 000 000 → 4 000 000   #303 7 000 000 → 5 900 000
--   #308 5 000 000 → 4 240 000   #310 4 000 000 → 3 000 000
--   #311 — → 2 000 000 (новый)
--   #301, #305, #313 — ячейка опустела → план удалён (как «не задан» при первой заливке)
-- Итог 92 менеджера / 325 265 000 ₽ (= O5 «ВСЕГО»; было 94 / 333 125 000).
-- До правки ноябрь в БД с 04.11 никто не трогал. Бэкап — manager_plans_backup_nov26_v1.

BEGIN;

CREATE TABLE IF NOT EXISTS manager_plans_backup_nov26_v1 AS
  SELECT * FROM manager_plans WHERE month = '2026-11-01';

DELETE FROM manager_plans WHERE month = '2026-11-01'
  AND manager_login IN ('#301', '#305', '#313');

INSERT INTO manager_plans (manager_login, month, plan_shipments, plan_n) VALUES
('#302', '2026-11-01', 4000000, 0.8),
('#303', '2026-11-01', 5900000, 0.8),
('#308', '2026-11-01', 4240000, 0.8),
('#310', '2026-11-01', 3000000, 0.8),
('#311', '2026-11-01', 2000000, 0.8)
ON CONFLICT (manager_login, month)
DO UPDATE SET plan_shipments = EXCLUDED.plan_shipments, plan_n = EXCLUDED.plan_n, updated_at = NOW();

DO $$
DECLARE n int; s numeric;
BEGIN
  SELECT count(*), sum(plan_shipments) INTO n, s FROM manager_plans WHERE month = '2026-11-01';
  IF n <> 92 OR s <> 325265000 THEN
    RAISE EXCEPTION 'Контрольная сумма ноября не сошлась: % строк, % ₽', n, s;
  END IF;
END $$;

COMMIT;
