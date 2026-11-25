-- Миграция 295: «Большой брат», поток C — сторож МОПов (ТЗ: ai_docs/fresh_docs/BIG_BROTHER_SPEC.md).
-- Бот «Аналитик» пишет, если менеджер «в работе» сегодня, но N минут подряд в рабочем окне нет
-- ни одного сигнала (звонок, смена стадии / новая сделка, движение задачи, действие в Монолитике).
-- Эскалация — несколько правил с растущим порогом (как call_control_rules).
-- Движок: lib/bots/idleWatch.ts (тик раз в 5 мин, ключ idleWatch в BACKGROUND_JOBS_ALLOW).
-- БД: monolitika (systemDb). Накат — под monolitik; гранты роли приложения — копией с
-- repeat_kanban_events (образец 287/291). Идемпотентна. На прод — только владелец.
-- Откат: DROP TABLE idle_watch_deliveries, idle_watch_cases, idle_watch_rules, idle_watch_settings;
--        DELETE FROM bot_channels WHERE key = 'idle_watch';

-- 1. Настройки (singleton id=1). enabled=false + dry_run=true из коробки: включение — осознанно в UI.
CREATE TABLE IF NOT EXISTS idle_watch_settings (
  id                     integer PRIMARY KEY CHECK (id = 1),
  enabled                boolean NOT NULL DEFAULT false,
  dry_run                boolean NOT NULL DEFAULT true,
  window_start_hour      integer NOT NULL DEFAULT 9  CHECK (window_start_hour BETWEEN 0 AND 23),
  window_end_hour        integer NOT NULL DEFAULT 18 CHECK (window_end_hour BETWEEN 1 AND 24),
  mirror_bitrix_user_id  text,                 -- «Дубль уведомления» (пусто = выкл), и в dry_run тоже
  -- курсоры / состояние движка
  last_tick_at           timestamptz,
  last_tick_summary      text,
  last_stale_warn_at     timestamptz,          -- антиспам предупреждения «источники отстают»
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             text
);
INSERT INTO idle_watch_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 2. Правила. Порог — минуты тишины (от последнего сигнала, не раньше начала окна).
--    Шаблон — прямо в правиле. Плейсхолдеры: {manager_name} {department} {rop_name}
--    {minutes} {hours} {since} {recipient_name} {last_signal}.
CREATE TABLE IF NOT EXISTS idle_watch_rules (
  id                    serial PRIMARY KEY,
  sort_order            integer NOT NULL DEFAULT 0,
  name                  text NOT NULL DEFAULT '',
  minutes_idle          integer NOT NULL CHECK (minutes_idle BETWEEN 15 AND 720),
  recipient             text NOT NULL CHECK (recipient IN ('manager','rop','department_director','company_director','fixed')),
  fixed_bitrix_user_id  text,
  template              text NOT NULL DEFAULT '',
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- 3. Случаи: одно окно тишины менеджера = один случай. Ключ — (менеджер, начало тишины):
--    пока нового сигнала нет, начало то же → случай тот же → правило не шлётся повторно.
--    Новый сигнал → случай закрывается (resolved_at), следующая тишина — новый случай.
CREATE TABLE IF NOT EXISTS idle_watch_cases (
  id                      bigserial PRIMARY KEY,
  manager_bitrix_user_id  text NOT NULL,
  manager_name            text,
  work_date               date NOT NULL,       -- МСК-дата
  silence_from            timestamptz NOT NULL,
  last_signal_at          timestamptz,         -- последний сигнал (NULL — сигнал был до окна)
  last_signal_kind        text,
  max_minutes             integer NOT NULL DEFAULT 0,
  resolved_at             timestamptz,         -- пришёл новый сигнал / окно закончилось
  dry_run                 boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manager_bitrix_user_id, silence_from)
);
CREATE INDEX IF NOT EXISTS idle_watch_cases_open_idx ON idle_watch_cases (manager_bitrix_user_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idle_watch_cases_date_idx ON idle_watch_cases (work_date DESC);

-- 4. Отправки: правило по случаю — один раз на получателя.
CREATE TABLE IF NOT EXISTS idle_watch_deliveries (
  id                        bigserial PRIMARY KEY,
  case_id                   bigint NOT NULL REFERENCES idle_watch_cases(id) ON DELETE CASCADE,
  rule_id                   integer NOT NULL,
  rule_name                 text,
  minutes_idle              integer NOT NULL,
  recipient_kind            text NOT NULL,
  recipient_bitrix_user_id  text,
  recipient_name            text,
  message                   text NOT NULL,
  dry_run                   boolean NOT NULL DEFAULT true,
  mirrored                  boolean NOT NULL DEFAULT false,
  error                     text,
  sent_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idle_watch_deliveries_uniq
  ON idle_watch_deliveries (case_id, rule_id, (COALESCE(recipient_bitrix_user_id, '')));
CREATE INDEX IF NOT EXISTS idle_watch_deliveries_sent_idx ON idle_watch_deliveries (sent_at DESC);

-- 5. Дефолтные правила (гард NOT EXISTS — правки владельца не перетираются повторным накатом).
INSERT INTO idle_watch_rules (sort_order, name, minutes_idle, recipient, template)
SELECT * FROM (VALUES
  (1, '2 ч тишины — менеджеру', 120, 'manager',
   E'За последние {hours} (с {since}) нет звонков, движения сделок и задач.\nЕсли вы на выезде или встрече — всё в порядке, сообщение можно пропустить.'),
  (2, '3 ч тишины — РОПу', 180, 'rop',
   E'{manager_name} ({department}): за последние {hours} (с {since}) нет звонков, движения сделок и задач.\nПоследний сигнал: {last_signal}.')
) AS seed(sort_order, name, minutes_idle, recipient, template)
WHERE NOT EXISTS (SELECT 1 FROM idle_watch_rules);

-- 6. Функция бота «Аналитик» (реестр bot_channels). Включена: у сторожа свои enabled/dry_run,
--    второй выключатель здесь только мешал бы обкатке; общий рубильник «Вырубить бота» работает.
INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config) VALUES
  ('idle_watch', 'Большой брат: сторож МОПов',
   'Менеджеру / РОПу — «N часов нет звонков, движения сделок и задач» в рабочее время. Правила и dry-run — /big-brother/watch.',
   'Аналитик', true, 15, 'Служебные', '{}')
ON CONFLICT (key) DO NOTHING;

-- 7. Гранты роли приложения — как у repeat_kanban_events.
DO $$
DECLARE r record; t text;
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ',') AS privs FROM (
      SELECT grantee::text, privilege_type::text FROM information_schema.role_table_grants
       WHERE table_name = 'repeat_kanban_events' AND table_schema = current_schema()
      UNION ALL
      SELECT tableowner::text, 'OWNER' FROM pg_tables WHERE tablename = 'repeat_kanban_events' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    FOREACH t IN ARRAY ARRAY['idle_watch_settings', 'idle_watch_rules', 'idle_watch_cases', 'idle_watch_deliveries'] LOOP
      IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      ELSE
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END IF;
    END LOOP;
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE idle_watch_rules_id_seq TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE idle_watch_cases_id_seq TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE idle_watch_deliveries_id_seq TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
