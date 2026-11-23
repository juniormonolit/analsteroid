-- 274: «Задачник» — ядро (TASKER_SPEC.md, сессия A, 23.11).
-- Задачи «подтянуть показатель до среднего» со снимком цифр, сессии РОПа по теме,
-- белый список метрик, шаблоны рекомендаций, настройки (проект Битрикса, директор по
-- филиалу) и outbox записи в Битрикс (паттерн logist_bx_outbox, миграция 270).
-- БД: monolitika (systemDb). Накат — под monolitik; гранты роли приложения — по образцу 270
-- (копируем с repeat_kanban_events). Идемпотентна. На прод — только владелец.
-- Откат: DROP TABLE tasker_bx_outbox, tasker_tasks, tasker_sessions, tasker_templates, tasker_metrics, tasker_settings;

-- ── Белый список «прокачиваемых» метрик ──────────────────────────────────────
-- id — id метрики каталога отчётов (таблица metrics в analytics). denominator_ids —
-- метрики-знаменатели (сумма) для правила «мало данных» (< 5); пусто — правило не
-- применяется. additive — счётчик/сумма: «своё среднее за 6 мес.» приводится к длине
-- периода (иначе сравнивали бы месяц с полугодом).
CREATE TABLE IF NOT EXISTS tasker_metrics (
  id                text PRIMARY KEY,
  label             text NOT NULL,
  grp               text NOT NULL CHECK (grp IN ('conversion', 'check', 'activity', 'repeat')),
  higher_is_better  boolean NOT NULL DEFAULT true,
  format            text NOT NULL DEFAULT 'percent' CHECK (format IN ('percent', 'money', 'number')),
  tag               text NOT NULL,
  denominator_ids   text[] NOT NULL DEFAULT '{}',
  additive          boolean NOT NULL DEFAULT false,
  sort_order        int NOT NULL DEFAULT 100,
  active            boolean NOT NULL DEFAULT true
);

INSERT INTO tasker_metrics (id, label, grp, higher_is_better, format, tag, denominator_ids, additive, sort_order) VALUES
  ('cr_deal_to_sale',            'CR Сделка → Продажа (перв.)', 'conversion', true,  'percent', 'CR перв.',        ARRAY['primary_deals_count'],               false, 10),
  ('cr_repeat_created_to_sale',  'CR Сделка → Продажа (повт.)', 'conversion', true,  'percent', 'CR повт.',        ARRAY['repeat_created_count'],              false, 20),
  ('cr_deal_to_sale_all',        'CR Сделка → Продажа',         'conversion', true,  'percent', 'CR все',          ARRAY['deals_count'],                       false, 30),
  ('ppp_conversion',             'CR ППП',                      'conversion', true,  'percent', 'CR ППП',          ARRAY['primary_shipments_count'],           false, 40),
  ('primary_sales_avg_amount',   'Средний чек (перв.)',         'check',      true,  'money',   'Средний чек',     ARRAY['primary_sales_count'],               false, 50),
  ('all_sales_avg_amount',       'Средний чек (все)',           'check',      true,  'money',   'Средний чек все', ARRAY['sales_count'],                       false, 60),
  ('calls_outgoing_count_all',   'Исходящие звонки',            'activity',   true,  'number',  'Звонки',          '{}',                                       true,  70),
  ('calls_missed_rate_all',      'Доля недозвонов',             'activity',   false, 'percent', 'Недозвоны',       ARRAY['calls_outbound_total', 'calls_outbound_total_repeat', 'calls_outbound_total_orphan'], false, 80),
  ('manager_deals_per_worked_day','Сделок в рабочий день',      'activity',   true,  'number',  'Активность',      ARRAY['manager_worked_days_count'],         false, 90),
  ('repeat_sales_count_pct',     'Доля повторных продаж',       'repeat',     true,  'percent', 'Доля повторки',   ARRAY['primary_sales_count', 'repeat_sales_count'], false, 100)
ON CONFLICT (id) DO NOTHING;

-- ── Шаблоны рекомендаций ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasker_templates (
  id          serial PRIMARY KEY,
  metric_id   text NOT NULL REFERENCES tasker_metrics(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text NOT NULL,
  sort_order  int NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (metric_id, title)
);

INSERT INTO tasker_templates (metric_id, title, body, sort_order) VALUES
  ('cr_deal_to_sale', 'Разбор потерянных сделок', 'Разобрать 10 последних проигранных первичных сделок: на каком шаге ушёл клиент, была ли отправлена смета, был ли повторный звонок. Выписать 3 типовые причины и что говорить в следующий раз.', 10),
  ('cr_deal_to_sale', 'Скорость первого касания', 'Каждую новую сделку — первый звонок в течение 15 минут. Если не дозвонился — повтор через час и сообщение в мессенджер. Вечером сверить список новых сделок без касания.', 20),
  ('cr_deal_to_sale', 'Дожим смет', 'Пройти все сделки со сметой старше 3 дней без ответа: звонок с конкретным предложением (сроки, доставка, скидка за объём), договориться о следующем шаге с датой.', 30),
  ('cr_repeat_created_to_sale', 'Звонок с поводом', 'Повторным заказчикам звонить с поводом: новый объект, сезон, остатки после прошлой отгрузки. Перед звонком посмотреть историю покупок в карточке.', 10),
  ('cr_repeat_created_to_sale', 'Не терять повторные сделки', 'Все открытые повторные сделки старше недели — созвон и следующий шаг с датой; неактуальные — закрыть с причиной, чтобы не висели в воронке.', 20),
  ('cr_deal_to_sale_all', 'Ежедневный разбор воронки', 'Каждое утро 15 минут: сделки без следующего шага, сделки с просроченной задачей. У каждой сделки — дата следующего контакта.', 10),
  ('cr_deal_to_sale_all', 'Работа с возражениями', 'Выписать 5 частых возражений за прошлый месяц, подготовить ответы вместе с РОПом, отработать на ближайших звонках.', 20),
  ('ppp_conversion', 'Звонок после первой отгрузки', 'Каждому заказчику после первой отгрузки — звонок в течение 3 дней: всё ли приехало, что ещё нужно на объект. Предложить сопутствующие позиции.', 10),
  ('ppp_conversion', 'Окно 22 дня', 'Отработать заказчиков из чек-листа (открытое окно после первой отгрузки): звонок, предложение по следующему этапу стройки, повторная сделка с датой.', 20),
  ('ppp_conversion', 'Кросс-селл по объекту', 'По каждому заказчику с одной отгрузкой уточнить стадию объекта и предложить то, что понадобится следующим (раздел «Что предложить»).', 30),
  ('primary_sales_avg_amount', 'Комплектация заказа', 'В каждой смете предлагать комплект: основной материал + крепёж/расходники/доставка. Проверять, не забыта ли сопутствующая позиция.', 10),
  ('primary_sales_avg_amount', 'Объём под объект', 'Уточнять объём под весь объект, а не под ближайшую неделю; считать выгоду клиента при заказе целиком (доставка одним рейсом, цена за объём).', 20),
  ('all_sales_avg_amount', 'Апсейл в повторных', 'В повторных сделках предлагать расширение заказа: сопутствующие товары, более высокий сорт, запас на следующий этап.', 10),
  ('all_sales_avg_amount', 'Без лишних скидок', 'Скидку давать только в обмен на объём или предоплату; согласовывать с РОПом всё, что выше стандартной.', 20),
  ('calls_outgoing_count_all', 'План звонков на день', 'Утром составить список звонков на день (новые, сметы, повторные), цель — не меньше среднего по отделу. Вечером сверить факт.', 10),
  ('calls_outgoing_count_all', 'Блоки времени на звонки', 'Два блока по часу без переписок и совещаний — только исходящие звонки по списку.', 20),
  ('calls_missed_rate_all', 'Время звонков', 'Перенести обзвон на часы, когда клиенты отвечают (утро до 11 и после 15). Недозвоненным — сообщение в мессенджер и повтор через 2 часа.', 10),
  ('calls_missed_rate_all', 'Актуальные контакты', 'Проверить телефоны в карточках с постоянными недозвонами: второй номер, ЛПР, мессенджер. Обновить контакты в CRM.', 20),
  ('manager_deals_per_worked_day', 'Ежедневная норма', 'Каждый рабочий день — не меньше среднего по отделу новых сделок: входящие, повторные, реактивация старых заказчиков.', 10),
  ('manager_deals_per_worked_day', 'Реактивация базы', 'Выбрать 20 заказчиков без покупок 3+ месяца, обзвонить, по каждому заинтересованному — завести сделку.', 20),
  ('repeat_sales_count_pct', 'Работа с канбаном повторных', 'Каждый день открывать «Канбан повторных»: заказчики с открытым окном — звонок и повторная сделка. Цель — ни одного «горящего» без касания.', 10),
  ('repeat_sales_count_pct', 'Сопровождение после отгрузки', 'После каждой отгрузки — задача себе на звонок через 7–10 дней: как идёт объект, что дальше по стройке.', 20)
ON CONFLICT (metric_id, title) DO NOTHING;

-- ── Настройки ───────────────────────────────────────────────────────────────
-- group_id — ID проекта «Задачник» в Битриксе: 125 (создан владельцем 23.11,
-- https://td.monolit-crm.ru/workgroups/group/125/tasks/). NULL — создание задач отвечает «не настроен проект».
-- directors — Bitrix ID директора по продажам на филиал ('default' + ключи филиалов как в
-- оргструктуре: 'СПб', 'Москва', 'Краснодар'). Оргструктура директора не знает (ТЗ, вопрос 4):
-- по умолчанию Осипов Сергей (1860) на всех.
CREATE TABLE IF NOT EXISTS tasker_settings (
  key         text PRIMARY KEY,
  value       jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tasker_settings (key, value) VALUES
  ('group_id', '125'::jsonb),
  ('directors', '{"default": "1860"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── Сессии (встреча РОПа по одной теме) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasker_sessions (
  id                 bigserial PRIMARY KEY,
  rop_bitrix_id      text NOT NULL,
  metric_id          text NOT NULL REFERENCES tasker_metrics(id),
  slot_start         timestamptz NOT NULL,
  -- 30 мин + 15 на каждого следующего менеджера; пересчитывается при добавлении задачи
  duration_min       int NOT NULL DEFAULT 30,
  -- событие в календаре РОПа (calendar.event.add, фаза 1b): id, чей календарь, состояние синка
  calendar_event_id  bigint,
  calendar_owner_id  text,
  calendar_sync_state text NOT NULL DEFAULT 'pending' CHECK (calendar_sync_state IN ('pending', 'synced', 'failed', 'skipped')),
  calendar_sync_error text,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
-- на случай ранней локальной копии таблицы без колонок календаря
ALTER TABLE tasker_sessions ADD COLUMN IF NOT EXISTS calendar_owner_id text;
ALTER TABLE tasker_sessions ADD COLUMN IF NOT EXISTS calendar_sync_state text NOT NULL DEFAULT 'pending';
ALTER TABLE tasker_sessions ADD COLUMN IF NOT EXISTS calendar_sync_error text;
CREATE INDEX IF NOT EXISTS tasker_sessions_rop_idx ON tasker_sessions (rop_bitrix_id, metric_id, slot_start);

-- ── Задачи ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasker_tasks (
  id                  bigserial PRIMARY KEY,
  bitrix_task_id      bigint,
  -- маркер в описании задачи Битрикса: по нему ретрай находит задачу, созданную прошлой
  -- попыткой с потерянным ответом (findCreated)
  marker              text NOT NULL UNIQUE,
  manager_bitrix_id   text NOT NULL,
  manager_name        text,
  rop_bitrix_id       text,
  rop_name            text,
  director_bitrix_id  text,
  director_name       text,
  creator_bitrix_id   text,
  creator_user_id     text,
  creator_name        text,
  dept_name           text,
  metric_id           text NOT NULL REFERENCES tasker_metrics(id),
  period_from         date NOT NULL,
  period_to           date NOT NULL,
  snapshot            jsonb NOT NULL DEFAULT '{}'::jsonb,
  target              numeric,
  template_id         int REFERENCES tasker_templates(id) ON DELETE SET NULL,
  title               text NOT NULL,
  body                text NOT NULL DEFAULT '',
  deadline            timestamptz NOT NULL,
  duration_min        int NOT NULL DEFAULT 30,
  slot_start          timestamptz,
  slot_end            timestamptz,
  control_date        date NOT NULL,
  -- последний известный статус Битрикса (живой — из tasks.task.list; здесь — для замера и фолбэка)
  bitrix_status       int,
  closed_at           timestamptz,
  -- замер на контрольную дату
  verdict             text CHECK (verdict IN ('achieved', 'improved', 'no_change', 'not_enough_data')),
  measured_value      numeric,
  measured_snapshot   jsonb,
  measured_at         timestamptz,
  measure_attempts    int NOT NULL DEFAULT 0,
  measure_error       text,
  session_id          bigint REFERENCES tasker_sessions(id) ON DELETE SET NULL,
  training_event_id   bigint,
  -- [{clientKey, title, crmUrl}] — ушло чек-листом в задачу
  checklist           jsonb NOT NULL DEFAULT '[]'::jsonb,
  sync_state          text NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending', 'synced', 'failed')),
  sync_error          text,
  cancelled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasker_tasks_manager_idx ON tasker_tasks (manager_bitrix_id, metric_id) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS tasker_tasks_rop_idx     ON tasker_tasks (rop_bitrix_id);
CREATE INDEX IF NOT EXISTS tasker_tasks_session_idx ON tasker_tasks (session_id);
CREATE INDEX IF NOT EXISTS tasker_tasks_measure_idx ON tasker_tasks (control_date) WHERE verdict IS NULL AND cancelled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tasker_tasks_bitrix_idx ON tasker_tasks (bitrix_task_id) WHERE bitrix_task_id IS NOT NULL;

-- ── Outbox записи в Битрикс ─────────────────────────────────────────────────
-- op: create_task | checklist | status | update | comment | calendar (событие сессии в календаре РОПа)
CREATE TABLE IF NOT EXISTS tasker_bx_outbox (
  id          bigserial PRIMARY KEY,
  task_id     bigint NOT NULL REFERENCES tasker_tasks(id) ON DELETE CASCADE,
  op          text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ok', 'error', 'skipped')),
  attempts    int NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);
CREATE INDEX IF NOT EXISTS tasker_bx_outbox_task_idx ON tasker_bx_outbox (task_id, id);
CREATE INDEX IF NOT EXISTS tasker_bx_outbox_todo_idx ON tasker_bx_outbox (next_at) WHERE status IN ('pending', 'error', 'running');

-- ── Гранты роли приложения (как 270: копируем с repeat_kanban_events) ─────────
DO $$
DECLARE r record; t text; s text;
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
    FOREACH t IN ARRAY ARRAY['tasker_metrics', 'tasker_templates', 'tasker_settings', 'tasker_sessions', 'tasker_tasks', 'tasker_bx_outbox'] LOOP
      IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      ELSE
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END IF;
    END LOOP;
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      FOREACH s IN ARRAY ARRAY['tasker_templates_id_seq', 'tasker_sessions_id_seq', 'tasker_tasks_id_seq', 'tasker_bx_outbox_id_seq'] LOOP
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO %I', s, r.grantee);
      END LOOP;
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
