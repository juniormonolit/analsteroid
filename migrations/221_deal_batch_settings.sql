-- 221: режим «Последние N закрытых сделок» и правила «зомби» (ТЗ владельца 28.09).
--
-- Зачем: календарный период мешает сравнивать людей (разное число рабочих дней,
-- отпуска, сезонность) и смещает свежие срезы — быстрые отказы закрываются за день,
-- а сделка, которая в итоге продастся, висит неделями. Режим берёт последние N
-- ЗАКРЫТЫХ сделок КАЖДОГО менеджера (ответ владельца: «для каждого отдельно»).
--
-- Закрытие = продажа / отгрузка / отказ. Если заполнено несколько дат, верным
-- считается ПОСЛЕДНИЙ по таймштампу статус (решение владельца: «продана вчера,
-- проиграна сегодня — это отказ»). На проде такие сделки есть: 6 757 штук.
--
-- Зомби — открытый висяк, который де-факто проигран. Три независимых правила,
-- каждое со своим порогом и выключателем; сделка становится зомби по ЛЮБОМУ из
-- включённых (владелец: «все 3 с порогами»). Дата «смерти» считается от события,
-- а не от now(), иначе все зомби свалились бы в самую свежую пачку.
CREATE TABLE IF NOT EXISTS deal_batch_settings (
  id                   SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- размер пачки по умолчанию (владелец: 100)
  default_batch_size   INT     NOT NULL DEFAULT 100 CHECK (default_batch_size BETWEEN 5 AND 5000),
  -- 1) возраст: открыта дольше N дней с момента создания
  zombie_age_enabled   BOOLEAN NOT NULL DEFAULT true,
  zombie_age_days      INT     NOT NULL DEFAULT 45  CHECK (zombie_age_days BETWEEN 1 AND 3650),
  -- 2) без движения: не обновлялась N дней (deals.updated_at)
  zombie_idle_enabled  BOOLEAN NOT NULL DEFAULT true,
  zombie_idle_days     INT     NOT NULL DEFAULT 30  CHECK (zombie_idle_days BETWEEN 1 AND 3650),
  -- 3) застряла в стадии: в текущей стадии дольше N дней (deal_events, ведётся с 03.04.2026)
  zombie_stage_enabled BOOLEAN NOT NULL DEFAULT false,
  zombie_stage_days    INT     NOT NULL DEFAULT 21  CHECK (zombie_stage_days BETWEEN 1 AND 3650),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO deal_batch_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
