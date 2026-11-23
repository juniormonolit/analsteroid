-- 281: Задачник — сетка тренера и канбан «Теория» (TASKER_FEEDBACK_2026-11-23.md п.6, TASKER_SPEC.md «Обучения → Канбан тренера»).
--  1) tasker_training_slots — недельная сетка тренера: день недели × время, длительность, формат/место,
--     закреплённые отделы (слот предлагается только их менеджерам). Правит тренер в «Настройках» раздела.
--     Стартовые данные — из Excel тренера «Обучения брони_повторки.xlsx» (лист «ОС» с сентября 2026 и «НЦ»):
--     Пн–Пт 9:30 / 10:15 / 15:00 / 16:15 онлайн по ~45 мин; Вт/Чт 16:15 закреплены за Москвой («МСК ОС»);
--     11:15 — «нулевой цикл» (было 11:00, правка Будковского 23.11), Питер, очно. Отделы из Excel — подписи (РОПы/«МСК ОС»), а не id орг-структуры,
--     поэтому закреплённые слоты сидятся с department_label без department_ids: пока тренер не выберет отделы,
--     такой слот автоматически не предлагается (вручную — можно).
--  2) tasker_training_events.slot_id / department_label — из какого слота собрано занятие и подпись отдела
--     для сетки (как колонка «Отдел» в его таблице).
--  3) tasker_settings 'training_group' — размер группы: собирать от min (3), предлагать до target (4), не больше max (5);
--     horizon_days — на сколько дней вперёд искать свободный слот.
-- Исторический журнал из Excel (кто когда был) НЕ переносим: фамилии не сопоставляются с Bitrix ID однозначно,
-- в комментариях — оценки людей; события прошлого без записей только засорили бы «Эффективность».
-- БД: monolitika (systemDb). Накат — под monolitik; гранты — по образцу 272/275/277. Идемпотентна.
-- Откат: DROP TABLE tasker_training_slots; ALTER TABLE tasker_training_events DROP COLUMN slot_id, DROP COLUMN department_label;
--        DELETE FROM tasker_settings WHERE key = 'training_group';

CREATE TABLE IF NOT EXISTS tasker_training_slots (
  id                     bigserial PRIMARY KEY,
  -- NULL — тренер по умолчанию (tasker_settings 'trainer', иначе 2054)
  trainer_bitrix_user_id text,
  weekday                smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- 1 = Пн … 7 = Вс (ISO)
  start_time             time NOT NULL,
  duration_min           integer NOT NULL DEFAULT 45 CHECK (duration_min BETWEEN 10 AND 240),
  label                  text,          -- «Нулевой цикл»
  place                  text,          -- «Санкт-Петербург, очно» / ссылка на созвон
  is_offline             boolean NOT NULL DEFAULT false,
  department_ids         text[] NOT NULL DEFAULT '{}', -- uuid отделов продаж (sa.departments.id); пусто — для всех
  department_label       text,          -- подпись в сетке: «Москва», «Питер · НЦ»
  active                 boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tasker_training_slots_uniq
  ON tasker_training_slots (COALESCE(trainer_bitrix_user_id, ''), weekday, start_time);

ALTER TABLE tasker_training_events
  ADD COLUMN IF NOT EXISTS slot_id          bigint REFERENCES tasker_training_slots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department_label text;

-- Стартовая сетка (только если сетки ещё нет — повторный накат не возвращает удалённые тренером слоты).
INSERT INTO tasker_training_slots (weekday, start_time, duration_min, label, place, is_offline, department_label)
SELECT v.weekday, v.start_time::time, v.duration_min, v.label, v.place, v.is_offline, v.department_label
  FROM (VALUES
    (1, '09:30', 45, NULL, NULL, false, NULL), (1, '10:15', 45, NULL, NULL, false, NULL), (1, '11:15', 45, 'Нулевой цикл', 'Санкт-Петербург, очно', true, 'Питер · НЦ'),
    (1, '15:00', 45, NULL, NULL, false, NULL), (1, '16:15', 45, NULL, NULL, false, NULL),
    (2, '09:30', 45, NULL, NULL, false, NULL), (2, '10:15', 45, NULL, NULL, false, NULL), (2, '11:15', 45, 'Нулевой цикл', 'Санкт-Петербург, очно', true, 'Питер · НЦ'),
    (2, '15:00', 45, NULL, NULL, false, NULL), (2, '16:15', 45, NULL, NULL, false, 'Москва'),
    (3, '09:30', 45, NULL, NULL, false, NULL), (3, '10:15', 45, NULL, NULL, false, NULL), (3, '11:15', 45, 'Нулевой цикл', 'Санкт-Петербург, очно', true, 'Питер · НЦ'),
    (3, '15:00', 45, NULL, NULL, false, NULL), (3, '16:15', 45, NULL, NULL, false, NULL),
    (4, '09:30', 45, NULL, NULL, false, NULL), (4, '10:15', 45, NULL, NULL, false, NULL), (4, '11:15', 45, 'Нулевой цикл', 'Санкт-Петербург, очно', true, 'Питер · НЦ'),
    (4, '15:00', 45, NULL, NULL, false, NULL), (4, '16:15', 45, NULL, NULL, false, 'Москва'),
    (5, '09:30', 45, NULL, NULL, false, NULL), (5, '10:15', 45, NULL, NULL, false, NULL), (5, '11:15', 45, 'Нулевой цикл', 'Санкт-Петербург, очно', true, 'Питер · НЦ'),
    (5, '15:00', 45, NULL, NULL, false, NULL), (5, '16:15', 45, NULL, NULL, false, NULL)
  ) AS v(weekday, start_time, duration_min, label, place, is_offline, department_label)
 WHERE NOT EXISTS (SELECT 1 FROM tasker_training_slots);

INSERT INTO tasker_settings (key, value) VALUES
  ('training_group', '{"min": 3, "target": 4, "max": 5, "horizon_days": 14}'::jsonb)
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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tasker_training_slots TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tasker_training_slots_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON tasker_training_slots TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
