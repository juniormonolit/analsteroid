-- 300: Задачник — тесты (TASKER_SPEC.md «Тесты», 26.11). Тренер создаёт тест, менеджеры проходят у себя в ЛК
-- (/profile/tests). Повод — обучения по материалам (кровля, фасад…): эффективность меряют тестом через 1–2 недели.
-- Первый шаг к грейдам (PROGRESSION_IDEAS: Стажёр→Эксперт + аттестация): результаты хранятся по версии теста,
-- ответы и время сохраняются, тест можно пометить «аттестационный» (пока без логики).
--
-- Модель:
--   tasker_tests            — тест (черновик / опубликован / архив) + рабочая копия вопросов (questions jsonb);
--   tasker_test_versions    — снимок опубликованного теста; попытки ссылаются на свою версию. Правка опубликованного
--                             теста, по которому уже есть попытки, = новая версия (старые результаты не «переезжают»);
--   tasker_test_assignments — назначение менеджеру (вручную или по обучению), срок, разрешённые пересдачи;
--   tasker_test_attempts    — попытка: порядок вопросов, ответы, время начала/конца, балл, ошибки;
--   tasker_training_event_tests — тест к обучению: через сколько дней после занятия назначить всем отмеченным «был».
-- Картинки вопросов — в tasker_template_images (миграция 280, отдаются без сессии по uuid).
-- Уведомление менеджеру — функция бота «Аналитик» tasker_tests (включена: пишет только назначенному менеджеру).
-- БД: monolitika (systemDb). Накат — под monolitik; гранты роли приложения — по образцу 275. Идемпотентна.
-- Откат: DROP TABLE tasker_test_attempts, tasker_test_assignments, tasker_training_event_tests, tasker_test_versions,
--        tasker_tests; DELETE FROM bot_channels WHERE key = 'tasker_tests';

CREATE TABLE IF NOT EXISTS tasker_tests (
  id                bigserial PRIMARY KEY,
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  metric_id         text,                         -- тема из tasker_metrics (необязательно)
  pass_percent      integer NOT NULL DEFAULT 80 CHECK (pass_percent BETWEEN 1 AND 100),
  time_limit_min    integer CHECK (time_limit_min IS NULL OR time_limit_min BETWEEN 1 AND 240),
  shuffle_questions boolean NOT NULL DEFAULT true,
  shuffle_options   boolean NOT NULL DEFAULT true,
  is_certification  boolean NOT NULL DEFAULT false, -- «аттестационный» (задел под грейды, логики пока нет)
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  questions         jsonb NOT NULL DEFAULT '[]',  -- рабочая копия: [{id, kind single|multi, text, imageUrl, explanation, options:[{id,text,correct}]}]
  current_version_id bigint,                       -- последняя опубликованная версия
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasker_test_versions (
  id                bigserial PRIMARY KEY,
  test_id           bigint NOT NULL REFERENCES tasker_tests(id) ON DELETE CASCADE,
  version           integer NOT NULL,
  title             text NOT NULL,
  pass_percent      integer NOT NULL,
  time_limit_min    integer,
  shuffle_questions boolean NOT NULL,
  shuffle_options   boolean NOT NULL,
  questions         jsonb NOT NULL,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, version)
);

CREATE TABLE IF NOT EXISTS tasker_test_assignments (
  id                      bigserial PRIMARY KEY,
  test_id                 bigint NOT NULL REFERENCES tasker_tests(id) ON DELETE CASCADE,
  manager_bitrix_user_id  text NOT NULL,
  source                  text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'training')),
  training_event_id       bigint REFERENCES tasker_training_events(id) ON DELETE SET NULL,
  assigned_by             uuid,                   -- users.id; NULL = автоматически по обучению
  assigned_at             timestamptz NOT NULL DEFAULT now(),
  due_at                  timestamptz NOT NULL,
  retakes_allowed         integer NOT NULL DEFAULT 0 CHECK (retakes_allowed BETWEEN 0 AND 10),
  notified_at             timestamptz,
  notify_error            text,
  cancelled_at            timestamptz,
  cancelled_by            uuid
);
CREATE INDEX IF NOT EXISTS tasker_test_assignments_manager_idx ON tasker_test_assignments (manager_bitrix_user_id);
CREATE INDEX IF NOT EXISTS tasker_test_assignments_test_idx ON tasker_test_assignments (test_id);
CREATE INDEX IF NOT EXISTS tasker_test_assignments_event_idx ON tasker_test_assignments (training_event_id) WHERE training_event_id IS NOT NULL;
-- Одно активное назначение теста менеджеру по одному обучению (авто-назначение идемпотентно).
CREATE UNIQUE INDEX IF NOT EXISTS tasker_test_assignments_training_uq
  ON tasker_test_assignments (test_id, manager_bitrix_user_id, training_event_id)
  WHERE training_event_id IS NOT NULL AND cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS tasker_test_attempts (
  id                      bigserial PRIMARY KEY,
  assignment_id           bigint NOT NULL REFERENCES tasker_test_assignments(id) ON DELETE CASCADE,
  version_id              bigint NOT NULL REFERENCES tasker_test_versions(id),
  manager_bitrix_user_id  text NOT NULL,
  started_at              timestamptz NOT NULL DEFAULT now(),
  deadline_at             timestamptz,            -- started_at + лимит времени (NULL — без лимита)
  submitted_at            timestamptz,
  auto_submitted          boolean NOT NULL DEFAULT false, -- закрыта по истечении времени
  question_order          jsonb NOT NULL,         -- [{q: id, o: [optionIds]}] — порядок, который видел менеджер
  answers                 jsonb NOT NULL DEFAULT '{}', -- {questionId: [optionIds]}
  correct_count           integer,
  total_count             integer,
  score_percent           numeric(5,2),
  passed                  boolean,
  wrong_question_ids      text[]
);
CREATE INDEX IF NOT EXISTS tasker_test_attempts_assignment_idx ON tasker_test_attempts (assignment_id);
CREATE INDEX IF NOT EXISTS tasker_test_attempts_manager_idx ON tasker_test_attempts (manager_bitrix_user_id);
-- Одна открытая попытка на назначение.
CREATE UNIQUE INDEX IF NOT EXISTS tasker_test_attempts_open_uq ON tasker_test_attempts (assignment_id) WHERE submitted_at IS NULL;

CREATE TABLE IF NOT EXISTS tasker_training_event_tests (
  event_id     bigint PRIMARY KEY REFERENCES tasker_training_events(id) ON DELETE CASCADE,
  test_id      bigint NOT NULL REFERENCES tasker_tests(id) ON DELETE CASCADE,
  after_days   integer NOT NULL DEFAULT 7 CHECK (after_days BETWEEN 0 AND 60),
  due_days     integer NOT NULL DEFAULT 3 CHECK (due_days BETWEEN 1 AND 30),
  set_by       uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config) VALUES
  ('tasker_tests', 'Задачник: назначен тест',
   'Менеджеру — «вам назначен тест, пройти до …» со ссылкой в ЛК (/profile/tests). Пишет только назначенному менеджеру.',
   'Аналитик', true, 40, 'Задачник', '{}')
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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tasker_tests, tasker_test_versions, tasker_test_assignments, tasker_test_attempts, tasker_training_event_tests TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tasker_tests_id_seq, tasker_test_versions_id_seq, tasker_test_assignments_id_seq, tasker_test_attempts_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON tasker_tests, tasker_test_versions, tasker_test_assignments, tasker_test_attempts, tasker_training_event_tests TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
