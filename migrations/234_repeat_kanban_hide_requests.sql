-- 234: «Скрыть из пула» — только РОП; менеджер может лишь ПРЕДЛОЖИТЬ скрыть (владелец 21.10,
-- аудит Fable: «менеджер может прятать неудобных заказчиков»). Предложение висит на карточке и
-- в режиме «Сегодня» у РОПа; РОП принимает (заказчик уходит в «Скрытые» с датой и комментарием
-- менеджера) или отклоняет. БД: system. Идемпотентна. Владелец — роль приложения (урок 230).
--
-- Откат: DROP TABLE repeat_kanban_hide_requests;

CREATE TABLE IF NOT EXISTS repeat_kanban_hide_requests (
  id                 bigserial PRIMARY KEY,
  client_key         text NOT NULL,
  manager_id         text,
  until              date NOT NULL,
  comment            text NOT NULL,
  requested_by       text NOT NULL,
  requested_by_user_id text,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  decided_by         text,
  decided_at         timestamptz,
  decision_comment   text
);
-- Одно открытое предложение на заказчика.
CREATE UNIQUE INDEX IF NOT EXISTS repeat_kanban_hide_requests_pending_uq
  ON repeat_kanban_hide_requests (client_key) WHERE status = 'pending';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'JanCloude') THEN
    ALTER TABLE repeat_kanban_hide_requests OWNER TO "JanCloude";
    ALTER SEQUENCE repeat_kanban_hide_requests_id_seq OWNER TO "JanCloude";
  END IF;
END $$;
