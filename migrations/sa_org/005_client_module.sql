-- «Модули» → «Карточка клиента» (ТЗ владельца 13.10, будущий виджет в карточке
-- клиента Битрикса): ручные поля, которые менеджер заполняет сам.
-- АНАЛИТИЧЕСКАЯ БД sa (self-hosted Supabase 62.113.100.67) — НЕ системная YC
-- (решение владельца 13.10: «новая таблица в sa», рядом со сделками и
-- sa.request_addresses — адресами заявок из Пульта/1С).
--
-- ПРИМЕНЯЕТСЯ СУПЕР-ЮЗЕРОМ ВРУЧНУЮ (docker exec supabase-db psql -U supabase_admin -d postgres):
-- у app-юзера junior_user нет CREATE в схеме sa. Пока не накатана — модуль
-- работает в режиме «только чтение» (автоматические цифры видны, сохранение
-- ручных полей отвечает понятной ошибкой).
--
-- client_ref — 'c<contact_id>' или 'k<company_id>': то, по чему открыли модуль
-- (виджет в Битриксе будет стоять в карточке контакта или компании).
-- object_key — ключ объекта (адреса), см. features/client-module/engine/types.ts
-- (координаты, округлённые до ~100 м, иначе нормализованная строка адреса).
--
-- DOWN: DROP TABLE IF EXISTS sa.client_module_objects; DROP TABLE IF EXISTS sa.client_module_profiles;

CREATE TABLE IF NOT EXISTS sa.client_module_profiles (
  client_ref   text PRIMARY KEY,
  client_type  text,              -- construction_org | own_needs_org | foreman | self_builder
  occupation   text NOT NULL DEFAULT '',   -- «чем занимается» (для прораба/строительной организации)
  note         text NOT NULL DEFAULT '',
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sa.client_module_objects (
  client_ref   text NOT NULL,
  object_key   text NOT NULL,
  build_stage  text,              -- start | mid_end («строит себе»: начало / середина-окончание)
  house_type   text,              -- frame | aerated (каркасный / газобетонный)
  note         text NOT NULL DEFAULT '',
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_ref, object_key)
);

COMMENT ON TABLE sa.client_module_profiles IS
  'Модуль «Карточка клиента» (analsteroid, ТЗ 13.10): ручные поля по клиенту — тип клиента, чем занимается.';
COMMENT ON TABLE sa.client_module_objects IS
  'Модуль «Карточка клиента» (analsteroid, ТЗ 13.10): ручные поля по объекту клиента — стадия стройки, тип дома.';

GRANT USAGE ON SCHEMA sa TO junior_user;
GRANT SELECT, INSERT, UPDATE ON sa.client_module_profiles TO junior_user;
GRANT SELECT, INSERT, UPDATE ON sa.client_module_objects TO junior_user;
REVOKE DELETE ON sa.client_module_profiles FROM junior_user;
REVOKE DELETE ON sa.client_module_objects FROM junior_user;
