-- 236: причины брака канбана повторных — как отказные стадии повторных воронок Битрикса (владелец 21.10:
-- «причины отказа в браке нужны такие же, как в Битриксе — "Объектов больше нет" и так далее»).
-- Новые значения: no_objects «Объектов больше нет», expensive «Дорого, предложил другие материалы, больше
-- ничего не нужно», failed_client «Подвели клиента — не хочет с нами работать»; nothing_needed «Больше
-- ничего не нужно» уже был. Старые (competitor, negative, other) остаются допустимыми — история.
-- БД: system. Идемпотентна.
ALTER TABLE customer_marks DROP CONSTRAINT IF EXISTS customer_marks_reason_check;
ALTER TABLE customer_marks ADD CONSTRAINT customer_marks_reason_check
  CHECK (reason IN ('nothing_needed', 'competitor', 'negative', 'other', 'no_objects', 'expensive', 'failed_client'));
ALTER TABLE customer_mark_history DROP CONSTRAINT IF EXISTS customer_mark_history_reason_check;
ALTER TABLE customer_mark_history ADD CONSTRAINT customer_mark_history_reason_check
  CHECK (reason IN ('nothing_needed', 'competitor', 'negative', 'other', 'no_objects', 'expensive', 'failed_client'));
