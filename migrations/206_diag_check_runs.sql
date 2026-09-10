-- 206: движок диагностики «Аналитик» (ТЗ №1), фаза 0. БД: system.
-- Журнал прогонов проверок данных (§12): владелец запускает на проде из браузера, исполнитель
-- читает результаты отсюда (stdout прода в файл не пишется; SA-БД с рабочей машины недоступна).
CREATE TABLE IF NOT EXISTS diag_check_runs (
  id        bigserial PRIMARY KEY,
  key       text NOT NULL,
  status    text NOT NULL,
  note      text NOT NULL,
  rows      jsonb NOT NULL DEFAULT '[]'::jsonb,
  ms        int NOT NULL DEFAULT 0,
  ran_by    text,
  ran_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS diag_check_runs_key_idx ON diag_check_runs (key, ran_at DESC);
