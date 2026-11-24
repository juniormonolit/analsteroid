-- 290: «Увольнятор» v2 (правка владельца 24.11, после первой выкатки 287). Контракт: features/dismissal/types.ts (шапка v2).
--   dismissal_items.action  += 'brak' (первичка в автобрак), 'follow' (задача/дело вслед за сделкой — в строке после
--                              start хранится уже развёрнутое действие, но значение допустимо);
--   dismissal_items.info    — подробности строки для UI и разворота (DismissalItemInfo: воронка, квалификация первички,
--                              LTV/ранг заказчика повторки, сделка задачи/дела);
--   dismissal_runs.finals   — завершающие шаги (DismissalFinals: сообщение РОПу, задача «сменить пароль»);
--   dismissal_runs.rop_bitrix_id — РОП, определённый при сканировании (ropOfManager), для DismissalRunDetail.rop.
-- Виды строк v1 (deal_open, lead, contact, …) кодом v2 не исполняются; реальных прогонов v1 не было (24.11).
-- БД: monolitika (systemDb), накат — под monolitik. Таблицы те же, что в 287 — новые гранты не нужны.
-- Идемпотентна. Откат: DROP COLUMN info / finals / rop_bitrix_id; CHECK action — список из 287.

DO $$
DECLARE c text;
BEGIN
  -- CHECK на action в 287 безымянный (автоимя) — снимаем любой CHECK, где упомянут action, и ставим именованный.
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'dismissal_items'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%action%'
  LOOP
    EXECUTE format('ALTER TABLE dismissal_items DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE dismissal_items ADD CONSTRAINT dismissal_items_action_check
  CHECK (action IS NULL OR action IN ('transfer', 'brak', 'follow', 'close', 'remove', 'skip'));

ALTER TABLE dismissal_items ADD COLUMN IF NOT EXISTS info jsonb NOT NULL DEFAULT '{}';
ALTER TABLE dismissal_runs  ADD COLUMN IF NOT EXISTS finals jsonb NOT NULL DEFAULT '{}';
ALTER TABLE dismissal_runs  ADD COLUMN IF NOT EXISTS rop_bitrix_id bigint;
-- Когда закончен последний сбор (UI «Собрано {дата}»; после «Пересобрать» обновляется).
ALTER TABLE dismissal_runs  ADD COLUMN IF NOT EXISTS scanned_at timestamptz;
