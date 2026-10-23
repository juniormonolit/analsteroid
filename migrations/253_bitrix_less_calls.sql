-- 253: «Битрикс дёргать как можно меньше» (владелец 23.10; план — консультация Fable).
-- 1) repeat_task_notes — последний комментарий задачи канбана повторных (taskNotes.ts) хранится у нас, а не
--    в памяти процесса: деплои его больше не сбрасывают. Из Битрикса перечитываем, только если задача
--    изменилась в копии (sa.bitrix_task_current.changed_at новее того, при котором читали), а у открытых —
--    ещё и раз в 30 мин в рабочие часы (сообщение в чат задачи не всегда даёт ONTASKUPDATE: 1 из 10, 23.10).
--    chat_id — из событий задачи в sa (CHAT_ID), а нет там — один раз из tasks.task.list, навсегда.
-- 2) deal_client_fixes — клиент сделок, у которых синк sa потерял контакт/компанию (676 на 23.10, воронки
--    0–3). Найденный клиент не меняется — хранится навсегда; ненайденные перепроверяются раз в сутки. Вместо
--    двух обходов Битрикса: в памяти канбана (каждые 10 мин и после каждого деплоя) и в карточке клиента
--    (crm.deal.list по клиенту при КАЖДОМ открытии).
-- БД: system. Идемпотентна. Откат: DROP TABLE repeat_task_notes, deal_client_fixes;

CREATE TABLE IF NOT EXISTS repeat_task_notes (
  task_id          bigint PRIMARY KEY,
  chat_id          bigint,
  chat_checked     boolean NOT NULL DEFAULT false,
  note             jsonb,
  task_changed_at  timestamptz,
  fetched_at       timestamptz,
  refreshing_at    timestamptz
);

CREATE TABLE IF NOT EXISTS deal_client_fixes (
  deal_id     bigint PRIMARY KEY,
  contact_id  bigint,
  company_id  bigint,
  found       boolean NOT NULL,
  source      text NOT NULL DEFAULT 'bitrix',
  checked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_client_fixes_contact_idx ON deal_client_fixes (contact_id) WHERE found AND contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deal_client_fixes_company_idx ON deal_client_fixes (company_id) WHERE found AND company_id IS NOT NULL;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'JanCloude') THEN
    ALTER TABLE repeat_task_notes OWNER TO "JanCloude";
    ALTER TABLE deal_client_fixes OWNER TO "JanCloude";
  END IF;
END $$;
