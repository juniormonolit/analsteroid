-- 302: Задачник — правки собрания 26.11 (ai_docs/fresh_docs/tz/2026-11-26_tasker.md).
--  п.2  Уведомления менеджеру ботом «Аналитик»: «с вами работа такого-то числа с–по, ведёт …», перенос, отмена,
--       напоминание перед началом. Состояние «что уже сообщили» — tasker_work_notices (одна строка на работу:
--       задача «Практика» со временем или запись на занятие тренера). Тик Задачника сверяет текущие работы с этой
--       таблицей и шлёт разницу (новое / перенос / смена темы / отмена / напоминание).
--       Функция бота tasker_manager_notify — включена (пишет только самому менеджеру); выключить — «Настройки → Боты».
--       Время напоминания — tasker_settings 'manager_notify' {remind_minutes: 15 | 30 | 60 | 1440}, по умолчанию 30.
--  п.6  План разбора для РОПа по теме — tasker_metrics.practice_plan (правится в «Задачник → Шаблоны → тема»),
--       подставляется в описание задачи «Практика».
--  п.7  «Утвердить состав и тему» у занятия тренера — tasker_training_events.approved_at / approved_by.
-- БД: monolitika (systemDb). Накат — под monolitik; гранты новой таблице — по образцу 299/300. Идемпотентна.
-- Откат: DROP TABLE tasker_work_notices; ALTER TABLE tasker_metrics DROP COLUMN practice_plan;
--        ALTER TABLE tasker_training_events DROP COLUMN approved_at, DROP COLUMN approved_by;
--        DELETE FROM tasker_settings WHERE key = 'manager_notify'; DELETE FROM bot_channels WHERE key = 'tasker_manager_notify';

CREATE TABLE IF NOT EXISTS tasker_work_notices (
  work_key          text PRIMARY KEY,           -- 'task:<id>' | 'enr:<event_id>:<manager>'
  manager_bitrix_id text NOT NULL,
  start_at          timestamptz NOT NULL,
  end_at            timestamptz NOT NULL,
  topic             text NOT NULL DEFAULT '',   -- тема/метрика на момент последнего сообщения (смена — «тема изменилась»)
  lead_name         text,                       -- кто ведёт (РОП / тренер)
  notified_at       timestamptz,                -- сообщение «назначено» (или последнее «перенесено»)
  reminded_at       timestamptz,                -- напоминание перед началом
  gone_at           timestamptz,                -- работа исчезла (отмена) — сообщение «отменено» отправлено / не нужно
  silent            boolean NOT NULL DEFAULT false, -- строка заведена при первом запуске без сообщения (старые работы)
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasker_work_notices_manager ON tasker_work_notices (manager_bitrix_id, start_at);
CREATE INDEX IF NOT EXISTS tasker_work_notices_open ON tasker_work_notices (start_at) WHERE gone_at IS NULL;

ALTER TABLE tasker_metrics ADD COLUMN IF NOT EXISTS practice_plan text;

DO $$
BEGIN
  IF to_regclass('tasker_training_events') IS NOT NULL THEN
    ALTER TABLE tasker_training_events
      ADD COLUMN IF NOT EXISTS approved_at timestamptz,
      ADD COLUMN IF NOT EXISTS approved_by text;
  END IF;
END $$;

INSERT INTO tasker_settings (key, value) VALUES ('manager_notify', '{"remind_minutes": 30}'::jsonb) ON CONFLICT (key) DO NOTHING;

INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config) VALUES
  ('tasker_manager_notify', 'Задачник: работа с менеджером',
   'Менеджеру — «с вами работа такого-то числа с–по, ведёт РОП/тренер, по такой-то метрике»; перенос, отмена, смена темы и напоминание перед началом (за 30 минут, правится в «Задачник → Шаблоны»). Пишет только самому менеджеру.',
   'Аналитик', true, 41, 'Задачник', '{}')
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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tasker_work_notices TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON tasker_work_notices TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
