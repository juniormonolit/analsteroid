-- 211: мониторинг сервера Битрикса по диагностическим логам (админы td.monolit-crm.ru дали
-- SFTP-доступ к /logs, 16.09.2026). БД: system. Один снимок = один файл diag_*.txt.
CREATE TABLE IF NOT EXISTS b24_diag_snapshots (
  id            bigserial PRIMARY KEY,
  file          text NOT NULL UNIQUE,
  taken_at      timestamptz NOT NULL,
  load1 numeric, load5 numeric, load15 numeric, running int, threads int,
  mysql_cpu_pct numeric, mysql_mem_pct numeric, mysql_rss_mb int,
  apache_busy int, apache_idle int, apache_slots int, req_per_sec numeric, dur_per_req_ms numeric, bytes_per_sec numeric, apache_restart text,
  http_active int, http_own int, http_working int, http_working_max_sec int,
  mysql_active int, mysql_long int, mysql_max_sec int,
  innodb_history int, lock_waits int, deadlock_at text,
  severity smallint NOT NULL DEFAULT 0,
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail jsonb NOT NULL,             -- topCpu, working, active.topPaths/byCategory, mysql.rows/states/topFingerprints, innodb, apache
  raw_size int,
  synced_at timestamptz NOT NULL DEFAULT now(),
  alerted_at timestamptz
);
CREATE INDEX IF NOT EXISTS b24_diag_snapshots_taken_idx ON b24_diag_snapshots (taken_at DESC);

CREATE TABLE IF NOT EXISTS b24_diag_settings (
  key text PRIMARY KEY, value jsonb NOT NULL, title text NOT NULL, description text NOT NULL, group_name text NOT NULL DEFAULT 'Пороги',
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by text
);
INSERT INTO b24_diag_settings (key, value, title, description, group_name) VALUES
 ('enabled', 'true', 'Синхронизация включена', 'Раз в 5 минут забирать новые файлы из /logs по SFTP и разбирать их. Выключить — если сервер Битрикса недоступен или доступ отозвали.', 'Синк'),
 ('load1_warn', '8', 'Load average: предупреждение', 'Средняя очередь процессов за 1 минуту. Выше — жёлтый уровень. Число ядер сервера Битрикса уточнить у админов: норма — не больше числа ядер.', 'Пороги'),
 ('load1_crit', '16', 'Load average: критично', 'Красный уровень по load average за 1 минуту.', 'Пороги'),
 ('busy_warn', '40', 'Занятых воркеров Apache: предупреждение', 'Сколько из 200 слотов Apache обрабатывают запрос прямо сейчас. Обычно 1–10; при 150+ сайт «висит».', 'Пороги'),
 ('busy_crit', '80', 'Занятых воркеров Apache: критично', '', 'Пороги'),
 ('long_warn', '3', 'Долгих SQL (>5 с): предупреждение', 'Сколько запросов MySQL выполняются дольше 5 секунд в момент снимка.', 'Пороги'),
 ('long_crit', '10', 'Долгих SQL (>5 с): критично', '', 'Пороги'),
 ('maxsec_warn', '30', 'Самый долгий SQL, с: предупреждение', 'Длительность самого долгого запроса MySQL в момент снимка.', 'Пороги'),
 ('maxsec_crit', '120', 'Самый долгий SQL, с: критично', '', 'Пороги'),
 ('lock_warn', '1', 'Ожиданий блокировок: предупреждение', 'Транзакции InnoDB в состоянии LOCK WAIT — кто-то ждёт, пока другой отпустит строку.', 'Пороги'),
 ('lock_crit', '5', 'Ожиданий блокировок: критично', '', 'Пороги'),
 ('mysqlcpu_warn', '200', 'CPU MySQL, %: предупреждение', 'Загрузка процесса mysqld в процентах одного ядра (115% = чуть больше одного ядра).', 'Пороги'),
 ('mysqlcpu_crit', '400', 'CPU MySQL, %: критично', '', 'Пороги'),
 ('alert_level', '2', 'Уровень для оповещения', '1 — писать и на жёлтый, 2 — только на красный. Оповещение уходит через бота «Аналитик» (функция «Мониторинг Битрикса», получатели — там).', 'Оповещения'),
 ('alert_cooldown_min', '60', 'Пауза между оповещениями, мин', 'Не чаще одного сообщения за этот интервал, пока нагрузка держится. Снятие тревоги — отдельным сообщением.', 'Оповещения'),
 ('alert_max_age_min', '20', 'Свежесть снимка для оповещения, мин', 'Снимок старше — уже история, по нему не тревожим (файлы приезжают с задержкой).', 'Оповещения')
ON CONFLICT (key) DO NOTHING;

INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config) VALUES
  ('b24_diag_alerts', 'Мониторинг Битрикса',
   'Предупреждение о высокой нагрузке на сервер Битрикса по диагностическим логам (load average, занятые воркеры Apache, долгие запросы MySQL, блокировки) и сообщение о снятии тревоги. Пороги — в «Настройки → Логи Битрикса».',
   'Аналитик', false, 60, 'Служебные', '{}')
ON CONFLICT (key) DO NOTHING;
