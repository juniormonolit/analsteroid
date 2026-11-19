-- 272: уведомления канбана запросов логистам (S5, 19.11, LOGIST_REQUESTS_SPEC.md «Уведомления»).
-- 1) Журнал отправленных уведомлений — защита от повторов: «горит SLA» и «просрочка РОПу» — раз на цикл запроса и
--    получателя; сообщения чата — не чаще раза в 15 минут на запрос и получателя (проверка в коде).
-- 2) Вторая функция бота «Аналитик»: «Запросы логистам: логистам и РОПам» — новый запрос / горит SLA / возврат /
--    сообщение / назначение — логистам; просрочка SLA — РОПу менеджера. Менеджерские сообщения (ответ, вопрос в чате)
--    идут в функцию logist_requests (271). Обе выключены — включает владелец («Настройки → Боты → Аналитик»).
--    Поверх — общий dry-run (sendManagerBotMessage): пока он включён, всё только пишется в журнал бота.
-- БД: monolitika (systemDb). Накат — под monolitik; гранты роли приложения — по образцу 270. Идемпотентна.
-- Откат: DROP TABLE logist_request_notifications; DELETE FROM bot_channels WHERE key = 'logist_requests_staff';

CREATE TABLE IF NOT EXISTS logist_request_notifications (
  id                  bigserial PRIMARY KEY,
  request_id          bigint NOT NULL REFERENCES logist_requests(id) ON DELETE CASCADE,
  -- new | hot | overdue_rop | answered | returned | message | reassigned | transferred | accepted | cancelled
  kind                text NOT NULL,
  cycle               integer NOT NULL DEFAULT 0,
  recipient_bitrix_id text NOT NULL,
  sent_at             timestamptz NOT NULL DEFAULT now()
);
-- одно «горит SLA» / «просрочка» на цикл и получателя (повтор сообщений чата режется по времени, не индексом)
CREATE UNIQUE INDEX IF NOT EXISTS logist_request_notifications_once_idx
  ON logist_request_notifications (request_id, kind, cycle, recipient_bitrix_id) WHERE kind IN ('hot', 'overdue_rop');
CREATE INDEX IF NOT EXISTS logist_request_notifications_req_idx ON logist_request_notifications (request_id, recipient_bitrix_id, kind, sent_at DESC);

INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config) VALUES
  ('logist_requests_staff', 'Запросы логистам: логистам и РОПам',
   'Логистам очереди — новый запрос и «горит SLA» (только тем, кто логист по должности или включён в настройках канбана); держателю — возврат, сообщение в чате, назначение, приём/отмена. РОПу менеджера — просрочка SLA.',
   'Аналитик', false, 14, 'Служебные', '{}')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r record;
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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON logist_request_notifications TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE logist_request_notifications_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON logist_request_notifications TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
