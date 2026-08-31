-- Миграция 189 (заведена как 186, переномерована: 186–188 заняты параллельной
-- задачей про формулы метрик): право-джокер «Все разделы» (section.*) для роли «Администратор»
-- БД: YC system. Накат:
--   node migrations/run_local.mjs migrations/189_role_all_sections_wildcard.sql
-- УЖЕ НАКАТАНА 31.08 (проверено: у «Администратора» есть 'section.*'); повторный
-- запуск безопасен — UPDATE защищён условием NOT ('section.*' = ANY(permissions)).
--
-- Жалоба владельца 31.08: «почему-то на роль администратор автоматически не
-- добавляются в видимость все разделы». Так и было устроено: каталог прав
-- (lib/auth/perms.ts) растёт без миграций, а roles.permissions хранит
-- ПЕРЕЧИСЛЕНИЕ ключей — значит каждый новый раздел нужно было доставлять галкой
-- руками. По факту у «Администратора» не хватало четырёх:
--   section.realization, section.year_weekly, section.employees, section.presentation.
--
-- Лечим двумя движениями:
--  1) выдаём джокер 'section.*' — hasPerm() пропускает по нему ЛЮБОЙ section.*,
--     включая будущие разделы (см. ALL_SECTIONS_PERM в lib/auth/perms.ts);
--  2) на всякий случай не трогаем уже выданные ключи — джокер аддитивен, а
--     явные ключи остаются валидными сами по себе.
--
-- На action.* джокер сознательно НЕ распространяется: право что-то менять
-- (планы, пользователи, общие отчёты, чаты) выдаётся пофамильно, как и раньше.

UPDATE roles
SET permissions = (
      SELECT ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['section.*']))
    ),
    updated_at = now()
WHERE name = 'Администратор'
  AND NOT ('section.*' = ANY(permissions));

-- Проверка: у «Администратора» должен появиться 'section.*'.
SELECT name, permissions FROM roles WHERE name = 'Администратор';
