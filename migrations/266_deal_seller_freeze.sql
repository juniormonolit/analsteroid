-- 266: «Заморозка продавца» (владелец 16.11: «делай заморозку продавца в отчётах»).
--
-- Все отчёты Монолитики (≈81 место: отчёты, план-факт, рейтинг, геймификация, ТВ, отчёт «МОСКВА») считают продажу
-- по sa.deals.current_manager_id — текущему ответственному сделки, который n8n копирует из Битрикса. Истории
-- ответственных нет (manager_history пуст). Сменили ответственного в старой проданной сделке (БП «Сменить
-- ответственного» при передаче заказчика, увольнение, ручная правка) — продажа задним числом уезжала к новому.
--
-- Решение — в самой копии, без правки отчётов: если у сделки УЖЕ есть продажа или отгрузка (sold_at / delivered_at),
-- смена current_manager_id в sa.deals не применяется — сделка остаётся за тем, кто её продал. В Битриксе ответственный
-- меняется как обычно (новый менеджер видит сделку и товары), у нас — нет. Каждая заблокированная смена — в журнал
-- sa.deal_seller_freeze_log (одна строка на пару «сделка × кому пытались передать», счётчик повторов: n8n шлёт строку
-- заново при каждом изменении сделки).
--
-- Исправить ошибку ответственного в проданной сделке (продажу правда надо отдать другому): строка в
-- sa.deal_seller_unfreeze (deal_id) — следующий апдейт сделки из n8n пройдёт; или сразу:
--   INSERT INTO sa.deal_seller_unfreeze (deal_id, reason, created_by) VALUES (…, '…', '…');
--   UPDATE sa.deals SET current_manager_id = <id> WHERE deal_id = …;
--
-- Сбой внутри триггера не роняет запись n8n: EXCEPTION → строка пишется как пришла.
-- БД: monolitika (схема sa). Накат — под monolitik (владелец sa.deals). Идемпотентна.
-- Откат: DROP TRIGGER trg_deals_freeze_seller ON sa.deals; DROP FUNCTION sa.deals_freeze_seller();
--        DROP TABLE sa.deal_seller_freeze_log, sa.deal_seller_unfreeze;

CREATE TABLE IF NOT EXISTS sa.deal_seller_freeze_log (
  deal_id            bigint NOT NULL,
  frozen_manager_id  bigint NOT NULL,           -- продавец, за которым сделка осталась
  bitrix_manager_id  bigint NOT NULL,           -- кому передали в Битриксе
  first_at           timestamptz NOT NULL DEFAULT now(),
  last_at            timestamptz NOT NULL DEFAULT now(),
  attempts           int NOT NULL DEFAULT 1,
  PRIMARY KEY (deal_id, bitrix_manager_id)
);
COMMENT ON TABLE sa.deal_seller_freeze_log IS
  'Заморозка продавца (миграция 266): смена ответственного в проданной/отгруженной сделке не применена к sa.deals.';

CREATE TABLE IF NOT EXISTS sa.deal_seller_unfreeze (
  deal_id     bigint PRIMARY KEY,
  reason      text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE sa.deal_seller_unfreeze IS
  'Исключения из заморозки продавца (миграция 266): для этих сделок смена ответственного применяется как есть.';

CREATE OR REPLACE FUNCTION sa.deals_freeze_seller() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_manager_id IS DISTINCT FROM OLD.current_manager_id
     AND OLD.current_manager_id IS NOT NULL
     AND (OLD.sold_at IS NOT NULL OR OLD.delivered_at IS NOT NULL)
     AND (NEW.sold_at IS NOT NULL OR NEW.delivered_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM sa.deal_seller_unfreeze u WHERE u.deal_id = NEW.deal_id) THEN
    BEGIN
      INSERT INTO sa.deal_seller_freeze_log (deal_id, frozen_manager_id, bitrix_manager_id)
      VALUES (NEW.deal_id, OLD.current_manager_id, NEW.current_manager_id)
      ON CONFLICT (deal_id, bitrix_manager_id) DO UPDATE SET last_at = now(), attempts = sa.deal_seller_freeze_log.attempts + 1;
    EXCEPTION WHEN others THEN NULL;
    END;
    NEW.current_manager_id := OLD.current_manager_id;
  END IF;
  RETURN NEW;
EXCEPTION WHEN others THEN
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_deals_freeze_seller ON sa.deals;
CREATE TRIGGER trg_deals_freeze_seller BEFORE UPDATE OF current_manager_id ON sa.deals
  FOR EACH ROW EXECUTE FUNCTION sa.deals_freeze_seller();

-- Приложению — читать журнал и вести исключения (по образцу прав на sa.deals).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'JanCloude') THEN
    GRANT SELECT ON sa.deal_seller_freeze_log TO "JanCloude";
    GRANT SELECT, INSERT, DELETE ON sa.deal_seller_unfreeze TO "JanCloude";
  END IF;
END $$;
