-- 230: «Канбан повторных продаж» (решения владельца 20.10.2026,
-- ai_docs/fresh_docs/REPEAT_KANBAN_SPEC.md). БД: system. Идемпотентна.
--
-- repeat_kanban_tasks — задачи РОПа менеджеру по заказчику (в Монолитике, не в
-- Битриксе). read_at — менеджер открыл задачу, done_at — отметил выполненной.
-- Был ли звонок, берём из va.calls по сделке, здесь не храним.
--
-- repeat_kanban_reviews — решение РОПа по сделке, закрытой в отказ: brak (брак,
-- дублируется отметкой no_call в customer_marks — заказчик уходит и из «Моих
-- заказчиков»), no_answer (недозвон — не брак, назад в пул), return (вернуть
-- менеджеру). Одно решение на сделку.
--
-- Право section.repeat_kanban — ролям продаж: РОП ставит задачи и разбирает отказы,
-- менеджер видит доску по своим заказчикам и свои задачи.
--
-- Откат: DROP TABLE repeat_kanban_reviews, repeat_kanban_tasks;
--   UPDATE roles SET permissions = array_remove(permissions, 'section.repeat_kanban');

CREATE TABLE IF NOT EXISTS repeat_kanban_tasks (
  id                 bigserial PRIMARY KEY,
  client_key         text NOT NULL,
  deal_id            bigint,                       -- повторная сделка, по которой задача
  manager_bitrix_id  text NOT NULL,                -- исполнитель
  text               text NOT NULL CHECK (length(btrim(text)) >= 3),
  due_at             timestamptz,
  created_by         text NOT NULL,
  created_by_user_id uuid,
  created_by_bitrix_id text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  read_at            timestamptz,
  done_at            timestamptz,
  done_comment       text,
  cancelled_at       timestamptz
);
CREATE INDEX IF NOT EXISTS repeat_kanban_tasks_client_idx ON repeat_kanban_tasks (client_key, created_at DESC);
CREATE INDEX IF NOT EXISTS repeat_kanban_tasks_mgr_open_idx ON repeat_kanban_tasks (manager_bitrix_id) WHERE done_at IS NULL AND cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS repeat_kanban_reviews (
  id                 bigserial PRIMARY KEY,
  client_key         text NOT NULL,
  deal_id            bigint NOT NULL UNIQUE,
  decision           text NOT NULL CHECK (decision IN ('brak', 'no_answer', 'return')),
  reason             text,                         -- для brak: nothing_needed|competitor|negative|other
  comment            text,
  touches_done       int,                          -- сколько недель окна с контактом было на момент решения
  decided_by         text NOT NULL,
  decided_by_user_id uuid,
  decided_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS repeat_kanban_reviews_client_idx ON repeat_kanban_reviews (client_key, decided_at DESC);

-- Владелец — роль приложения (как у остальных таблиц system). Без этого, если миграцию
-- катить под sysadmin, приложение ловит «permission denied for table repeat_kanban_tasks»
-- (живой инцидент 20.10: первая «Сделка + задача» создала сделку 272039, задача не записалась).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'JanCloude') THEN
    ALTER TABLE repeat_kanban_tasks OWNER TO "JanCloude";
    ALTER TABLE repeat_kanban_reviews OWNER TO "JanCloude";
    ALTER SEQUENCE repeat_kanban_tasks_id_seq OWNER TO "JanCloude";
    ALTER SEQUENCE repeat_kanban_reviews_id_seq OWNER TO "JanCloude";
  END IF;
END $$;

UPDATE roles
   SET permissions = (SELECT ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['section.repeat_kanban'])))
 WHERE name IN ('Пользователь', 'РОП', 'Директор', 'МОП')
   AND NOT (permissions @> ARRAY['section.repeat_kanban']);

-- Функция бота «Аналитик»: уведомление менеджеру о новой задаче РОПа. Включена сразу —
-- выключенная, она тихо глотала бы задачи (рубильник — «Настройки → Боты → Аналитик»).
-- Откат: DELETE FROM bot_channels WHERE key = 'repeat_tasks';
INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config) VALUES
  ('repeat_tasks', 'Задачи по повторным продажам',
   'Задача РОПа менеджеру из «Канбана повторных продаж»: кому позвонить и что предложить, со ссылкой на задачу.',
   'Аналитик', true, 42, 'Игра и общение', '{}')
ON CONFLICT (key) DO NOTHING;
