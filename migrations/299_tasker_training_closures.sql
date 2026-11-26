-- 299: Задачник — тренер закрывает запись на дату/время (жалоба Будковского 26.11, TASKER_SPEC.md «Обучения → Закрытое время»).
-- tasker_training_closures — интервалы, когда записывать к тренеру нельзя: весь день (или несколько дней подряд)
-- либо интервал внутри дня (с–по). Причина — необязательна, показывается в сетке «Закрыто: причина» и в ошибке формы.
-- Закрытое время не предлагается в подсказке слота, не принимается в «Собрать занятие», в форме задачи «Теория»
-- (своё время и групповое занятие) и при записи менеджера на занятие.
-- Лимит группы для обучений по материалам (темы kind='product_group') миграции не требует: ключ max_product
-- в tasker_settings 'training_group' (по умолчанию 15 — в коде).
-- БД: monolitika (systemDb). Накат — под monolitik; гранты — по образцу 281. Идемпотентна.
-- Откат: DROP TABLE tasker_training_closures;

CREATE TABLE IF NOT EXISTS tasker_training_closures (
  id                     bigserial PRIMARY KEY,
  trainer_bitrix_user_id text NOT NULL,
  starts_at              timestamptz NOT NULL,
  ends_at                timestamptz NOT NULL CHECK (ends_at > starts_at),
  all_day                boolean NOT NULL DEFAULT false, -- целые дни (МСК): starts_at = 00:00 первого, ends_at = 00:00 после последнего
  reason                 text,
  created_by             uuid,                           -- users.id
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasker_training_closures_trainer_time
  ON tasker_training_closures (trainer_bitrix_user_id, starts_at, ends_at);

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs FROM (
      SELECT grantee::text, privilege_type::text FROM information_schema.role_table_grants
       WHERE table_name = 'repeat_kanban_events' AND table_schema = current_schema()
      UNION ALL
      SELECT tableowner::text, 'OWNER' FROM pg_tables WHERE tablename = 'repeat_kanban_events' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tasker_training_closures TO %I', r.grantee);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tasker_training_closures_id_seq TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON tasker_training_closures TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
