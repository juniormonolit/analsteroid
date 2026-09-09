-- 205: сценарии коучинга — дерево блоков вместо анкеты. БД: system.
-- Владелец 09.09 после первой выкатки: «хочу охуенный конструктор чат-бота, чтобы
-- строить цепочки и алгоритмы в виде сценариев, а не хуету в попапе». Сценарий
-- теперь = триггер (показатель/база/порог) + две ветки блоков («просадка», «в
-- норме»): сообщение / ждать N дней / проверка с ветвлением да-нет / завершить.
-- Всё дерево — в flow jsonb (формат: lib/jobs/scenarioFlow.ts). Сценариев в БД на
-- момент миграции нет (0 шт. на проде) — старые колонки анкеты просто убираем.
DELETE FROM bot_scenario_events;
DELETE FROM bot_scenario_runs;

ALTER TABLE bot_scenarios ADD COLUMN IF NOT EXISTS flow jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE bot_scenarios
  DROP COLUMN IF EXISTS metric_id, DROP COLUMN IF EXISTS window_days, DROP COLUMN IF EXISTS baseline,
  DROP COLUMN IF EXISTS target_value, DROP COLUMN IF EXISTS baseline_days, DROP COLUMN IF EXISTS drop_threshold,
  DROP COLUMN IF EXISTS advice_text, DROP COLUMN IF EXISTS followup_days, DROP COLUMN IF EXISTS followup_improved_text,
  DROP COLUMN IF EXISTS followup_same_text, DROP COLUMN IF EXISTS max_steps, DROP COLUMN IF EXISTS cooldown_days,
  DROP COLUMN IF EXISTS praise_enabled, DROP COLUMN IF EXISTS praise_text, DROP COLUMN IF EXISTS praise_cooldown_days;
COMMENT ON TABLE bot_scenarios IS
  'Сценарии авто-коучинга (панель бота → Сценарии → редактор). flow jsonb — триггер + дерево блоков, см. lib/jobs/scenarioFlow.ts.';

-- Цепочка = позиция в дереве + когда продолжить.
ALTER TABLE bot_scenario_runs
  ADD COLUMN IF NOT EXISTS branch text NOT NULL DEFAULT 'below',   -- below | norm
  ADD COLUMN IF NOT EXISTS node_id text,                           -- блок, с которого продолжаем
  ADD COLUMN IF NOT EXISTS resume_at date,                         -- когда продолжаем (после «ждать»/антиспама)
  ADD COLUMN IF NOT EXISTS vars jsonb NOT NULL DEFAULT '{}'::jsonb; -- { startValue, lastValue, messagesSent }
ALTER TABLE bot_scenario_runs DROP COLUMN IF EXISTS next_check_at;
CREATE INDEX IF NOT EXISTS bot_scenario_runs_resume_idx ON bot_scenario_runs (status, resume_at);

ALTER TABLE bot_scenario_events DROP CONSTRAINT IF EXISTS bot_scenario_events_kind_check;
ALTER TABLE bot_scenario_events
  ADD COLUMN IF NOT EXISTS node_id text,
  ADD COLUMN IF NOT EXISTS branch text;

-- Оценка эффективности (владелец 09.09: «для какого менеджера и когда какой сценарий
-- сработал и какой результат»): у цепочки фиксируем порог на старте и итог при закрытии.
ALTER TABLE bot_scenario_runs
  ADD COLUMN IF NOT EXISTS threshold numeric,      -- порог на момент старта
  ADD COLUMN IF NOT EXISTS base_value numeric,     -- база (цель / своё среднее) на старте
  ADD COLUMN IF NOT EXISTS result text;            -- recovered | improved | same | worse | praise | n/a (при закрытии)
CREATE INDEX IF NOT EXISTS bot_scenario_runs_mgr_idx ON bot_scenario_runs (manager_bitrix_id, created_at DESC);

-- Трекинг цели (владелец 09.09: «при старте фиксировать стартовый показатель, текущий,
-- достигнут ли целевой и удержан ли; только при удержании в течение заданного периода
-- считать сценарий максимально успешным»). Порог/база зафиксированы на старте цепочки
-- (threshold, base_value); дальше ежедневные снимки в bot_scenario_run_track и итог.
ALTER TABLE bot_scenario_runs
  ADD COLUMN IF NOT EXISTS current_value numeric,          -- последний снимок
  ADD COLUMN IF NOT EXISTS reached_at date,                -- впервые ≥ порога
  ADD COLUMN IF NOT EXISTS at_base_at date,                -- впервые ≥ базы (цели)
  ADD COLUMN IF NOT EXISTS streak_since date,              -- начало текущей серии дней ≥ порога (null — сейчас ниже)
  ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS held_at date,
  ADD COLUMN IF NOT EXISTS track_until date,               -- до какого дня наблюдаем после закрытия
  ADD COLUMN IF NOT EXISTS tracking text NOT NULL DEFAULT 'active', -- active | done
  ADD COLUMN IF NOT EXISTS outcome text;                   -- held | holding | reached_lost | improved | same | worse
CREATE INDEX IF NOT EXISTS bot_scenario_runs_tracking_idx ON bot_scenario_runs (scenario_id, tracking);

CREATE TABLE IF NOT EXISTS bot_scenario_run_track (
  run_id  bigint NOT NULL REFERENCES bot_scenario_runs(id) ON DELETE CASCADE,
  day     date NOT NULL,
  value   numeric,
  PRIMARY KEY (run_id, day)
);

-- Блок «В начало» (владелец 09.09): «Завершить» + пауза, затем «В начало» — цикл коучинга
-- запустится по триггеру снова не раньше паузы. Без «В начало» цепочка закрыта окончательно:
-- restartable=false → сценарий для этого менеджера больше не стартует.
ALTER TABLE bot_scenario_runs ADD COLUMN IF NOT EXISTS restartable boolean NOT NULL DEFAULT true;
