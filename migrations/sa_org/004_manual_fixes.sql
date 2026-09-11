-- Задача #6260 (Серёга/Иосиф, санкция дана в сообщении 11.09): «Снять с продажи» —
-- ручная очистка sold_at у сделки, ошибочно поставленной в продажу. sold_at НЕ
-- очищается автоматически НИКОГДА (решение владельца 11.09: залипание — защита
-- рейтинга от накрутки) — только это ручное действие, доступное директору и выше
-- (право action.deals.unsell, см. lib/auth/perms.ts), с обязательной причиной и
-- журналом правок. Применяется на Мишиной БД (62.113.100.67) под supabase_admin,
-- как migrations/sa_org/001-003 — junior_user (роль приложения) DDL не может.
--
-- Накатка (ТОЛЬКО вручную, после ревью — не автодеплоем, см. ai_docs/fresh_docs/WORKFLOW.md):
--   docker exec -i supabase-db psql -U supabase_admin -d postgres \
--     < migrations/sa_org/004_manual_fixes.sql
--
-- Схема журнала намеренно общая (field/old_value/new_value текстом) — если
-- завтра понадобится ручная правка другого поля сделки, новой миграции/таблицы
-- не потребуется, только новый код в lib/sales/unsellDeal.ts.

CREATE TABLE IF NOT EXISTS sa.manual_fixes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     integer NOT NULL,
  field       text NOT NULL,
  old_value   text,
  new_value   text,
  reason      text NOT NULL,
  user_id     text NOT NULL,        -- system.users.id (uuid как текст) — своя БД, FK не ставим
  user_name   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manual_fixes_deal_id    ON sa.manual_fixes (deal_id);
CREATE INDEX IF NOT EXISTS idx_manual_fixes_created_at ON sa.manual_fixes (created_at DESC);

-- Проверка после накатки:
--   \d sa.manual_fixes
--   SELECT count(*) FROM sa.manual_fixes; -- 0
