-- 128: История отметок клиентов (карточка клиента, фича Серёги 01.08).
-- customer_marks (миграция 123) хранит только ТЕКУЩУЮ отметку (PK client_key,
-- upsert затирает прошлое) — карточке клиента нужен раздел «История отметок:
-- кто и когда». Пишется на КАЖДОЕ действие (snooze/no_call/wake/clear) из
-- app/api/customers/mark; бэкфилл — существующие отметки как первые записи.
--
-- DOWN:
--   DROP TABLE IF EXISTS customer_mark_history;

CREATE TABLE IF NOT EXISTS customer_mark_history (
  id bigserial PRIMARY KEY,
  client_key text NOT NULL,                  -- 'c<contact_id>' | 'k<company_id>'
  action text NOT NULL CHECK (action IN ('snooze', 'no_call', 'wake', 'clear')),
  snooze_until date,
  reason text CHECK (reason IN ('nothing_needed', 'competitor', 'negative', 'other')),
  comment text,
  created_by text NOT NULL,                  -- display_name на момент действия (снимок)
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_mark_history_client
  ON customer_mark_history (client_key, created_at DESC);

-- Бэкфилл: текущие отметки становятся первой записью истории (идемпотентно —
-- только если истории по клиенту ещё нет).
INSERT INTO customer_mark_history (client_key, action, snooze_until, reason, comment, created_by, created_by_user_id, created_at)
SELECT m.client_key, m.kind, m.snooze_until, m.reason, m.comment, m.created_by, m.created_by_user_id, m.created_at
FROM customer_marks m
WHERE NOT EXISTS (SELECT 1 FROM customer_mark_history h WHERE h.client_key = m.client_key);
