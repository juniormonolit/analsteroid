-- Populate short_login from employees.bitrix_login
-- Rule: if login matches ^manager\d+$ → '#' + digits; else full login
UPDATE org_resolved_hierarchy orh
SET short_login = CASE
  WHEN e.bitrix_login ~ '^manager[0-9]+$'
    THEN '#' || regexp_replace(e.bitrix_login, '^manager', '', 'g')
  ELSE e.bitrix_login
END
FROM employees e
WHERE orh.manager_bitrix_user_id::text = e.bitrix_user_id
  AND e.bitrix_login IS NOT NULL;
