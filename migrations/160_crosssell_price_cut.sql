-- Срез цен кросс-селла вдвое (задача 3001, решение владельца 06.08.2026 по
-- отчёту ECONOMY_HEALTH_20260806.md).
--
-- ДИАГНОЗ. Награды июля, пересчитанные по нынешним ценам, дают 66 955 MLT/мес =
-- 334 775 ₽ при потолке 300 000 ₽. Из них 57 % — одиннадцать наград:
-- десять crosssell_* плюс «Мастер комбо». 317 выдач на 38 174 MLT, средняя
-- награда 120 MLT — вчетверо дороже средней по системе. Ребаланс v2 масштабировал
-- их вместе со всеми (×0,35), но они и до него были самыми дорогими в каталоге,
-- поэтому пропорциональный срез их не выровнял.
--
-- ЧТО ДЕЛАЕМ. Все цены кросс-селла ×0,5: 38 174 → ~19 000 MLT/мес, общая эмиссия
-- ~47 800 MLT = 239 000 ₽ — под потолком с запасом под дерево скиллов.
-- Тем же множителем режем ступени ветки «Кросс-селл» (`skill_branch_steps` +
-- строки `badge_prices` с тирами s1…s5): её первая ступень наследовала цену
-- «Мастера комбо», из-за чего верхняя ступень стоила 1 171 MLT — почти как
-- платина за страну.
--
-- ВАЖНО: цены применяются в момент НАЧИСЛЕНИЯ, задним числом ничего не
-- пересчитывается. Уже выданные баллы остаются как есть.
--
-- СИСТЕМНАЯ БД (YC). Применяется вручную migrations/run_local.mjs.
-- 06.08.2026 применена на dev (junibaseone); 11.08.2026 накатана и на прод
-- (system) — владелец снял режим «только дев».
-- DOWN: восстановить из badge_prices_backup_crosssell_20260806 и
--   skill_branch_steps_backup_20260806.

CREATE TABLE IF NOT EXISTS badge_prices_backup_crosssell_20260806 (
  badge_key text, tier text, price int, backed_up_at timestamptz DEFAULT now()
);
INSERT INTO badge_prices_backup_crosssell_20260806 (badge_key, tier, price)
  SELECT badge_key, tier, price FROM badge_prices
   WHERE (badge_key LIKE 'crosssell%' OR badge_key = 'combo_master')
     AND NOT EXISTS (SELECT 1 FROM badge_prices_backup_crosssell_20260806);

CREATE TABLE IF NOT EXISTS skill_branch_steps_backup_20260806 (
  branch_key text, step int, price int, backed_up_at timestamptz DEFAULT now()
);
INSERT INTO skill_branch_steps_backup_20260806 (branch_key, step, price)
  SELECT branch_key, step, price FROM skill_branch_steps
   WHERE branch_key = 'crosssell'
     AND NOT EXISTS (SELECT 1 FROM skill_branch_steps_backup_20260806);

UPDATE badge_prices
   SET price = GREATEST(1, round(price * 0.5)::int)
 WHERE (badge_key LIKE 'crosssell%' OR badge_key = 'combo_master')
   AND price > 1;

UPDATE skill_branch_steps
   SET price = GREATEST(1, round(price * 0.5)::int)
 WHERE branch_key = 'crosssell' AND price > 1;
