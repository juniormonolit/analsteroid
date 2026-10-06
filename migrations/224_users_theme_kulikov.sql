-- Пятая тема «Дизайн Куликова» (значение 'kulikov', задача #8857, 06.10.2026).
-- Визуальный язык monolit.shop по макетам
-- docs/design/monolitika-redesign-monolitshop-20261006/, токены —
-- app/styles/tokens/theme-kulikov.css.
--
-- Что делает миграция:
--   1) расширяет CHECK users_theme_check до пяти значений
--      ('classic','light','dark','mono','kulikov');
--   2) включает новую тему пользователю с логином kulikov — ТОЛЬКО если у него сейчас
--      'classic'.
--
-- DEFAULT колонки НЕ меняется: у всех остальных и у новых пользователей по умолчанию
-- по-прежнему 'classic'.
--
-- Почему условие именно theme = 'classic' (тот же довод, что в миграции 148):
-- 'classic' — это DEFAULT колонки, то есть «сам не выбирал». Если у kulikov стоит
-- light/dark/mono — он переключал тему руками, и его выбор не трогаем. Отличить
-- «оставил классическую сознательно» от «не трогал настройку» по данным нельзя;
-- вернуть классическую — один клик в ЛК, и после этого миграция её больше не перебьёт
-- (она одноразовая).
--
-- Если пользователя с логином kulikov в базе нет — UPDATE затронет 0 строк, это не
-- ошибка: тему он включит сам в ЛК («Настройки профиля» → «Тема оформления»).
--
-- Без этой миграции пункт «Дизайн Куликова» в ЛК виден и применяется на экране, но
-- PATCH /api/me/theme падает на CHECK — выбор не сохранится (интерфейс покажет ошибку
-- сохранения, см. lib/hooks/useTheme.ts).
--
-- БД: YC system. Идемпотентна — повторный прогон безопасен.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_theme_check') THEN
    ALTER TABLE users DROP CONSTRAINT users_theme_check;
  END IF;

  ALTER TABLE users
    ADD CONSTRAINT users_theme_check
    CHECK (theme IN ('classic', 'light', 'dark', 'mono', 'kulikov'));
END $$;

UPDATE users SET theme = 'kulikov' WHERE lower(login) = 'kulikov' AND theme = 'classic';

COMMENT ON COLUMN users.theme IS
  'Тема оформления: classic (плоский вид до редизайна, дефолт), light/dark/mono — стеклянные темы «Монолитика Glass» (в интерфейсе: Светлое/Синее/Серое стекло), kulikov — «Дизайн Куликова» в стиле monolit.shop.';
