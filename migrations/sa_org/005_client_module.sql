-- «Модули» → «Карточка клиента» (ТЗ владельца 13.10, будущий виджет в карточке
-- клиента Битрикса): ручные поля, которые менеджер заполняет в виджете.
-- АНАЛИТИЧЕСКАЯ БД sa (self-hosted Supabase 62.113.100.67) — НЕ системная YC и
-- НЕ контейнер analsteroid-sys-pg.
--
-- Источник правды — БИТРИКС (решение владельца 13.10): виджет пишет сначала в
-- Битрикс, при успехе — сюда; ручная правка этих полей в Битриксе закрыта
-- (EDIT_IN_LIST=N), расхождения ловит периодическая сверка Битрикс → sa.
-- Эти таблицы — КОПИЯ Битрикса для чтения приложением (отчёты в Битрикс не ходят).
--
-- Соответствие полям Битрикса:
--   client_module_profiles ← контакт/компания:
--     client_type / client_type_enum_id ← «Тип клиента» (UF_CRM_677E46F756A7B у контакта,
--                                         UF_CRM_677E46F8B8F06 у компании)
--     occupation ← UF_CRM_MLT_OCCUPATION «Чем занимается»
--     note       ← UF_CRM_MLT_CLIENT_NOTE «Заметка по клиенту»
--   client_module_objects ← элемент смарт-процесса «Объекты» (bitrix_item_id),
--     build_stage ← стадия элемента, house_type/note/адрес — его поля.
--
-- ПРИМЕНЯЕТСЯ СУПЕР-ЮЗЕРОМ ВРУЧНУЮ (docker exec supabase-db psql -U supabase_admin -d postgres):
-- у app-юзера junior_user нет CREATE в схеме sa.
--
-- DOWN: DROP TABLE IF EXISTS sa.client_module_objects; DROP TABLE IF EXISTS sa.client_module_profiles;

CREATE TABLE IF NOT EXISTS sa.client_module_profiles (
  client_ref          text PRIMARY KEY,            -- 'c<contact_id>' или 'k<company_id>'
  client_type         text,                        -- construction_org | own_needs_org | foreman | self_builder
  client_type_enum_id integer,                     -- ID варианта списка в Битриксе (у контакта и компании свои)
  occupation          text NOT NULL DEFAULT '',    -- «Чем занимается»
  note                text NOT NULL DEFAULT '',    -- «Заметка по клиенту»
  updated_by          text,                        -- логин пользователя Монолитики, сделавшего правку
  updated_at          timestamptz NOT NULL DEFAULT now(),
  bitrix_synced_at    timestamptz                  -- когда последний раз сверено с Битриксом
);

CREATE TABLE IF NOT EXISTS sa.client_module_objects (
  client_ref          text NOT NULL,               -- 'c<contact_id>' или 'k<company_id>'
  object_key          text NOT NULL,               -- ключ адреса (координаты ~100 м или нормализованная строка)
  bitrix_item_id      bigint UNIQUE,               -- ID элемента смарт-процесса «Объекты»
  address             text,
  lat                 double precision,
  lon                 double precision,
  build_stage         text,                        -- start | mid_end (из стадии элемента)
  house_type          text,                        -- frame | aerated
  note                text NOT NULL DEFAULT '',
  is_deleted          boolean NOT NULL DEFAULT false,  -- элемент удалён в Битриксе (строку не удаляем)
  updated_by          text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  bitrix_synced_at    timestamptz,
  PRIMARY KEY (client_ref, object_key)
);

COMMENT ON TABLE sa.client_module_profiles IS
  'Модуль «Карточка клиента» (analsteroid, ТЗ 13.10): копия ручных полей клиента из Битрикса — тип клиента, чем занимается, заметка.';
COMMENT ON TABLE sa.client_module_objects IS
  'Модуль «Карточка клиента» (analsteroid, ТЗ 13.10): копия элементов смарт-процесса «Объекты» из Битрикса — стадия стройки, тип дома, заметка.';

GRANT USAGE ON SCHEMA sa TO junior_user;
GRANT SELECT, INSERT, UPDATE ON sa.client_module_profiles TO junior_user;
GRANT SELECT, INSERT, UPDATE ON sa.client_module_objects TO junior_user;
REVOKE DELETE ON sa.client_module_profiles FROM junior_user;
REVOKE DELETE ON sa.client_module_objects FROM junior_user;
