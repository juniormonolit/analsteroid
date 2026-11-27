-- 303: «Задачник» в избранное меню всем (правка владельца 27.11: «в избранное всем "задачник" поставь»).
-- Тем, у кого избранное ещё не сохранено, он приходит из DEFAULT_NAV_FAVORITES (components/layout/navFavorites.ts).
-- Здесь — тем, кто уже менял избранное (ключ ui_prefs.navFavorites есть): дописываем '/tasker' первым,
-- если его там нет. Повторный запуск ничего не меняет. Права не нужны: колонка у users (миграция 258).
-- Откат: UPDATE users SET ui_prefs = jsonb_set(ui_prefs, '{navFavorites}', (ui_prefs->'navFavorites') - '/tasker')
--        WHERE ui_prefs ? 'navFavorites';  (уберёт и у тех, кто ставил сам)
UPDATE users
   SET ui_prefs = jsonb_set(ui_prefs, '{navFavorites}', '["/tasker"]'::jsonb || (ui_prefs->'navFavorites'))
 WHERE jsonb_typeof(ui_prefs->'navFavorites') = 'array'
   AND NOT (ui_prefs->'navFavorites') ? '/tasker';
