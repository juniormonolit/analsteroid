-- 289: «Задачник» — задачи по СДЕЛКЕ из дриллдауна отчёта (TASKER_SPEC.md, «Задачи по сделкам»).
-- Директор/РОП видит в списке сделок «висящую» сделку (всё ещё в броне, отказ без причины…) и ставит по ней задачу:
--   kind = 'deal', deal_id — сделка sa.deals; исполнитель — менеджер сделки (current_manager_id), соисполнитель — его РОП;
--   deal_snapshot — снимок сделки на момент постановки (название, клиент, сумма, воронка/стадия, дней в стадии, ссылка);
--   к сроку — автопроверка (а не замер метрики): сделка продана / проиграна / сдвинулась по стадиям / без движения.
-- Тема задач по сделкам — одна строка tasker_metrics kind = 'deal' (id 'deal', группа «Сделки»): к ней привязаны шаблоны
-- текста в конструкторе (/tasker/templates); замера у неё нет, в формах показателей она не предлагается.
-- Новых таблиц нет — права на tasker_tasks / tasker_metrics / tasker_templates уже выданы (274/280).
-- БД: monolitika (systemDb). Накат — под monolitik. Идемпотентна.
-- Откат: DELETE FROM tasker_tasks WHERE kind = 'deal'; DELETE FROM tasker_templates WHERE metric_id = 'deal';
--        DELETE FROM tasker_metrics WHERE id = 'deal'; ALTER TABLE tasker_tasks DROP COLUMN deal_id, DROP COLUMN deal_snapshot;
--        вернуть CHECK kind/verdict/grp без новых значений.

-- ── Тема «Сделки» ───────────────────────────────────────────────────────────
ALTER TABLE tasker_metrics DROP CONSTRAINT IF EXISTS tasker_metrics_kind_check;
ALTER TABLE tasker_metrics ADD CONSTRAINT tasker_metrics_kind_check CHECK (
  (kind = 'metric' AND product_group_id IS NULL AND pg_measure IS NULL)
  OR (kind = 'product_group' AND product_group_id IS NOT NULL AND pg_measure IN ('amount', 'share'))
  OR (kind = 'deal' AND product_group_id IS NULL AND pg_measure IS NULL));

ALTER TABLE tasker_metrics DROP CONSTRAINT IF EXISTS tasker_metrics_grp_check;
ALTER TABLE tasker_metrics ADD CONSTRAINT tasker_metrics_grp_check
  CHECK (grp IN ('conversion', 'check', 'activity', 'repeat', 'product', 'deal'));

INSERT INTO tasker_metrics (id, label, grp, higher_is_better, format, tag, sort_order, kind)
VALUES ('deal', 'Сделки', 'deal', true, 'number', 'Сделка', 900, 'deal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tasker_templates (metric_id, title, body, sort_order) VALUES
  ('deal', 'Почему всё ещё в броне?', 'Сделка давно стоит в брони. Связаться с клиентом и выяснить: актуален ли заказ, что мешает подтвердить (цена, сроки, оплата, объект не готов). Итог — следующий шаг с датой в карточке сделки: подтверждение, перенос брони или закрытие с причиной.', 10),
  ('deal', 'Нет движения N дней', 'По сделке давно нет движения. Позвонить клиенту, уточнить статус и потребность, поставить в карточке дело на следующий контакт с датой. Неактуальна — закрыть с причиной, чтобы не висела в воронке.', 20),
  ('deal', 'Отказ без причины/комментария', 'Сделка закрыта отказом без внятной причины. Заполнить причину и комментарий в карточке: почему клиент ушёл (цена, сроки, конкурент, нет товара, неактуально). Если клиента можно вернуть — предложить и завести новую сделку.', 30),
  ('deal', 'Просроченная отгрузка', 'Отгрузка по сделке просрочена. Выяснить причину (склад, логистика, оплата, клиент не готов принять), согласовать с клиентом новую дату и обновить сделку. О переносе — предупредить клиента заранее.', 40)
ON CONFLICT (metric_id, title) DO NOTHING;

-- ── Задачи ──────────────────────────────────────────────────────────────────
ALTER TABLE tasker_tasks
  ADD COLUMN IF NOT EXISTS deal_id       bigint,   -- sa.deals.deal_id (только kind = 'deal')
  ADD COLUMN IF NOT EXISTS deal_snapshot jsonb;    -- снимок сделки при постановке; результат проверки — measured_snapshot

-- CHECK на kind (279) и verdict (274) объявлены inline — имена авто; снимаем любые CHECK с этими колонками.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'tasker_tasks'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) ILIKE '%kind%theory%' OR pg_get_constraintdef(oid) ILIKE '%verdict%not_enough_data%')
  LOOP
    EXECUTE format('ALTER TABLE tasker_tasks DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE tasker_tasks ADD CONSTRAINT tasker_tasks_kind_check
  CHECK (kind IN ('theory', 'practice', 'deal'));
ALTER TABLE tasker_tasks ADD CONSTRAINT tasker_tasks_verdict_check
  CHECK (verdict IN ('achieved', 'improved', 'no_change', 'not_enough_data', 'deal_won', 'deal_lost', 'deal_moved', 'deal_stuck'));
ALTER TABLE tasker_tasks DROP CONSTRAINT IF EXISTS tasker_tasks_deal_check;
ALTER TABLE tasker_tasks ADD CONSTRAINT tasker_tasks_deal_check
  CHECK ((kind = 'deal') = (deal_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS tasker_tasks_deal_idx ON tasker_tasks (deal_id) WHERE deal_id IS NOT NULL;
