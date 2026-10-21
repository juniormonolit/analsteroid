-- 232: общий список заказчиков компании (владелец 21.10: «смотреть всю компанию целиком»;
-- решение — консультация Fable). Раньше «Мои заказчики»/канбан повторных считали тяжёлый
-- SQL на КАЖДОГО менеджера (1,7 с × 270 ≈ 8 минут БД на всю компанию), теперь один расчёт
-- по всей компании (~16 с) раз в 10 минут в фоне, а менеджерский список — срез этого снимка.
-- В нашей БД, а не в Redis: namespace Redis-кэша привязан к BUILD_ID, т.е. обнуляется на
-- каждой выкатке, а снимок должен её пережить (иначе холодный старт после каждого деплоя).
-- БД: system. Идемпотентна. Владелец — роль приложения (урок миграции 230).
--
-- customer_snapshot      — по строке на менеджера: его заказчики (CustomerRow[] в jsonb).
-- customer_snapshot_meta — одна строка: когда посчитан снимок и типы клиентов из Битрикса
--                          (типы обновляются реже — раз в 6 ч, чтобы не дёргать Битрикс).
--
-- Откат: DROP TABLE customer_snapshot, customer_snapshot_meta;

CREATE TABLE IF NOT EXISTS customer_snapshot (
  manager_id   bigint PRIMARY KEY,
  rows         jsonb NOT NULL,
  computed_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_snapshot_meta (
  id               int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  computed_at      timestamptz NOT NULL,
  rows_total       int NOT NULL DEFAULT 0,
  duration_ms      int,
  version          text,
  client_types     jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_types_at  timestamptz
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'JanCloude') THEN
    ALTER TABLE customer_snapshot OWNER TO "JanCloude";
    ALTER TABLE customer_snapshot_meta OWNER TO "JanCloude";
  END IF;
END $$;
