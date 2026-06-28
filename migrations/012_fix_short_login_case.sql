-- Fix short_login: case-insensitive match for manager logins (Manager8, manager8, MANAGER8)
UPDATE org_resolved_hierarchy orh
SET short_login = CASE
  WHEN lower(e.bitrix_login) ~ '^manager[0-9]+$'
    THEN '#' || regexp_replace(lower(e.bitrix_login), '^manager', '', 'g')
  ELSE e.bitrix_login
END
FROM employees e
WHERE orh.manager_bitrix_user_id::text = e.bitrix_user_id
  AND e.bitrix_login IS NOT NULL;
