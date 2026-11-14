-- Задача #11110: ручная дата начала привязывается к ФИО, при котором её поставили.
-- АНАЛИТИЧЕСКАЯ БД sa (self-hosted Supabase на 62). ПРИМЕНЯЕТСЯ supabase_admin ВРУЧНУЮ:
--   docker exec -i supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < 009_employee_registry_start_name.sql
-- ВНИМАНИЕ: у dev-стенда SA_PG смотрит в ту же боевую sa — отдельной dev-копии sa нет.
-- Применять только по «катай» Серёги вместе с выкаткой кода.
--
-- Только аддитивно: новая nullable-колонка + бэкфилл. Ничего не удаляется и не
-- перезаписывается (manual_start_date не трогаем).
--
-- Бэкфилл (план п.2):
--  * ФИО на учётке не менялось с момента внесения даты (нет строк истории с
--    valid_from > updated_at) → manual_start_name = текущее ФИО (дата действует);
--  * менялось → manual_start_name = ФИО, которое стояло на момент внесения
--    (updated_at). Оно не совпадает с текущим → приложение показывает дату как
--    устаревшую («не заполнено» + подсказка РОПу).
--  * подходящей строки истории нет → NULL; приложение верит дате, только если
--    человек на учётке не менялся с начала истории (13.07).
--
-- DOWN: ALTER TABLE sa.employee_registry DROP COLUMN IF EXISTS manual_start_name;

ALTER TABLE sa.employee_registry ADD COLUMN IF NOT EXISTS manual_start_name text;

COMMENT ON COLUMN sa.employee_registry.manual_start_name IS
  'ФИО на учётке в момент внесения manual_start_date (задача 11110). Не совпадает с текущим ФИО → дата устарела (учётка сменила хозяина).';

UPDATE sa.employee_registry r
   SET manual_start_name = coalesce(
         -- не менялось с внесения → текущее ФИО
         (SELECT h.name FROM sa.employee_name_history h
           WHERE h.bitrix_user_id = r.bitrix_id::text AND h.valid_to IS NULL
             AND NOT EXISTS (SELECT 1 FROM sa.employee_name_history h2
                              WHERE h2.bitrix_user_id = r.bitrix_id::text AND h2.valid_from > r.updated_at)
           ORDER BY h.valid_from DESC LIMIT 1),
         -- менялось → ФИО на момент внесения
         (SELECT h.name FROM sa.employee_name_history h
           WHERE h.bitrix_user_id = r.bitrix_id::text
             AND h.valid_from <= r.updated_at AND (h.valid_to IS NULL OR h.valid_to > r.updated_at)
           ORDER BY h.valid_from DESC LIMIT 1))
 WHERE r.manual_start_date IS NOT NULL AND r.manual_start_name IS NULL;

-- junior_user уже имеет SELECT/INSERT/UPDATE на таблицу (002) — колонка покрыта.
