-- 185: сценарии авто-коучинга «Аналитика». БД: system.
-- Владелец 09.09: «в панели я должен создавать сценарии: беру важный показатель,
-- например конверсию в продажу; задаю целевой — 15%; если просаживается больше чем
-- на N п.п. — цепочка: совет, проверка через M дней, проверка выполнения совета, ещё
-- совет; если в норме или выше — похвала. Хочу коучить менеджеров в авторежиме».
--
-- Показатель — ЛЮБАЯ собираемая/расчётная метрика каталога (metrics), считается на
-- менеджера тем же движком, что отчёт «По менеджерам» (fetchByManagers +
-- computeCalculated) за окно window_days, заканчивающееся вчера. База сравнения:
-- target — фиксированная цель; own_avg — собственное среднее менеджера за baseline_days
-- ДО окна («упал относительно себя за 3 месяца»). Порог = база − drop_threshold.
--
-- Антиспам заложен в схему: одна открытая цепочка на (сценарий, менеджер); после
-- закрытия — cooldown_days тишины; похвала не чаще praise_cooldown_days; движок шлёт
-- не больше одного сообщения сценариев менеджеру в день (в коде).
CREATE TABLE IF NOT EXISTS bot_scenarios (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  enabled               boolean NOT NULL DEFAULT false,
  metric_id             text NOT NULL,
  window_days           int NOT NULL DEFAULT 30 CHECK (window_days BETWEEN 1 AND 365),
  baseline              text NOT NULL DEFAULT 'target' CHECK (baseline IN ('target', 'own_avg')),
  target_value          numeric,                 -- для baseline='target'
  baseline_days         int NOT NULL DEFAULT 90 CHECK (baseline_days BETWEEN 7 AND 730),
  drop_threshold        numeric NOT NULL DEFAULT 0, -- на сколько ниже базы = просадка (п.п. / единицы метрики)
  advice_text           text NOT NULL,
  followup_days         int NOT NULL DEFAULT 7 CHECK (followup_days BETWEEN 1 AND 90),
  followup_improved_text text NOT NULL,
  followup_same_text    text NOT NULL,
  max_steps             int NOT NULL DEFAULT 2 CHECK (max_steps BETWEEN 1 AND 10),
  cooldown_days         int NOT NULL DEFAULT 14 CHECK (cooldown_days BETWEEN 0 AND 365),
  praise_enabled        boolean NOT NULL DEFAULT true,
  praise_text           text,
  praise_cooldown_days  int NOT NULL DEFAULT 14 CHECK (praise_cooldown_days BETWEEN 1 AND 365),
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE bot_scenarios IS
  'Сценарии авто-коучинга (панель бота → Сценарии, 09.09.2026). Тексты — шаблоны с {имя} {показатель} {значение} {цель} {порог} {было} {дельта}.';

-- Открытые/закрытые цепочки: одна открытая на (сценарий, менеджер).
CREATE TABLE IF NOT EXISTS bot_scenario_runs (
  id              bigserial PRIMARY KEY,
  scenario_id     uuid NOT NULL REFERENCES bot_scenarios(id) ON DELETE CASCADE,
  manager_bitrix_id integer NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  step            int NOT NULL DEFAULT 1,       -- сколько советов уже отправлено
  start_value     numeric,
  last_value      numeric,
  next_check_at   date,
  last_sent_at    timestamptz,
  closed_at       timestamptz,
  closed_reason   text,                         -- improved | max_steps | disabled | manual
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_scenario_runs_open_uq
  ON bot_scenario_runs (scenario_id, manager_bitrix_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS bot_scenario_runs_check_idx ON bot_scenario_runs (status, next_check_at);

-- История: что и кому сценарии отправили (и что показали бы в сухом прогоне — нет,
-- сухой прогон сюда не пишет).
CREATE TABLE IF NOT EXISTS bot_scenario_events (
  id              bigserial PRIMARY KEY,
  scenario_id     uuid NOT NULL REFERENCES bot_scenarios(id) ON DELETE CASCADE,
  run_id          bigint REFERENCES bot_scenario_runs(id) ON DELETE SET NULL,
  manager_bitrix_id integer NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('advice', 'followup_same', 'followup_improved', 'praise')),
  value           numeric,
  threshold       numeric,
  text            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_scenario_events_mgr_idx ON bot_scenario_events (manager_bitrix_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bot_scenario_events_scn_idx ON bot_scenario_events (scenario_id, created_at DESC);

-- Функция бота для сообщений сценариев — выключена, как и всё (решение владельца).
INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config) VALUES
  ('scenarios', 'Сценарии коучинга',
   'Советы, проверки через N дней и похвала по правилам из вкладки «Сценарии»: показатель ниже цели — совет, потом проверка «получилось / всё ещё ниже», в норме — похвала. Не больше одного сообщения менеджеру в день.',
   'Аналитик', false, 34, 'Дайджесты', '{}')
ON CONFLICT (key) DO NOTHING;

-- Когда проверять: час МСК (по умолчанию 10:00, до дневного дайджеста) и только по будням.
ALTER TABLE bot_scenarios ADD COLUMN IF NOT EXISTS check_hour int NOT NULL DEFAULT 10 CHECK (check_hour BETWEEN 0 AND 23);
ALTER TABLE bot_scenarios ADD COLUMN IF NOT EXISTS weekdays_only boolean NOT NULL DEFAULT true;
ALTER TABLE bot_scenarios ADD COLUMN IF NOT EXISTS last_run_at timestamptz;
ALTER TABLE bot_scenarios ADD COLUMN IF NOT EXISTS last_run_summary jsonb;
