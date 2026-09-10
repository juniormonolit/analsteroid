-- 208: журнал прогонов движка диагностики с прогрессом (владелец 10.09: «добавь прогресс-бар,
-- готов и полчаса ждать»). Прогон идёт в фоне на сервере, страница опрашивает эту таблицу.
CREATE TABLE IF NOT EXISTS diag_runs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,                   -- refs | daily
  status      text NOT NULL DEFAULT 'running', -- running | done | error
  stage       text,                            -- человеческое описание текущего шага
  total       int NOT NULL DEFAULT 0,
  done        int NOT NULL DEFAULT 0,
  summary     jsonb,
  error       text,
  started_by  text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS diag_runs_kind_idx ON diag_runs (kind, started_at DESC);
