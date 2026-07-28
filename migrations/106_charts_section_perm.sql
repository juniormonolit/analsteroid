-- БД: YC system (таблица roles). Раздел «Графики» (задача владельца 28.07).
-- Ключ section.charts добавлен в каталог прав (lib/auth/perms.ts). Правило выдачи:
-- всем ролям, у которых есть section.sales — графики строятся на тех же данных
-- отчётов о продажах, отдельного уровня секретности нет. Кастомным ролям без
-- section.sales супер-админ выдаёт руками в /settings/roles.
-- НЕ ПУТАТЬ с section.chats не существует — чаты гейтятся по action.deal_chats.
-- Идемпотентно.

UPDATE roles
SET permissions = array_append(permissions, 'section.charts')
WHERE 'section.sales' = ANY(permissions)
  AND NOT ('section.charts' = ANY(permissions));
