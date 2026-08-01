-- 123: отметки клиентов в «Моих заказчиках» (продолжение фичи Серёги 01.08).
-- Одна актуальная отметка на клиента (upsert по client_key):
--   snooze  — «Отложить»: клиент выпадает из горящих сигналов до snooze_until,
--             после даты возвращается сам (отметка протухает, чистится лениво);
--   no_call — «Больше не звонить»: причина ОБЯЗАТЕЛЬНА, клиент уходит во
--             вкладку «Отказались» и исключается из сигналов насовсем;
--   wake    — «Вернуть в работу» из авто-«Спящих» (сам авто-архив — правило в
--             коде: молчание > max(3×цикла клиента, 120 дн) без активных сделок,
--             в БД не хранится; wake — явное исключение из правила).
-- Снятие любой отметки = DELETE (кнопка «Вернуть в работу» у менеджера/РОПа).
--
-- DOWN:
--   DROP TABLE IF EXISTS customer_marks;

CREATE TABLE IF NOT EXISTS customer_marks (
  client_key text PRIMARY KEY,               -- 'c<contact_id>' | 'k<company_id>'
  kind text NOT NULL CHECK (kind IN ('snooze', 'no_call', 'wake')),
  snooze_until date,
  reason text CHECK (reason IN ('nothing_needed', 'competitor', 'negative', 'other')),
  comment text,
  created_by text NOT NULL,                  -- display_name на момент отметки (снимок)
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT snooze_needs_until CHECK (kind <> 'snooze' OR snooze_until IS NOT NULL),
  CONSTRAINT no_call_needs_reason CHECK (kind <> 'no_call' OR reason IS NOT NULL)
);
