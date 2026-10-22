-- 240: «один человек — один заказчик» (владелец 22.10, вариант Б; план — консультация Fable).
-- Автосклейка считается каждый раз из sa (features/customers/engine/merge.ts):
--   (а) c<контакт> и x<контакт> одного контакта — всегда один заказчик;
--   (б) контакт ↔ компания по совместным сделкам (компания с ≤ 3 контактами в сделках).
-- Здесь — только РУЧНЫЕ решения РОПа и старше: merge (склеить member → primary) и split
-- («это НЕ один человек» — гасит автосклейку member). Обратимо: удалить строку.
-- Включение — флаг customer_merge в feature_flags (по умолчанию выключен: дифф нулевой).
-- БД: system. Идемпотентна. Откат: DROP TABLE customer_merge_links; DELETE FROM feature_flags WHERE key = 'customer_merge';

CREATE TABLE IF NOT EXISTS customer_merge_links (
  member_key        text PRIMARY KEY,
  primary_key       text,
  mode              text NOT NULL CHECK (mode IN ('merge', 'split')),
  comment           text,
  created_by        text NOT NULL,
  created_by_name   text,
  created_by_bitrix_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_merge_needs_primary CHECK (mode <> 'merge' OR primary_key IS NOT NULL),
  CONSTRAINT customer_merge_not_self CHECK (primary_key IS DISTINCT FROM member_key)
);
CREATE INDEX IF NOT EXISTS customer_merge_links_primary_idx ON customer_merge_links (primary_key);

INSERT INTO feature_flags (key, enabled, updated_by) VALUES ('customer_merge', false, 'deploy-240')
ON CONFLICT (key) DO NOTHING;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'JanCloude') THEN
    ALTER TABLE customer_merge_links OWNER TO "JanCloude";
  END IF;
END $$;
