-- 133: ЭКСТРЕННЫЙ рубильник dry-run для исходящих ботом «Аналитик» менеджерам
-- (правка владельца 02.08, после #2759 «пуши на все события геймификации»).
-- Дословно: «Прям с этого момента начинаем dry-run. Сообщения формируем,
-- логируем, но не отправляем. Хочу несколько дней потестировать без реального
-- взаимодействия с менеджерами». Повод: ночной пересчёт наград (03:00 МСК,
-- instrumentation.ts::scheduleBadgeRecompute) с задачи 2759 умеет реально
-- слать пуши на КАЖДОЕ событие геймификации — фича ещё не публична, а
-- пересчёт сегодня ночью разослал бы их всем менеджерам без предупреждения.
--
-- dry_run_managers = true (ДЕФОЛТ, включаем этим же деплоем): единственная
-- точка проверки — sendManagerBotMessage() в features/badges/engine/
-- notifications.ts, через неё идёт ВСЯ геймификация (pushViaAnalitik) и
-- дайджест/фидбек #2765. Сообщение всегда полностью формируется и пишется в
-- bot_outbound_log; уходит в Bitrix только если dry_run_managers = false.
-- Владельческие/админские каналы (ежедневный отчёт МСК получателю 2098,
-- деал-чаты РОП↔менеджер, инвайты, self-service виджет-скрипт) через эту
-- функцию не идут — рубильник их не касается (см. разбор в WORKLOG 02.08:
-- это адресные человеческие/утилитарные сообщения, не автоматическая оценка).
--
-- DOWN:
--   DROP TABLE IF EXISTS bot_outbound_log;
--   DROP TABLE IF EXISTS bot_settings;

CREATE TABLE IF NOT EXISTS bot_settings (
  id                int PRIMARY KEY CHECK (id = 1),
  dry_run_managers  boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text
);
INSERT INTO bot_settings (id, dry_run_managers, updated_by)
VALUES (1, true, 'deploy-133-emergency-dry-run')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS bot_outbound_log (
  id              bigserial PRIMARY KEY,
  bitrix_id       integer NOT NULL,
  msg_type        text NOT NULL,           -- 'gamification' | 'digest_daily' | 'digest_weekly' | 'advice_nudge' | 'advice_success' | ...
  text            text NOT NULL,
  trigger_reason  text,                    -- заголовок/повод события (badge name, quest name и т.п.), для читаемости в таблице
  dry_run         boolean NOT NULL,        -- true = только залогировано, менеджер сообщения не видел
  sent            boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_outbound_log_created_idx ON bot_outbound_log (created_at DESC);
CREATE INDEX IF NOT EXISTS bot_outbound_log_bitrix_idx ON bot_outbound_log (bitrix_id);
CREATE INDEX IF NOT EXISTS bot_outbound_log_type_idx ON bot_outbound_log (msg_type);
