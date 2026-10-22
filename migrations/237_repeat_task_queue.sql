-- 237: очередь задач канбана повторных (владелец 22.10: «РОП разбирает хоть всех заказчиков, но задачи
-- и сделки не сыплются на менеджера сразу, а ставятся по очереди с интервалом, по срочности»; план —
-- консультация Fable). Позиция = заказчик → менеджер; выдача фоновым джобом repeatQueueIssue «до нормы»
-- (активных задач ≤ manager_task_limit) и не больше queue_daily_limit новых в день, в рабочие часы МСК.
-- Текст задачи собирается в момент выдачи (шаблон + комментарий РОПа), постановщик — кто поставил в очередь.
-- БД: system. Идемпотентна. Владелец — роль приложения (урок 230).
--
-- status: queued → issuing → issued | removed (снята: руками / купил / открылась сделка / брак / скрыт /
-- отказ Битрикса) | failed (сбой выдачи — проверить вручную).
--
-- Откат: DROP TABLE repeat_task_queue;

CREATE TABLE IF NOT EXISTS repeat_task_queue (
  id                  bigserial PRIMARY KEY,
  client_key          text NOT NULL,
  manager_id          text NOT NULL,
  new_responsible_id  text,
  queued_by           text NOT NULL,
  queued_by_name      text,
  template_id         bigint,
  comment             text,
  deadline_rule       text NOT NULL DEFAULT 'window' CHECK (deadline_rule IN ('window', 'today', '3', '7')),
  deadline_time       text NOT NULL DEFAULT '19:00',
  boost               smallint NOT NULL DEFAULT 0 CHECK (boost BETWEEN -2 AND 2),
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'issuing', 'issued', 'removed', 'failed')),
  score               numeric,
  score_at            timestamptz,
  issue_attempts      smallint NOT NULL DEFAULT 0,
  last_error          text,
  issuing_started_at  timestamptz,
  issued_task_id      bigint,
  issued_deal_id      bigint,
  issued_at           timestamptz,
  removed_reason      text,
  removed_by          text,
  removed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Один заказчик в живой очереди — один раз.
CREATE UNIQUE INDEX IF NOT EXISTS repeat_task_queue_live_uq ON repeat_task_queue (client_key) WHERE status IN ('queued', 'issuing');
CREATE INDEX IF NOT EXISTS repeat_task_queue_mgr_idx ON repeat_task_queue (manager_id, status);
CREATE INDEX IF NOT EXISTS repeat_task_queue_issued_idx ON repeat_task_queue (manager_id, issued_at) WHERE status = 'issued';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'JanCloude') THEN
    ALTER TABLE repeat_task_queue OWNER TO "JanCloude";
    ALTER SEQUENCE repeat_task_queue_id_seq OWNER TO "JanCloude";
  END IF;
END $$;
