-- 251: тип вопроса анкеты (владелец 23.10: «да, делай тип вопроса»). В анкетах по группам смешались два вида:
--   client        — вопрос КЛИЕНТУ («Какая кровля, гибкая или металлочерепица?»): менеджер видит его в анкете
--                   карточки клиента и в задаче, отвечает он или разбор звонков «по разговорам»;
--   manager_check — ПРОВЕРКА МЕНЕДЖЕРА («Менеджер предложил бесплатного замерщика окон»): только для разбора
--                   звонков и РОПа, в карточке клиента менеджеру не показывается.
-- Уже заведённые вопросы, начинающиеся с «Менеджер…», помечаются проверкой (на 23.10 — анкета «Газобетон»).
-- БД: system. Идемпотентна. Откат: ALTER TABLE group_questions DROP COLUMN audience;

ALTER TABLE group_questions ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'client';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_questions_audience_check') THEN
    ALTER TABLE group_questions ADD CONSTRAINT group_questions_audience_check CHECK (audience IN ('client', 'manager_check'));
  END IF;
END $$;
UPDATE group_questions SET audience = 'manager_check', updated_at = now(), updated_by = 'миграция 251'
 WHERE audience = 'client' AND question ~ '^\s*[Мм][Ее][Нн][Ее][Дд][Жж][Ее][Рр]';  -- без ~*: в C-локали регистр кириллицы не сравнивается
