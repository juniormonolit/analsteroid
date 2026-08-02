-- 133: Дайджест «Аналитика» + журнал подсказок (задача 2765, ТЗ Серёги 02.08).
-- Ежедневный/еженедельный пуш менеджеру ботом «Аналитик»: 2-4 ключевые цифры
-- с трендом к прошлому периоду + персональная подсказка «кому позвонить и что
-- предложить» (движок «Моих заказчиков», features/customers/engine/*).
--
-- advice_log — сердце цикла обратной связи: одна строка = один совет «этому
-- менеджеру позвонить этому клиенту и предложить эту группу», выданный в
-- конкретном дайджесте. Дальше ежедневный тик (lib/jobs/adviceFeedback.ts)
-- следит за парой (manager, client) и переводит статус:
--   active            — выдан, контакта ещё не было, тик может слать напоминания
--                        (не больше max_reminders из digest_settings, дефолт 2).
--   contacted         — звонок замечен (va.calls после advised_at), напоминания
--                        больше не шлём («контакт был — не спамим»), но продолжаем
--                        следить за сделкой ещё WATCH_DAYS_AFTER_CONTACT дней.
--   success           — после совета клиенту продалась сделка (sold_at >
--                        advised_at) — менеджеру уходит подтверждение «как я и
--                        говорил», next_eligible_at не выставляется (не блокируем).
--   closed_no_contact — 2 напоминания истрачены, контакта так и не было — тихо
--                        закрываем (без сообщения менеджеру, см. правило «помощь,
--                        а не надзор»), next_eligible_at = +30 дней на эту пару.
--   closed_no_deal    — контакт был, но сделки не случилось за окно наблюдения —
--                        тихо закрываем, next_eligible_at = +30 дней.
-- Пока по паре (manager_bitrix_id, client_key) есть открытая строка (active/
-- contacted) ИЛИ next_eligible_at ещё не наступил — движок не предлагает эту
-- пару заново (правило «не более 2 напоминаний, потом не возвращаться 30 дней»).
--
-- digest_settings — singleton (id=1), редактируется в «Настройки → Геймификация
-- → Дайджест» (superadmin): вкл/выкл ежедневного и еженедельного, час отправки
-- (МСК), лимит напоминаний. Остальные тайминги (интервал между напоминаниями,
-- окно наблюдения после контакта, cooldown 30 дней) — константы в коде, не
-- вынесены в UI по брифу (там просили только вкл/выкл + время + лимит).
--
-- DOWN:
--   DROP TABLE IF EXISTS advice_log;
--   DROP TABLE IF EXISTS digest_settings;

CREATE TABLE IF NOT EXISTS advice_log (
  id                 bigserial PRIMARY KEY,
  manager_bitrix_id  integer NOT NULL,
  client_key         text NOT NULL,             -- 'c<contact_id>' | 'k<company_id>'
  client_type        text NOT NULL CHECK (client_type IN ('contact', 'company')),
  client_id          bigint NOT NULL,
  client_name        text,                       -- имя на момент совета (resolveClientNames), для истории/UI
  recommended_group  text NOT NULL,               -- кросс-селл группа из crossSell.ts::recommendFor
  based_on_groups    text[] NOT NULL DEFAULT '{}',-- группы последней покупки, от которых считали
  fallback           boolean NOT NULL DEFAULT false, -- true = общий топ базы (мало статистики по клиенту)
  confidence_pct     integer,                     -- items[0].pct из рекомендации
  call_signal        text,                        -- 'overdue_repeat' | 'active_no_call' — почему «пора звонить»
  digest_kind        text NOT NULL CHECK (digest_kind IN ('daily', 'weekly')),
  status             text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'contacted', 'success', 'closed_no_contact', 'closed_no_deal')),
  reminder_count     integer NOT NULL DEFAULT 0,
  advised_at         timestamptz NOT NULL DEFAULT now(),
  last_nudge_at      timestamptz,
  contacted_at       timestamptz,
  resolved_at        timestamptz,
  resolved_reason    text,
  next_eligible_at   timestamptz,                 -- когда снова можно советовать эту пару (null = не блокирована)
  test_run           boolean NOT NULL DEFAULT false -- пометка ручных тестовых прогонов (app/api/admin/digest-test) — не считаются в статистике
);

CREATE INDEX IF NOT EXISTS advice_log_open_idx ON advice_log (status) WHERE status IN ('active', 'contacted');
CREATE INDEX IF NOT EXISTS advice_log_pair_idx ON advice_log (manager_bitrix_id, client_key, advised_at DESC);

CREATE TABLE IF NOT EXISTS digest_settings (
  id             int PRIMARY KEY CHECK (id = 1),
  daily_enabled  boolean NOT NULL DEFAULT true,
  weekly_enabled boolean NOT NULL DEFAULT true,
  daily_hour     int NOT NULL DEFAULT 8  CHECK (daily_hour  BETWEEN 0 AND 23), -- МСК, окно отправки [hour, hour+1)
  weekly_hour    int NOT NULL DEFAULT 8  CHECK (weekly_hour BETWEEN 0 AND 23), -- МСК, только понедельник
  max_reminders  int NOT NULL DEFAULT 2  CHECK (max_reminders BETWEEN 0 AND 5),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text
);

INSERT INTO digest_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
