-- 267: «Канбан запросов логистам» (спека ai_docs/fresh_docs/LOGIST_REQUESTS_SPEC.md, решения владельца 17–19.11).
-- Менеджер шлёт логисту запрос на товары (supply «Запрос снабженцу» / cheaper «Есть цена дешевле»),
-- логист отвечает вариантами, менеджер принимает вариант или возвращает. Запрос — наша сущность,
-- в Битриксе — дубль-задача (поля bx_* заполняет синк S4).
-- БД: monolitika (systemDb). Накат — под monolitik; гранты роли приложения — по образцу 257/261.
-- Идемпотентна: CREATE … IF NOT EXISTS, повторный прогон ничего не ломает.
-- Откат (данные пропадут):
--   DROP TABLE logist_request_reads, logist_request_watchers, logist_request_files, logist_request_messages,
--              logist_request_offer_lines, logist_request_offers, logist_request_items, logist_request_events,
--              logist_requests, logist_queue_members, logist_queues, logist_request_settings CASCADE;
--   DROP FUNCTION logist_request_events_append_only();

-- ── очереди = проекты Битрикса «регион × товарная группа» ────────────────────────────────
CREATE TABLE IF NOT EXISTS logist_queues (
  id              serial PRIMARY KEY,
  group_id        integer NOT NULL UNIQUE,          -- проект Битрикса (sonet group), куда идёт дубль-задача
  name            text NOT NULL,                    -- «мск_Газобетон, кирпич и прочие стеновые»
  region          text,                             -- МСК / СПБ / КРД … (как в Панели снабжения)
  dept            text,                             -- ОС / НЦ (refs/departments.json)
  product_groups  text[] NOT NULL DEFAULT '{}',     -- товарные группы (head_group_name) для автоподбора очереди
  sla_hours       numeric(6,2),                     -- SLA цикла в рабочих часах; NULL — из настроек (по умолчанию 3)
  active          boolean NOT NULL DEFAULT true,
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('supply_panel', 'manual')),
  sort            integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text
);

CREATE TABLE IF NOT EXISTS logist_queue_members (
  queue_id        integer NOT NULL REFERENCES logist_queues(id) ON DELETE CASCADE,
  user_bitrix_id  text NOT NULL,                    -- логист (id сотрудника Битрикса)
  user_name       text,
  role            text NOT NULL DEFAULT 'logist' CHECK (role IN ('logist', 'lead')),  -- lead — руководитель очереди
  added_at        timestamptz NOT NULL DEFAULT now(),
  added_by        text,
  PRIMARY KEY (queue_id, user_bitrix_id)
);
CREATE INDEX IF NOT EXISTS logist_queue_members_user_idx ON logist_queue_members (user_bitrix_id);

-- ── запрос ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logist_requests (
  id                  bigserial PRIMARY KEY,         -- № запроса, видим людям
  type                text NOT NULL CHECK (type IN ('supply', 'cheaper')),
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'new', 'in_work', 'answered', 'accepted', 'cancelled')),
  source              text NOT NULL DEFAULT 'button' CHECK (source IN ('robot', 'button')),
  -- сделка (снимок на момент создания; доска Битрикс не читает)
  deal_id             bigint,
  deal_title          text,
  deal_category_id    integer,
  deal_stage_id       text,
  deal_amount         numeric(14,2),
  client_ref          text,                          -- c<контакт> | k<компания>
  client_name         text,
  -- люди
  manager_bitrix_id   text NOT NULL,                 -- автор/ответственный менеджер
  manager_name        text,
  manager_region      text,                          -- регион менеджера (для очереди по умолчанию и фильтра)
  created_by_login    text,                          -- кто создал (логин приложения; робот — NULL)
  queue_id            integer REFERENCES logist_queues(id),
  logist_bitrix_id    text,                          -- кто взял
  logist_name         text,
  -- шапка формы
  address             text,
  purpose             text,                          -- для каких целей
  payment_form        text,
  delivery_date       date,
  comment             text,
  competitor_name     text,                          -- cheaper: чья цена
  competitor_total    numeric(14,2),                 -- cheaper: общая цена конкурента (если не по позициям)
  -- цикл и времена
  cycle               integer NOT NULL DEFAULT 0,    -- 0 — черновик; 1 — с отправки; +1 на каждый возврат
  returns_count       integer NOT NULL DEFAULT 0,
  cycle_started_at    timestamptz,                   -- старт текущего цикла (отправка / последний возврат)
  sent_at             timestamptz,
  taken_at            timestamptz,                   -- взят в текущем цикле
  answered_at         timestamptz,                   -- последний ответ
  accepted_at         timestamptz,
  accepted_offer_id   bigint,
  cancelled_at        timestamptz,
  cancel_reason       text,
  last_event_at       timestamptz NOT NULL DEFAULT now(),
  -- исход сделки (из sa.deals, обновляется синком)
  deal_outcome        text CHECK (deal_outcome IN ('sold', 'lost')),
  deal_outcome_at     timestamptz,
  -- дубль-задача Битрикса (заполняет S4)
  bx_task_id          bigint,
  bx_sync_status      text NOT NULL DEFAULT 'none' CHECK (bx_sync_status IN ('none', 'pending', 'ok', 'error')),
  bx_sync_error       text,
  bx_synced_at        timestamptz,
  -- запись товаров сделки по «Принять вариант» (заполняет S4)
  deal_rows_status    text NOT NULL DEFAULT 'none' CHECK (deal_rows_status IN ('none', 'pending', 'ok', 'error', 'skipped')),
  deal_rows_error     text,
  deal_rows_written_at timestamptz,
  version             integer NOT NULL DEFAULT 0,    -- оптимистичная блокировка: +1 на каждое изменение
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS logist_requests_status_idx  ON logist_requests (status, last_event_at DESC);
CREATE INDEX IF NOT EXISTS logist_requests_queue_idx   ON logist_requests (queue_id, status);
CREATE INDEX IF NOT EXISTS logist_requests_manager_idx ON logist_requests (manager_bitrix_id, created_at DESC);
CREATE INDEX IF NOT EXISTS logist_requests_logist_idx  ON logist_requests (logist_bitrix_id) WHERE logist_bitrix_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS logist_requests_deal_idx    ON logist_requests (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS logist_requests_bxsync_idx  ON logist_requests (bx_sync_status) WHERE bx_sync_status IN ('pending', 'error');

-- позиции запроса: товар сделки или свободная позиция
CREATE TABLE IF NOT EXISTS logist_request_items (
  id                bigserial PRIMARY KEY,
  request_id        bigint NOT NULL REFERENCES logist_requests(id) ON DELETE CASCADE,
  pos               integer NOT NULL DEFAULT 0,
  kind              text NOT NULL CHECK (kind IN ('deal_row', 'free')),
  bx_row_id         bigint,                          -- ID строки crm.deal.productrows
  bx_product_id     bigint,                          -- PRODUCT_ID каталога (NULL у свободной)
  name              text NOT NULL,
  quantity          numeric(14,3),
  measure           text,
  our_price         numeric(14,2),
  product_group     text,                            -- товарная группа (для очереди и фильтра)
  competitor_price  numeric(14,2),                   -- cheaper: цена конкурента за единицу
  comment           text,
  added_in_cycle    integer NOT NULL DEFAULT 0,
  removed           boolean NOT NULL DEFAULT false,  -- мягкое удаление (журнал ссылается)
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS logist_request_items_req_idx ON logist_request_items (request_id, pos);

-- варианты ответа логиста
CREATE TABLE IF NOT EXISTS logist_request_offers (
  id                bigserial PRIMARY KEY,
  request_id        bigint NOT NULL REFERENCES logist_requests(id) ON DELETE CASCADE,
  n                 integer NOT NULL,                -- номер варианта внутри запроса (1, 2, …)
  cycle             integer NOT NULL,
  author_bitrix_id  text,
  author_name       text,
  supplier          text,                            -- поставщик / база
  payment_form      text,
  lead_time         text,                            -- срок словами («2–3 дня», «под заказ 10 дней»)
  ready_date        date,                            -- срок датой, если известен
  delivery_trucks   numeric(8,2),
  delivery_price    numeric(14,2),                   -- за машину
  goods_total       numeric(14,2) NOT NULL DEFAULT 0,-- сумма строк (считает движок)
  delivery_total    numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL DEFAULT 0,
  comment           text,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'accepted')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, n)
);
CREATE INDEX IF NOT EXISTS logist_request_offers_req_idx ON logist_request_offers (request_id, n);

CREATE TABLE IF NOT EXISTS logist_request_offer_lines (
  id                bigserial PRIMARY KEY,
  offer_id          bigint NOT NULL REFERENCES logist_request_offers(id) ON DELETE CASCADE,
  item_id           bigint REFERENCES logist_request_items(id) ON DELETE SET NULL,  -- NULL — новая позиция
  pos               integer NOT NULL DEFAULT 0,
  availability      text NOT NULL DEFAULT 'ok' CHECK (availability IN ('ok', 'none', 'analog')),
  name              text NOT NULL,
  bx_product_id     bigint,
  quantity          numeric(14,3),
  measure           text,
  price             numeric(14,2),
  line_sum          numeric(14,2),
  comment           text
);
CREATE INDEX IF NOT EXISTS logist_request_offer_lines_offer_idx ON logist_request_offer_lines (offer_id, pos);

-- чат запроса
CREATE TABLE IF NOT EXISTS logist_request_messages (
  id                bigserial PRIMARY KEY,
  request_id        bigint NOT NULL REFERENCES logist_requests(id) ON DELETE CASCADE,
  author_bitrix_id  text,
  author_login      text,
  author_name       text,
  body              text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  edited_at         timestamptz,
  deleted_at        timestamptz,
  bx_comment_id     bigint,                          -- комментарий дубль-задачи (S4)
  bx_sync_status    text NOT NULL DEFAULT 'none' CHECK (bx_sync_status IN ('none', 'pending', 'ok', 'error'))
);
CREATE INDEX IF NOT EXISTS logist_request_messages_req_idx ON logist_request_messages (request_id, id);

-- файлы: к запросу, позиции, варианту или сообщению. Хранилище — Диск Битрикса (bx_file_id, загрузка — S4)
CREATE TABLE IF NOT EXISTS logist_request_files (
  id                bigserial PRIMARY KEY,
  request_id        bigint REFERENCES logist_requests(id) ON DELETE CASCADE,  -- NULL, пока файл не прикреплён
  owner_kind        text CHECK (owner_kind IN ('request', 'item', 'offer', 'message')),
  owner_id          bigint,
  name              text NOT NULL,
  mime              text,
  size              bigint,
  bx_file_id        bigint,
  url               text,
  uploaded_by_login text,
  uploaded_by_bitrix_id text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS logist_request_files_owner_idx ON logist_request_files (request_id, owner_kind, owner_id);

-- наблюдатели (участники чата помимо менеджера и логиста)
CREATE TABLE IF NOT EXISTS logist_request_watchers (
  request_id        bigint NOT NULL REFERENCES logist_requests(id) ON DELETE CASCADE,
  user_bitrix_id    text NOT NULL,
  user_name         text,
  added_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_bitrix_id)
);

-- прочитанность чата/событий (для непрочитанных и уведомлений S5)
CREATE TABLE IF NOT EXISTS logist_request_reads (
  request_id        bigint NOT NULL REFERENCES logist_requests(id) ON DELETE CASCADE,
  user_bitrix_id    text NOT NULL,
  last_message_id   bigint NOT NULL DEFAULT 0,
  last_event_id     bigint NOT NULL DEFAULT 0,
  read_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_bitrix_id)
);

-- ── журнал событий: append-only, источник всех метрик ──────────────────────────────────
CREATE TABLE IF NOT EXISTS logist_request_events (
  id                bigserial PRIMARY KEY,
  request_id        bigint NOT NULL REFERENCES logist_requests(id),
  at                timestamptz NOT NULL DEFAULT now(),
  kind              text NOT NULL,                   -- created, sent, taken, released, transferred, answered, returned,
                                                     -- accepted, cancelled, items_changed, reassigned, message, outcome
  cycle             integer NOT NULL DEFAULT 0,
  from_status       text,
  to_status         text,
  queue_id          integer,
  actor_bitrix_id   text,
  actor_login       text,
  actor_name        text,
  data              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS logist_request_events_req_idx  ON logist_request_events (request_id, id);
CREATE INDEX IF NOT EXISTS logist_request_events_kind_idx ON logist_request_events (kind, at);

CREATE OR REPLACE FUNCTION logist_request_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'logist_request_events — только добавление (% запрещён)', TG_OP;
END $$;
DROP TRIGGER IF EXISTS logist_request_events_no_change ON logist_request_events;
CREATE TRIGGER logist_request_events_no_change BEFORE UPDATE OR DELETE ON logist_request_events
  FOR EACH ROW EXECUTE FUNCTION logist_request_events_append_only();

-- ── настройки: веса приоритета, SLA по умолчанию ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS logist_request_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
-- значения по умолчанию лежат в коде (engine/requests/priority.ts DEFAULT_SETTINGS); строка — только переопределение
INSERT INTO logist_request_settings (key, value, updated_by)
VALUES ('main', '{}'::jsonb, 'migration 267')
ON CONFLICT (key) DO NOTHING;

-- ── гранты роли приложения (по образцу 257/261: тем, у кого есть INSERT на repeat_kanban_events) ──
DO $$
DECLARE r record; t text;
  rw_tables text[] := ARRAY['logist_queues', 'logist_queue_members', 'logist_requests', 'logist_request_items',
    'logist_request_offers', 'logist_request_offer_lines', 'logist_request_messages', 'logist_request_files',
    'logist_request_watchers', 'logist_request_reads', 'logist_request_settings'];
  seqs text[] := ARRAY['logist_queues_id_seq', 'logist_requests_id_seq', 'logist_request_items_id_seq',
    'logist_request_offers_id_seq', 'logist_request_offer_lines_id_seq', 'logist_request_messages_id_seq',
    'logist_request_files_id_seq', 'logist_request_events_id_seq'];
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs FROM (
      SELECT grantee::text, privilege_type::text FROM information_schema.role_table_grants
       WHERE table_name = 'repeat_kanban_events' AND table_schema = current_schema()
      UNION ALL
      SELECT tableowner::text, 'OWNER' FROM pg_tables WHERE tablename = 'repeat_kanban_events' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      FOREACH t IN ARRAY rw_tables LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      END LOOP;
      -- журнал — только чтение и добавление
      EXECUTE format('GRANT SELECT, INSERT ON logist_request_events TO %I', r.grantee);
      FOREACH t IN ARRAY seqs LOOP
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO %I', t, r.grantee);
      END LOOP;
    ELSE
      FOREACH t IN ARRAY rw_tables || ARRAY['logist_request_events'] LOOP
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END LOOP;
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
