-- 249: ответы на анкеты по товарным группам (владелец 23.10, п. 3.3 плана повторки: «в карточке клиента
-- раздел с ответами на вопросы анкеты, который заполняется ИИ по ходу анализа разговора автоматически (с
-- пометкой, что заполнено автоматом) ИЛИ заполняет менеджер в „Карточке клиента“, которая выводится для
-- менеджера прямо в битриксе. При чём сохраняться и выводиться должны оба варианта»).
--   source 'manager' — ответил менеджер (карточка клиента в Монолитике или вкладка в Битриксе);
--   source 'ai'      — из разбора звонков (сессия ИИ-анализа: features/questionnaires/engine/answers.ts
--                      saveAiAnswers), с цитатой, звонком и уверенностью. Менеджеру подписано «по разговорам».
-- Только добавление: новый ответ того же источника на тот же вопрос гасит прежний (superseded_at), история
-- остаётся — это сырьё для самообучения (согласие «по разговорам» и менеджера по вопросу).
-- question_text — снимок вопроса на момент ответа (вопросы правятся на месте, group_questions).
-- client_ref — ClientRef карточки клиента: c<контакт> | k<компания>.
-- БД: system. Идемпотентна. Откат: DROP TABLE questionnaire_answers;

CREATE TABLE IF NOT EXISTS questionnaire_answers (
  id                 bigserial PRIMARY KEY,
  client_ref         text NOT NULL CHECK (client_ref ~ '^[ck][0-9]+$'),
  question_id        int  NOT NULL REFERENCES group_questions (id),
  question_text      text NOT NULL,
  source             text NOT NULL CHECK (source IN ('ai', 'manager')),
  answer_text        text,
  answer_options     text[],
  quote              text,
  call_id            text,
  called_at          timestamptz,
  confidence         numeric(3, 2),
  analysis_id        bigint,
  answered_by        text,
  answered_by_name   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  superseded_at      timestamptz
);
CREATE INDEX IF NOT EXISTS questionnaire_answers_actual_idx
  ON questionnaire_answers (client_ref, question_id, source) WHERE superseded_at IS NULL;

-- Права — как у group_questions (урок 239/240: миграция идёт под суперпользователем контейнера).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs FROM (
      SELECT grantee::text, privilege_type::text FROM information_schema.role_table_grants
       WHERE table_name = 'group_questions' AND table_schema = current_schema()
      UNION ALL
      SELECT tableowner::text, 'OWNER' FROM pg_tables WHERE tablename = 'group_questions' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON questionnaire_answers TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE questionnaire_answers_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON questionnaire_answers TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на group_questions: %)', r.grantee, r.privs;
  END LOOP;
END $$;
