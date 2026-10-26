-- 256: решение по отказу «отложить до…» (владелец 26.10: «буду строиться весной» — не брак, а скрыть).
-- Сделка закрывается в «Больше ничего не нужно», заказчик скрыт до даты (customer_marks snooze), решение
-- 'postpone' по сделке — чтобы после даты заказчик вернулся в пул, а не снова на разбор отказа.
-- Откат: вернуть CHECK (decision IN ('brak', 'no_answer', 'return')).
ALTER TABLE repeat_kanban_reviews DROP CONSTRAINT IF EXISTS repeat_kanban_reviews_decision_check;
ALTER TABLE repeat_kanban_reviews ADD CONSTRAINT repeat_kanban_reviews_decision_check
  CHECK (decision IN ('brak', 'no_answer', 'return', 'postpone'));
