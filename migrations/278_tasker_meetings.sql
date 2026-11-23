-- 278: «Задачник» — регулярные собрания (планёрки, разборы…), TASKER_SPEC.md «Регулярные собрания», 23.11.
-- Серия = одна строка; вхождения разворачиваются на лету (features/tasker/meetings/engine/recurrence.ts).
-- Отмена одного вхождения — строка в tasker_meeting_exceptions (в Битрикс через REST не уходит: EXDATE
-- calendar.event.add/update молча игнорирует — проверено 23.11).
-- Битрикс: одно повторяющееся событие в календаре организатора (rrule); для «ежемесячно n-й день недели»
-- REST BYDAY с номером не принимает — там «скользящее» событие на ближайшее вхождение (calendar_mode='rolling').
-- Синк — состояние на строке (calendar_sync_state pending/failed → фоновая задача «tasker» повторяет), как у обучений.
-- БД: monolitika (systemDb). Накат — под monolitik; гранты — копией с repeat_kanban_events (как 270/274). Идемпотентна.
-- Откат: DROP TABLE tasker_meeting_exceptions, tasker_meetings;

CREATE TABLE IF NOT EXISTS tasker_meetings (
  id                    bigserial PRIMARY KEY,
  title                 text NOT NULL,
  agenda                text NOT NULL DEFAULT '',
  organizer_bitrix_id   text NOT NULL,
  start_date            date NOT NULL,
  -- время начала по МСК
  start_time            time NOT NULL,
  duration_min          int NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 480),
  -- weekdays (пн–пт) | weekly | biweekly (weekdays[] — ISO 1=пн…7=вс) | monthly_day (month_day 1–28) |
  -- monthly_nth (month_nth 1–4 или -1 = последний, month_weekday ISO)
  recurrence            text NOT NULL CHECK (recurrence IN ('weekdays', 'weekly', 'biweekly', 'monthly_day', 'monthly_nth')),
  weekdays              int[] NOT NULL DEFAULT '{}',
  month_day             int CHECK (month_day BETWEEN 1 AND 28),
  month_nth             int CHECK (month_nth IN (1, 2, 3, 4, -1)),
  month_weekday         int CHECK (month_weekday BETWEEN 1 AND 7),
  until_date            date,
  place                 text,
  -- участники: отделы целиком (uuid sa.departments, с поддеревом) и/или отдельные люди (Bitrix ID)
  dept_ids              text[] NOT NULL DEFAULT '{}',
  person_ids            text[] NOT NULL DEFAULT '{}',
  created_by            text,
  created_by_name       text,
  cancelled_at          timestamptz,
  -- календарь Битрикса
  calendar_mode         text NOT NULL DEFAULT 'rrule' CHECK (calendar_mode IN ('rrule', 'rolling')),
  calendar_event_id     bigint,
  calendar_owner_id     text,
  -- rolling: на какое вхождение сейчас стоит событие
  calendar_occ_date     date,
  calendar_sync_state   text NOT NULL DEFAULT 'pending' CHECK (calendar_sync_state IN ('pending', 'synced', 'failed')),
  calendar_sync_error   text,
  calendar_sync_attempts int NOT NULL DEFAULT 0,
  calendar_synced_at    timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasker_meetings_active_idx ON tasker_meetings (start_date) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS tasker_meetings_sync_idx ON tasker_meetings (calendar_synced_at) WHERE calendar_sync_state <> 'synced';

CREATE TABLE IF NOT EXISTS tasker_meeting_exceptions (
  meeting_id    bigint NOT NULL REFERENCES tasker_meetings(id) ON DELETE CASCADE,
  occ_date      date NOT NULL,
  cancelled_by  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, occ_date)
);

DO $$
DECLARE r record; t text;
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
    FOREACH t IN ARRAY ARRAY['tasker_meetings', 'tasker_meeting_exceptions'] LOOP
      IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      ELSE
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END IF;
    END LOOP;
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tasker_meetings_id_seq TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
