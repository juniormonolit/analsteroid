-- Миграция 098: бот «Контроль звонков» (интеграция missedcalls-робота в Монолитику).
-- БД: YC system (run_system.mjs). Для dev-стенда применить к junibaseone.
-- Номер 098: на сервере фактически занято по 097 включительно (096/097 — КЦ-дефолты,
-- применены вне репо; 088 на сервере — ad-hoc changelog деплоя 60, НЕ путать с
-- 088_analsteroid_deal_metrics из ветки prod-work, та живёт в Мишиной БД/схеме rop).
--
-- Смысл: приём телефонных событий Bitrix (исходящий вебхук → /api/telephony/webhook)
-- в call_events; движок (lib/bots/callControl.ts, тик в instrumentation.ts) ведёт
-- кейсы пропущенных входящих и эскалирует по НАСТРАИВАЕМЫМ правилам (кол-во
-- пропущенных подряд / минуты без перезвона / оператор И-ИЛИ) с НАСТРАИВАЕМЫМИ
-- шаблонами. Отправка — существующий бот Bitrix «Контроль звонков» (BOT_ID 15010).
-- Идемпотентна.

-- 1. Сырые + нормализованные события телефонии.
CREATE TABLE IF NOT EXISTS call_events (
  id                      bigserial PRIMARY KEY,
  event_name              text,
  bitrix_call_id          text,
  direction               text,          -- 'inbound' | 'outbound' | NULL (не распознано)
  call_type_raw           text,          -- CALL_TYPE Bitrix: 1 исходящий, 2 входящий, 3 переадресация, 4 callback
  phone_normalized        text,          -- +7XXXXXXXXXX
  phone_raw               text,
  manager_bitrix_user_id  text,          -- PORTAL_USER_ID / USER_ID
  duration_seconds        integer,
  failed_code             text,          -- CALL_FAILED_CODE ('304' = пропущенный)
  is_missed_inbound       boolean NOT NULL DEFAULT false,
  crm_deal_id             bigint,        -- если Bitrix прислал привязку к сделке
  call_started_at         timestamptz,
  received_at             timestamptz NOT NULL DEFAULT now(),
  raw                     jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- Bitrix может слать несколько событий по одному звонку (START/END) — дедуп по паре.
CREATE UNIQUE INDEX IF NOT EXISTS call_events_call_event_uniq
  ON call_events (bitrix_call_id, event_name) WHERE bitrix_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS call_events_phone_idx ON call_events (phone_normalized, call_started_at);
CREATE INDEX IF NOT EXISTS call_events_received_idx ON call_events (received_at);

-- 2. Настройки бота (singleton, id=1). enabled=false + dry_run=true из коробки:
--    включение — осознанное действие в админке, не деплой.
CREATE TABLE IF NOT EXISTS call_control_settings (
  id                       integer PRIMARY KEY CHECK (id = 1),
  enabled                  boolean NOT NULL DEFAULT false,
  dry_run                  boolean NOT NULL DEFAULT true,
  mirror_bitrix_user_id    text,         -- «Дубль уведомления» этому пользователю (пусто = выкл)
  last_processed_event_id  bigint NOT NULL DEFAULT 0,  -- курсор движка по call_events.id
  updated_at               timestamptz NOT NULL DEFAULT now()
);
INSERT INTO call_control_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 3. Шаблоны сообщений (кастомные, редактируются в админке).
--    Плейсхолдеры: {manager_name} {phone} {deal_url} {missed_count} {minutes}
--    {case_id} {recipient_name}.
CREATE TABLE IF NOT EXISTS call_control_templates (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 4. Правила эскалации (кастомные). Порог NULL = условие не участвует.
--    operator: 'and' — все заданные условия; 'or' — любое из заданных.
CREATE TABLE IF NOT EXISTS call_control_rules (
  id                        serial PRIMARY KEY,
  sort_order                integer NOT NULL DEFAULT 0,
  name                      text NOT NULL DEFAULT '',
  missed_count_gte          integer,
  minutes_without_callback  integer,
  operator                  text NOT NULL DEFAULT 'and' CHECK (operator IN ('and','or')),
  recipient                 text NOT NULL CHECK (recipient IN ('manager','rop','department_director','company_director','fixed')),
  fixed_bitrix_user_id      text,
  template_id               integer REFERENCES call_control_templates(id) ON DELETE SET NULL,
  is_active                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- 5. Кейсы: клиент не дозвонился. Один открытый кейс на (телефон, менеджер).
CREATE TABLE IF NOT EXISTS call_control_cases (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_normalized        text NOT NULL,
  manager_bitrix_user_id  text,
  deal_id                 bigint,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  missed_count            integer NOT NULL DEFAULT 0,
  first_missed_at         timestamptz,
  last_missed_at          timestamptz,
  last_outgoing_at        timestamptz,   -- последняя ПОПЫТКА исходящего (для «время без исходящего»)
  resolved_at             timestamptz,
  resolved_call_event_id  bigint,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS call_control_cases_open_uniq
  ON call_control_cases (phone_normalized, manager_bitrix_user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS call_control_cases_status_idx ON call_control_cases (status, last_missed_at);

-- 6. Доставки. Уникальность (case, rule) — правило по кейсу срабатывает один раз.
CREATE TABLE IF NOT EXISTS call_control_deliveries (
  id                         bigserial PRIMARY KEY,
  case_id                    uuid NOT NULL REFERENCES call_control_cases(id) ON DELETE CASCADE,
  rule_id                    integer NOT NULL,
  recipient_kind             text NOT NULL,
  recipient_bitrix_user_id   text,
  recipient_name             text,
  message                    text NOT NULL,
  dry_run                    boolean NOT NULL DEFAULT false,
  mirrored                   boolean NOT NULL DEFAULT false,
  error                      text,
  sent_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, rule_id)
);
CREATE INDEX IF NOT EXISTS call_control_deliveries_sent_idx ON call_control_deliveries (sent_at);

-- 7. Сиды: два шаблона (тексты старого missedcalls-бота) + лестница эскалации
--    «1+30мин → менеджер, 2 → РОП, 3 → директор, 4 → собственник (Bitrix ID 5)».
--    Гард NOT EXISTS: пользовательские правки не перетираются повторным накатом.
INSERT INTO call_control_templates (name, body)
SELECT 'Менеджеру', E'СРОЧНО ПЕРЕЗВОНИ КЛИЕНТУ. ДО ТЕБЯ НЕ ДОЗВОНИЛИСЬ.\n\nМенеджер: {manager_name}\nТелефон: {phone}\nСделка: {deal_url}\nПропущенных подряд: {missed_count}\nВремя без исходящего: {minutes} мин.'
WHERE NOT EXISTS (SELECT 1 FROM call_control_templates);

INSERT INTO call_control_templates (name, body)
SELECT 'Руководителю', E'КЛИЕНТ НЕ ДОЗВОНИЛСЯ ДО МЕНЕДЖЕРА.\n\nМенеджер: {manager_name}\nТелефон: {phone}\nСделка: {deal_url}\nПропущенных подряд: {missed_count}\nВремя без исходящего: {minutes} мин.'
WHERE EXISTS (SELECT 1 FROM call_control_templates HAVING count(*) = 1);

INSERT INTO call_control_rules (sort_order, name, missed_count_gte, minutes_without_callback, operator, recipient, fixed_bitrix_user_id, template_id)
SELECT * FROM (
  VALUES
    (1, '1 пропуск и 30 минут без перезвона — менеджеру', 1, 30, 'and', 'manager',            NULL::text,
      (SELECT id FROM call_control_templates WHERE name = 'Менеджеру'    ORDER BY id LIMIT 1)),
    (2, '2 пропущенных подряд — РОПу',                    2, NULL, 'and', 'rop',              NULL::text,
      (SELECT id FROM call_control_templates WHERE name = 'Руководителю' ORDER BY id LIMIT 1)),
    (3, '3 пропущенных подряд — директору департамента',  3, NULL, 'and', 'department_director', NULL::text,
      (SELECT id FROM call_control_templates WHERE name = 'Руководителю' ORDER BY id LIMIT 1)),
    (4, '4 пропущенных подряд — собственнику',            4, NULL, 'and', 'fixed',            '5',
      (SELECT id FROM call_control_templates WHERE name = 'Руководителю' ORDER BY id LIMIT 1))
) AS seed(sort_order, name, missed_count_gte, minutes_without_callback, operator, recipient, fixed_bitrix_user_id, template_id)
WHERE NOT EXISTS (SELECT 1 FROM call_control_rules);
