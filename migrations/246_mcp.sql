-- 246: MCP-сервер Монолитики (задача владельца 22.10): директора подключают Монолитику
-- к Claude Desktop / claude.ai как коннектор и спрашивают «почему не выполнили план»,
-- «кого поставить на газобетон». Модель НЕ пишет SQL — вызывает инструменты над готовыми
-- метриками (lib/mcp). Вход — OAuth (Claude требует его для персональных прав; статический
-- токен коннектора один на всю организацию):
--   mcp_oauth_clients  — клиенты, зарегистрированные по DCR (RFC 7591) — Claude регистрируется сам;
--   mcp_oauth_requests — запрос согласия «Разрешить Claude доступ?» между показом и нажатием
--                        (id — одноразовый, защищает кнопку от CSRF);
--   mcp_oauth_codes    — authorization code (PKCE S256), живёт 5 минут, одноразовый;
--   mcp_tokens         — access/refresh токены (храним sha256, не сам токен), отзыв — revoked_at;
--   mcp_tool_calls     — журнал вызовов инструментов: кто что спрашивал, сколько считалось,
--                        ошибки — по нему видно, какого инструмента не хватает;
--   mcp_glossary       — словарь сленга («газик» → Газобетон): термин → товарная группа
--                        (kc — sa.product_groups.name, by_max — deals.head_group_name) или
--                        просто пояснение. Пополняется без деплоя.
-- БД: system. Идемпотентна. Откат: DROP TABLE mcp_tool_calls, mcp_tokens, mcp_oauth_codes,
-- mcp_oauth_requests, mcp_oauth_clients, mcp_glossary;

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id      text PRIMARY KEY,
  client_name    text,
  redirect_uris  text[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_requests (
  id              text PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id       text NOT NULL REFERENCES mcp_oauth_clients (client_id) ON DELETE CASCADE,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  state           text,
  scope           text,
  resource        text,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash       text PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id       text NOT NULL REFERENCES mcp_oauth_clients (client_id) ON DELETE CASCADE,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  scope           text,
  resource        text,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash     text PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('access', 'refresh')),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id      text NOT NULL,
  -- Одна «выдача» (grant) = одно подключение коннектора: access + цепочка refresh. Отзыв
  -- подключения в ЛК гасит всё с этим grant_id разом.
  grant_id       text NOT NULL,
  scope          text,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_tokens_grant_idx ON mcp_tokens (grant_id);
CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx ON mcp_tokens (user_id);

CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tool         text NOT NULL,
  args         jsonb,
  ok           boolean NOT NULL,
  error        text,
  duration_ms  int,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_tool_calls_created_idx ON mcp_tool_calls (created_at DESC);

CREATE TABLE IF NOT EXISTS mcp_glossary (
  id          serial PRIMARY KEY,
  term        text NOT NULL CHECK (length(term) BETWEEN 1 AND 80),
  -- product — термин означает товарную группу; term — просто слово/аббревиатура с пояснением.
  kind        text NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'term')),
  meaning     text NOT NULL,
  head_group  text,      -- deals.head_group_name (шкала «по наибольшему», by_max)
  kc_groups   text[],    -- sa.product_groups.name (шкала КЦ), может быть несколько
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_glossary_term_uq ON mcp_glossary (lower(term));

-- Стартовый словарь строительного сленга. Названия групп — ровно как в данных (проверено 22.10:
-- sa.product_groups и DISTINCT deals.head_group_name).
INSERT INTO mcp_glossary (term, kind, meaning, head_group, kc_groups, created_by) VALUES
  ('газик',          'product', 'Газобетон (газобетонные блоки)', 'Газобетон', '{Газобетон}', 'seed'),
  ('газоблок',       'product', 'Газобетон', 'Газобетон', '{Газобетон}', 'seed'),
  ('газосиликат',    'product', 'Газобетон (газосиликатные блоки)', 'Газобетон', '{Газобетон}', 'seed'),
  ('газобетон',      'product', 'Газобетон', 'Газобетон', '{Газобетон}', 'seed'),
  ('пеноблок',       'product', 'Пеноблок — стеновой материал, отдельной группы нет', 'Кирпич и другие стеновые материалы', '{"Другие стеновые материалы"}', 'seed'),
  ('щебёнка',        'product', 'Щебень', 'Щебень', '{"Щебень, ЩПС, бутовый камень, отсев"}', 'seed'),
  ('щебенка',        'product', 'Щебень', 'Щебень', '{"Щебень, ЩПС, бутовый камень, отсев"}', 'seed'),
  ('щпс',            'product', 'Щебёночно-песчаная смесь', 'Щебень', '{"Щебень, ЩПС, бутовый камень, отсев"}', 'seed'),
  ('отсев',          'product', 'Отсев (мелкая фракция щебня)', 'Щебень', '{"Щебень, ЩПС, бутовый камень, отсев"}', 'seed'),
  ('бут',            'product', 'Бутовый камень', 'Щебень', '{"Щебень, ЩПС, бутовый камень, отсев"}', 'seed'),
  ('нерудка',        'product', 'Нерудные материалы: щебень, песок, ПГС, отсев', NULL, '{"Щебень, ЩПС, бутовый камень, отсев","Песок, ПГС","Кварцевый песок"}', 'seed'),
  ('нерудные',       'product', 'Нерудные материалы: щебень, песок, ПГС, отсев', NULL, '{"Щебень, ЩПС, бутовый камень, отсев","Песок, ПГС","Кварцевый песок"}', 'seed'),
  ('песочек',        'product', 'Песок', 'Песок', '{"Песок, ПГС"}', 'seed'),
  ('пгс',            'product', 'Песчано-гравийная смесь', 'Песок', '{"Песок, ПГС"}', 'seed'),
  ('вторичка',       'product', 'Вторичные материалы (вторичный щебень, асфальтовая крошка, бой)', 'Вторичные материалы', '{"Вторичные материалы"}', 'seed'),
  ('асфальтовая крошка', 'product', 'Вторичные материалы', 'Вторичные материалы', '{"Вторичные материалы"}', 'seed'),
  ('бетонка',        'product', 'Бетон (товарный бетон, раствор)', 'Бетон и раствор', '{"Бетон и раствор"}', 'seed'),
  ('раствор',        'product', 'Бетон и раствор', 'Бетон и раствор', '{"Бетон и раствор"}', 'seed'),
  ('цпс',            'product', 'Цементно-песчаная смесь', 'Сухие смеси', '{"Цементно-песчаная смесь (ЦПС)"}', 'seed'),
  ('минвата',        'product', 'Утеплитель: минеральная вата', 'Теплоизоляция и утеплитель', '{"Утеплитель Минеральная вата и стекловата"}', 'seed'),
  ('утеплитель',     'product', 'Теплоизоляция и утеплитель', 'Теплоизоляция и утеплитель', '{"Утеплитель Минеральная вата и стекловата","Утеплитель Экструдированный пенополистирол (ЭППС)"}', 'seed'),
  ('эппс',           'product', 'Экструдированный пенополистирол', 'Теплоизоляция и утеплитель', '{"Утеплитель Экструдированный пенополистирол (ЭППС)"}', 'seed'),
  ('экструдка',      'product', 'Экструдированный пенополистирол (ЭППС)', 'Теплоизоляция и утеплитель', '{"Утеплитель Экструдированный пенополистирол (ЭППС)"}', 'seed'),
  ('пеноплэкс',      'product', 'ЭППС (по названию бренда)', 'Теплоизоляция и утеплитель', '{"Утеплитель Экструдированный пенополистирол (ЭППС)"}', 'seed'),
  ('профнастил',     'product', 'Профлист (кровельный или для забора)', NULL, '{"Профлист для кровли","Профлист для забора"}', 'seed'),
  ('профлист',       'product', 'Профлист (кровельный или для забора)', NULL, '{"Профлист для кровли","Профлист для забора"}', 'seed'),
  ('металлочерепица','product', 'Металлочерепица', 'Кровельные материалы, водосточные системы', '{Металлочерепица}', 'seed'),
  ('кровля',         'product', 'Кровельные материалы', 'Кровельные материалы, водосточные системы', '{Металлочерепица,"Профлист для кровли","Гибкая черепица","Керамическая черепица","Композитная черепица","Цементно-песчаная черепица",Фальц,"Ондулин и шифер"}', 'seed'),
  ('шифер',          'product', 'Ондулин и шифер', 'Ондулин и шифер', '{"Ондулин и шифер"}', 'seed'),
  ('ондулин',        'product', 'Ондулин и шифер', 'Ондулин и шифер', '{"Ондулин и шифер"}', 'seed'),
  ('профтруба',      'product', 'Трубы профильные стальные', 'Трубы профильные стальные', '{"Трубы профильные стальные (БЕЗ 10х10, 15х15)"}', 'seed'),
  ('арматурка',      'product', 'Арматура стальная', 'Арматура стальная и проволока', '{"Арматура стальная"}', 'seed'),
  ('арматура',       'product', 'Арматура стальная', 'Арматура стальная и проволока', '{"Арматура стальная","Композитная стеклопластиковая арматура"}', 'seed'),
  ('металл',         'product', 'Металлопрокат', 'Прочий металлопрокат', '{"Арматура стальная","Балки стальные","Лист горячекатаный","Полоса стальная","Трубы профильные стальные (БЕЗ 10х10, 15х15)","Уголок стальной (БЕЗ 20х20)",Швеллер,Шпунт,"Нержавеющий металлопрокат"}', 'seed'),
  ('металлопрокат',  'product', 'Металлопрокат', 'Прочий металлопрокат', '{"Арматура стальная","Балки стальные","Лист горячекатаный","Полоса стальная","Трубы профильные стальные (БЕЗ 10х10, 15х15)","Уголок стальной (БЕЗ 20х20)",Швеллер,Шпунт,"Нержавеющий металлопрокат"}', 'seed'),
  ('жби',            'product', 'Железобетонные изделия (кольца, плиты, ФБС, трубы, лотки, сваи…)', NULL, '{"Кольца ЖБИ","Плиты перекрытия ЖБИ","ФБС (БЕЗ 4-2-2 , 4-4-2, 4-4-3)","Трубы ЖБИ","Лотки и Плиты лотков ЖБИ","Сваи ЖБИ (Без установки)","Заборы ЖБИ","Лестничные марши ЖБИ","Опоры СВ ЖБИ","БПР ЖБИ","Дорожные плиты НОВЫЕ","Аэродромные плиты ПАГ НОВЫЕ"}', 'seed'),
  ('фбс',            'product', 'Фундаментные блоки (ФБС)', 'ФБС', '{"ФБС (БЕЗ 4-2-2 , 4-4-2, 4-4-3)"}', 'seed'),
  ('фундаментные блоки', 'product', 'ФБС', 'ФБС', '{"ФБС (БЕЗ 4-2-2 , 4-4-2, 4-4-3)"}', 'seed'),
  ('кольца',         'product', 'Кольца ЖБИ (колодезные)', 'Кольца ЖБИ', '{"Кольца ЖБИ"}', 'seed'),
  ('колодцы',        'product', 'Кольца ЖБИ (колодезные)', 'Кольца ЖБИ', '{"Кольца ЖБИ"}', 'seed'),
  ('пустотки',       'product', 'Плиты перекрытия (пустотные)', 'Плиты перекрытия ЖБИ', '{"Плиты перекрытия ЖБИ"}', 'seed'),
  ('плиты перекрытия','product', 'Плиты перекрытия ЖБИ', 'Плиты перекрытия ЖБИ', '{"Плиты перекрытия ЖБИ"}', 'seed'),
  ('дорожки',        'product', 'Дорожные плиты', 'Дорожные плиты', '{"Дорожные плиты НОВЫЕ"}', 'seed'),
  ('дорожные плиты', 'product', 'Дорожные плиты', 'Дорожные плиты', '{"Дорожные плиты НОВЫЕ"}', 'seed'),
  ('аэродромки',     'product', 'Аэродромные плиты (ПАГ)', 'Аэродромные плиты', '{"Аэродромные плиты ПАГ НОВЫЕ"}', 'seed'),
  ('паги',           'product', 'Аэродромные плиты ПАГ', 'Аэродромные плиты', '{"Аэродромные плиты ПАГ НОВЫЕ"}', 'seed'),
  ('паг',            'product', 'Аэродромные плиты ПАГ', 'Аэродромные плиты', '{"Аэродромные плиты ПАГ НОВЫЕ"}', 'seed'),
  ('бордюр',         'product', 'Бордюры (поребрики, бортовые камни)', 'Изделия для благоустройства', '{"Бордюры (поребрики, бортовые камни)"}', 'seed'),
  ('поребрик',       'product', 'Бордюры (поребрики, бортовые камни)', 'Изделия для благоустройства', '{"Бордюры (поребрики, бортовые камни)"}', 'seed'),
  ('плитка',         'product', 'Тротуарная плитка', 'Изделия для благоустройства', '{"Тротуарная плитка",Брусчатка}', 'seed'),
  ('брусчатка',      'product', 'Брусчатка', 'Изделия для благоустройства', '{Брусчатка}', 'seed'),
  ('благоустройство','product', 'Изделия для благоустройства', 'Изделия для благоустройства', '{"Тротуарная плитка",Брусчатка,"Бордюры (поребрики, бортовые камни)","Лотки водоотводные для благоустройства"}', 'seed'),
  ('гкл',            'product', 'Гипсокартон', 'Гипсокартон', '{Гипсокартон}', 'seed'),
  ('гипрок',         'product', 'Гипсокартон (по названию бренда)', 'Гипсокартон', '{Гипсокартон}', 'seed'),
  ('сэндвичи',       'product', 'Сэндвич-панели', 'Сэндвич-панели', '{Сэндвич-панели}', 'seed'),
  ('облицовка',      'product', 'Облицовочный (лицевой) кирпич', 'Облицовочный кирпич', '{"Лицевой кирпич"}', 'seed'),
  ('лицевой',        'product', 'Облицовочный (лицевой) кирпич', 'Облицовочный кирпич', '{"Лицевой кирпич"}', 'seed'),
  ('кирпич',         'product', 'Кирпич (рядовой и лицевой)', NULL, '{Кирпич,"Лицевой кирпич"}', 'seed'),
  ('забор',          'product', 'Ограждения и заборы', 'Ограждения и заборы', '{"Профлист для забора",Штакетник,"Заборы ЖБИ","Монтаж забора","3D сетка Гиттер"}', 'seed'),
  ('штакетник',      'product', 'Штакетник', 'Ограждения и заборы', '{Штакетник}', 'seed'),
  ('гиттер',         'product', '3D-сетка Гиттер', 'Ограждения и заборы', '{"3D сетка Гиттер"}', 'seed'),
  ('пиломатериал',   'product', 'Пиломатериалы', 'Пиломатериалы', '{Пиломатериалы}', 'seed'),
  ('доска',          'product', 'Пиломатериалы', 'Пиломатериалы', '{Пиломатериалы}', 'seed'),
  ('асфальт',        'product', 'Асфальт и асфальтобетон', 'Асфальт и асфальтобетон', '{"Горячий асфальт","Холодный асфальт"}', 'seed'),
  ('спецтехника',    'product', 'Аренда спецтехники', 'Аренда спецтехники', '{"Услуги (доставки, аренда спецтехники) ЕСТЬ ТОЛЬКО ЭКСКАВАТОР, МТЗ с щеткой и отвалом, КРАН, АВТОВЫШКА и САМОСВАЛЫ"}', 'seed'),
  ('вывоз',          'product', 'Вывоз грунта и мусора', 'Вывоз грунта и мусора', '{"Вывоз грунта и мусора"}', 'seed'),
  ('геотекстиль',    'product', 'Геотекстиль', NULL, '{Геотекстиль}', 'seed'),
  -- Термины (не товар).
  ('повторка',       'term', 'Повторные продажи: сделки клиентов, которые уже покупали', NULL, NULL, 'seed'),
  ('первичка',       'term', 'Первичные продажи: первая покупка клиента', NULL, NULL, 'seed'),
  ('роп',            'term', 'Руководитель отдела продаж', NULL, NULL, 'seed'),
  ('моп',            'term', 'Менеджер отдела продаж', NULL, NULL, 'seed'),
  ('париж',          'term', '«Париж» в адресе сделки = самовывоз, не адрес доставки', NULL, NULL, 'seed'),
  ('самовывоз',      'term', 'Клиент забирает сам; в адресе сделки пишут «Париж»', NULL, NULL, 'seed'),
  ('отгрузка',       'term', 'Факт отгрузки товара по сделке (в метриках — «Отгрузки»)', NULL, NULL, 'seed'),
  ('бронь',          'term', 'Сделка в стадии брони (клиент подтвердил, товар зарезервирован)', NULL, NULL, 'seed'),
  ('кц',             'term', 'Шкала товарных групп КЦ (sa.product_groups); альтернатива — «по наибольшему»', NULL, NULL, 'seed')
ON CONFLICT DO NOTHING;

-- Права роли приложения (миграцию накатывают суперпользователем контейнера — см. 240).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs FROM (
      SELECT grantee::text, privilege_type::text
        FROM information_schema.role_table_grants
       WHERE table_name = 'user_sessions' AND table_schema = current_schema()
      UNION ALL
      SELECT tableowner::text, 'OWNER' FROM pg_tables WHERE tablename = 'user_sessions' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_oauth_clients, mcp_oauth_requests, mcp_oauth_codes, mcp_tokens, mcp_tool_calls, mcp_glossary TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE mcp_tool_calls_id_seq, mcp_glossary_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON mcp_oauth_clients, mcp_oauth_requests, mcp_oauth_codes, mcp_tokens, mcp_tool_calls, mcp_glossary TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на user_sessions: %)', r.grantee, r.privs;
  END LOOP;
END $$;
