-- DEV ONLY (не накатывать на прод): тестовые zzz_-пользователи для проверки пилота
-- «Канбан РОПа» (#9625). Пароль/хэш копируется у существующего zzz_scope_rop — новых секретов нет.
--   zzz_rop_kanban       — роль РОП, оргпривязка как у zzz_scope_rop (зона отдела) + личный доступ к пилоту
--   zzz_rop_kanban_admin — роль «Администратор» (полный охват по action.rop_today.full_access) + личный доступ
-- Контроль «нет доступа»: zzz_scope_admin (Администратор без оверрайда), zzz_scope_rop (РОП без оверрайда).
INSERT INTO users (login, password_hash, bitrix_user_id, display_name, is_admin, role_id, section_overrides)
SELECT v.login, src.password_hash, v.bx, v.dn, false, (SELECT id FROM roles WHERE name = v.role), ARRAY['section.rop_kanban_pilot']
  FROM (VALUES ('zzz_rop_kanban', '1860', 'ZZZ РОП канбан', 'РОП'),
               ('zzz_rop_kanban_admin', NULL, 'ZZZ Админ канбан', 'Администратор')) AS v(login, bx, dn, role)
 CROSS JOIN (SELECT password_hash FROM users WHERE login = 'zzz_scope_rop') src
 WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.login = v.login);

-- Контроль «супер-админ без оверрайда» (admin на деве — общая учётка, пароль не наш): отдельный zzz_.
INSERT INTO users (login, password_hash, bitrix_user_id, display_name, is_admin, is_superadmin, role_id)
SELECT 'zzz_scope_super', src.password_hash, NULL, 'ZZZ Супер-админ без оверрайда', false, true, (SELECT id FROM roles WHERE name = 'Администратор')
  FROM (SELECT password_hash FROM users WHERE login = 'zzz_scope_rop') src
 WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.login = 'zzz_scope_super');
