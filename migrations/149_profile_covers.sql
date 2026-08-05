-- Обложки профиля (ЛК-соцсетка, этап 2, задача владельца 05.08): выбранная
-- пользователем шапка профиля. Каталог обложек и условия разблокировки живут
-- В КОДЕ (lib/profile/covers.ts — генеративные CSS-паттерны, картинок нет),
-- БД хранит только выбор. Валидация «разблокирована ли» — на POST
-- /api/profile/cover по уровням классов XP (fetchXpProfile).
--
-- СИСТЕМНАЯ БД (YC) — применяется вручную migrations/run_system.mjs, ОТДЕЛЬНО
-- на dev (junibaseone) и на prod (system) — это НЕ одна и та же БД.
-- DOWN: DROP TABLE profile_covers;

CREATE TABLE IF NOT EXISTS profile_covers (
  bitrix_id  integer PRIMARY KEY,      -- менеджер (bitrix_user_id)
  cover_id   text NOT NULL,            -- id из каталога lib/profile/covers.ts
  updated_at timestamptz NOT NULL DEFAULT now()
);
