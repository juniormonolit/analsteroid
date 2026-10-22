-- 238: утреннее сообщение менеджеру по повторным (владелец 22.10): бот «Аналитик» простыми словами —
-- «эти заказчики недавно получили у тебя отгрузку, самое время позвонить», плюс «сами звонили после
-- отказа» и задачи по повторным на сегодня. ВЫКЛЮЧЕНО: функция repeat_morning в bot_channels = false,
-- но джоб repeatMorning собирает сообщения каждый будний день и пишет их в журнал (сухой прогон) —
-- потом сверяем, кому из списка позвонили сами и кому поставил задачу РОП.
-- config.recipients (bitrix id) — пилот: если не пуст, при включённой функции шлём только им.
-- БД: system. Идемпотентна. Откат: DROP TABLE repeat_morning_log; DELETE FROM bot_channels WHERE key = 'repeat_morning';

INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config) VALUES
  ('repeat_morning', 'Утро: кому позвонить по повторным',
   'Каждый будний день утром менеджеру: заказчики, которые недавно получили отгрузку (самое время позвонить), кто сам звонил после отказа, задачи по повторным на сегодня. Выключено — сообщения только пишутся в журнал (сухой прогон). Получатели — пилот: если указаны, шлём только им. Час — по умолчанию 9.',
   'Аналитик', false, 43, 'Игра и общение', '{"recipients": [], "hour": 9}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS repeat_morning_log (
  id           bigserial PRIMARY KEY,
  run_date     date NOT NULL,
  manager_id   text NOT NULL,
  manager_name text,
  message      text NOT NULL,
  -- Кого назвали: [{key, name, kind: fresh|returned|task, lastDeliveredAt, taskId}] — для сверки с делами.
  items        jsonb NOT NULL DEFAULT '[]',
  client_keys  text[] NOT NULL DEFAULT '{}',
  sent         boolean NOT NULL DEFAULT false,
  message_id   bigint,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_date, manager_id)
);
CREATE INDEX IF NOT EXISTS repeat_morning_log_date_idx ON repeat_morning_log (run_date DESC);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'JanCloude') THEN
    ALTER TABLE repeat_morning_log OWNER TO "JanCloude";
    ALTER SEQUENCE repeat_morning_log_id_seq OWNER TO "JanCloude";
  END IF;
END $$;
