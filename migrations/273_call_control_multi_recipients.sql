-- Миграция 273: «Контроль звонков» — НЕСКОЛЬКО ручных получателей на уровень эскалации
-- (владелец 20.11: «после Андреевой в МСК ОС сообщение уходило и Смекалову и Небоге»).
-- 1) call_control_recipient_overrides: PK (отдел, роль) → (отдел, роль, человек).
--    Все строки пары (отдел, роль) — получатели вместо оргструктуры; нет строк — по оргструктуре.
-- 2) call_control_deliveries: одно правило по кейсу теперь даёт по доставке НА КАЖДОГО получателя —
--    UNIQUE (case_id, rule_id) → уникальный индекс (case_id, rule_id, COALESCE(получатель, '')).
-- БД monolitika (system). Идемпотентна.

ALTER TABLE call_control_recipient_overrides DROP CONSTRAINT IF EXISTS call_control_recipient_overrides_pkey;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_control_recipient_overrides_pk3') THEN
    ALTER TABLE call_control_recipient_overrides
      ADD CONSTRAINT call_control_recipient_overrides_pk3 PRIMARY KEY (department_id, role, bitrix_user_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS call_control_deliveries_case_rule_recipient_uniq
  ON call_control_deliveries (case_id, rule_id, (COALESCE(recipient_bitrix_user_id, '')));
ALTER TABLE call_control_deliveries DROP CONSTRAINT IF EXISTS call_control_deliveries_case_id_rule_id_key;
