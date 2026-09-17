-- 213: «Мои заказчики» → очереди по окну повторной продажи (задача владельца 17.09).
--
-- customer_contacts — честная кнопка «Связался»: менеджер общался с заказчиком
-- не по телефону (мессенджер, почта, лично) — звонка в va.calls нет, но контакт
-- был. Запись снимает заказчика из очередей «окно открыто / окно упущено» так же,
-- как успешный звонок; примечание «о чём договорились» обязательно. История
-- хранится целиком (несколько записей на клиента), в очередях смотрят последнюю.
--
-- customer_exclusion_requests — исключение заказчика из канбана навсегда ЧЕРЕЗ
-- РОПа: менеджер просит с причиной, РОП/руководитель одобряет или отклоняет.
-- Одобрение = отметка no_call в customer_marks (существующая механика «Отказались»).

CREATE TABLE IF NOT EXISTS customer_contacts (
  id            bigserial PRIMARY KEY,
  client_key    text NOT NULL,                       -- 'c<contact_id>' | 'k<company_id>' | 'x<contact_id>'
  manager_bitrix_id text,                            -- чей список (атрибуция на момент отметки)
  channel       text NOT NULL CHECK (channel IN ('messenger', 'email', 'meeting', 'phone_other')),
  note          text NOT NULL CHECK (length(btrim(note)) >= 3),
  contacted_at  timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  created_by_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_contacts_client_idx ON customer_contacts (client_key, contacted_at DESC);

CREATE TABLE IF NOT EXISTS customer_exclusion_requests (
  id            bigserial PRIMARY KEY,
  client_key    text NOT NULL,
  manager_bitrix_id text NOT NULL,                   -- менеджер, из чьего списка исключаем
  requested_by  text NOT NULL,
  requested_by_user_id uuid,
  reason        text NOT NULL CHECK (length(btrim(reason)) >= 3),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by    text,
  decided_at    timestamptz,
  decision_comment text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_exclusion_requests_pending_idx
  ON customer_exclusion_requests (manager_bitrix_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS customer_exclusion_requests_one_pending
  ON customer_exclusion_requests (client_key) WHERE status = 'pending';
