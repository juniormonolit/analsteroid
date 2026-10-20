-- 231: «Канбан повторных продаж» — журнал действий и ежедневный снимок (владелец 20.10:
-- «логи — кто и что делал; каждый рабочий день замерять, насколько пул каждого отдела
-- проработан, сколько действий совершено, и записывать»; схема — консультация Fable).
-- БД: system. Идемпотентна. Владелец таблиц — роль приложения (урок миграции 230).
--
-- repeat_kanban_events — append-only журнал РУЧНЫХ действий в канбане (actor_type='user'):
-- кто (логин, имя, Битрикс-id, роль), что (event_type), по кому (client_key, manager_id на
-- момент), с чем (deal_id, task_id), откуда (column_before), payload (комментарий, срок,
-- причина, режим сделки). request_id склеивает одну кнопку («сделка + задача + комментарий»).
-- События Битрикса (сдача/приёмка задачи, стадии, звонки, отгрузки) досчитываются из sa —
-- там они уже есть с авторами и временем.
--
-- repeat_kanban_daily — снимок на конец дня (23:30 МСК) по каждому менеджеру: остатки по
-- колонкам и потоки за день. Отдел — снимком на момент (department_id/name), чтобы
-- переназначения не переписывали историю.
--
-- Откат: DROP TABLE repeat_kanban_daily, repeat_kanban_events;

CREATE TABLE IF NOT EXISTS repeat_kanban_events (
  id              bigserial PRIMARY KEY,
  ts              timestamptz NOT NULL DEFAULT now(),
  request_id      text,
  actor_type      text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'bitrix')),
  actor_login     text,
  actor_name      text,
  actor_bitrix_id text,
  actor_role      text,
  event_type      text NOT NULL,
  client_key      text,
  manager_id      text,
  column_before   text,
  deal_id         bigint,
  task_id         bigint,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS repeat_kanban_events_ts_idx ON repeat_kanban_events (ts DESC);
CREATE INDEX IF NOT EXISTS repeat_kanban_events_actor_idx ON repeat_kanban_events (actor_login, ts DESC);
CREATE INDEX IF NOT EXISTS repeat_kanban_events_mgr_idx ON repeat_kanban_events (manager_id, ts DESC);
CREATE INDEX IF NOT EXISTS repeat_kanban_events_client_idx ON repeat_kanban_events (client_key, ts DESC);

CREATE TABLE IF NOT EXISTS repeat_kanban_daily (
  snap_date        date NOT NULL,
  manager_id       text NOT NULL,
  manager_name     text,
  department_id    text,
  department_name  text,
  is_workday       boolean NOT NULL,
  -- остатки на конец дня
  total            int NOT NULL,          -- все заказчики без брака
  pool             int NOT NULL,
  pool_hot         int NOT NULL,
  pool_potential   bigint NOT NULL,
  in_work          int NOT NULL,          -- «Дозвон»: взят в работу + попытки
  reached          int NOT NULL,
  funnel           int NOT NULL,
  funnel_sum       bigint NOT NULL,
  review           int NOT NULL,
  hidden           int NOT NULL,
  brak             int NOT NULL,
  worked_pct       numeric(5,1) NOT NULL, -- (все − пул) / все, скрытые и разбор — проработаны
  worked_pct_strict numeric(5,1) NOT NULL, -- строгая: скрытые и разбор — НЕ проработаны
  tasks_open       int NOT NULL,
  tasks_overdue    int NOT NULL,
  tasks_control    int NOT NULL,
  no_task_in_work  int NOT NULL,
  columns          jsonb NOT NULL,        -- {колонка: число} — полная раскладка
  -- потоки за день
  actions          int NOT NULL,          -- ручные действия в канбане по заказчикам менеджера
  actions_by_type  jsonb NOT NULL,
  tasks_created    int NOT NULL,          -- в проекте «Повторные продажи», по его сделкам
  tasks_accepted   int NOT NULL,
  built_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snap_date, manager_id)
);
CREATE INDEX IF NOT EXISTS repeat_kanban_daily_dept_idx ON repeat_kanban_daily (department_id, snap_date);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'JanCloude') THEN
    ALTER TABLE repeat_kanban_events OWNER TO "JanCloude";
    ALTER SEQUENCE repeat_kanban_events_id_seq OWNER TO "JanCloude";
    ALTER TABLE repeat_kanban_daily OWNER TO "JanCloude";
  END IF;
END $$;
