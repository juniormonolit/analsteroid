-- Лог закрытий раздела «Разгрузка отделов» (задача 2635, этап 2).
-- СИСТЕМНАЯ БД (YC, та же, что users) — таблица приложения, не аналитическая.
-- Кто/когда закрыл сделку в Битриксе (стадия C1:9) + метрики сделки НА МОМЕНТ
-- закрытия (после синка sa перезапишется живыми данными — поэтому снимок здесь).
-- DOWN: DROP TABLE IF EXISTS offload_close_log;

CREATE TABLE IF NOT EXISTS offload_close_log (
  id                    BIGSERIAL PRIMARY KEY,
  closed_at             timestamptz NOT NULL DEFAULT now(),
  closed_by_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_by_login       text,
  deal_id               bigint NOT NULL,
  deal_name             text,
  amount                numeric,
  kc_group              text,
  head_group            text,
  manager_id            text,
  manager_name          text,
  department_name       text,
  work_days             numeric,          -- накопленные рабочие дни на момент закрытия
  priced_stagnant_days  int,              -- дней в «Созвонился…» без движения (если была эта стадия)
  probability           numeric,          -- P(продажа) модели на момент закрытия
  was_recommended       boolean,          -- была ли за отсечкой своей группы
  status                text NOT NULL,    -- closed | skipped | error
  detail                text              -- причина skip / текст ошибки Битрикса
);

CREATE INDEX IF NOT EXISTS idx_offload_close_log_closed_at ON offload_close_log (closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_offload_close_log_deal ON offload_close_log (deal_id);
