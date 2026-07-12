-- Migration 088: доп-метрики per-deal («мороженые») для раздела «Повторные» (задача #1725)
--
-- БД: SA / Misha DB (analyticsDb() — тот же Postgres, где живут sa.deals, va.calls).
--     Запускать через `node migrations/run_sa.mjs migrations/088_analsteroid_deal_metrics.sql`.
--     НЕ применять на YC (run_analytics/run_system) — таблица должна лежать РЯДОМ с sa.deals,
--     иначе движок отчётов не сможет джойнить (кросс-БД джойна в одном запросе нет).
--
-- Почему схема `rop`, а не `sa.deals`:
--   расширить sa.deals новой колонкой = DDL в схеме `sa`, которая требует роли supabase_admin.
--   Прикладная роль (SA_PG_USER) владеет только схемой `rop` — там и держим доп-таблицу
--   (ключ = deal_id, форма wide под будущий мердж в sa.deals, когда/если дадут supabase_admin).
--   См. ТЗ owners-inbox/analsteroid-touch-speed-metrics.md, статус Э1.
--
-- Идемпотентность: CREATE ... IF NOT EXISTS + INSERT ... ON CONFLICT DO UPDATE.
--   Повторный прогон пересчитывает значения, не плодит строки. Бэкфилл по всем сделкам.
--
-- Правила расчёта (Серёга):
--   • Порог успешного касания N = 30 сек (суперадмин, пока литерал — вынести в settings позже).
--   • Отрицательные касания (звонок раньше создания сделки) НЕ записываем (NULL).
--   • Из товарных групп исключаем услуги (products[].type = 'услуга').

CREATE SCHEMA IF NOT EXISTS rop;

CREATE TABLE IF NOT EXISTS rop.analsteroid_deal_metrics (
  deal_id                  integer PRIMARY KEY,
  first_touch_minutes      numeric,      -- MIN(called_at) любого направления − created_at, мин
  first_touch_at           timestamptz,
  successful_touch_minutes numeric,      -- первый completed & duration>N − created_at, мин
  successful_touch_at      timestamptz,
  first_call_success       boolean,      -- дозвон с 1 раза
  attempts_to_success      integer,      -- № первого успешного звонка в цепочке
  cycle_time_days          numeric,      -- delivered_at − created_at, дни (только отгруженные)
  deal_age_days            numeric,      -- (delivered_at ИЛИ lost_at) − created_at, дни (закрытые)
  product_groups_count     integer,      -- кол-во уникальных товарных групп (услуги исключены)
  product_groups           jsonb,        -- список head_group_name
  product_groups_frozen_at timestamptz,  -- заморозка на delivered/lost
  computed_at              timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now()
);

-- Метрики 1–6 (касания / дозвон / попытки / cycle / возраст)
INSERT INTO rop.analsteroid_deal_metrics AS m
  (deal_id, first_touch_minutes, first_touch_at, successful_touch_minutes,
   successful_touch_at, first_call_success, attempts_to_success, cycle_time_days, deal_age_days)
WITH thr AS (SELECT 30::int AS n),
co AS (
  SELECT c.deal_id, c.called_at, c.duration_seconds,
         row_number() OVER (PARTITION BY c.deal_id ORDER BY c.called_at, c.id) AS rn,
         (c.result::text = 'completed' AND c.duration_seconds > (SELECT n FROM thr)) AS is_ok
  FROM va.calls c
  WHERE c.deal_id IS NOT NULL
),
fc AS (SELECT deal_id, called_at AS first_at, is_ok AS first_ok FROM co WHERE rn = 1),
fs AS (SELECT deal_id, MIN(called_at) AS succ_at, MIN(rn) AS attempts FROM co WHERE is_ok GROUP BY deal_id)
SELECT
  d.deal_id,
  CASE WHEN fc.first_at >= d.created_at
       THEN round(EXTRACT(EPOCH FROM (fc.first_at - d.created_at)) / 60.0, 2) END,
  CASE WHEN fc.first_at >= d.created_at THEN fc.first_at END,
  CASE WHEN fs.succ_at >= d.created_at
       THEN round(EXTRACT(EPOCH FROM (fs.succ_at - d.created_at)) / 60.0, 2) END,
  CASE WHEN fs.succ_at >= d.created_at THEN fs.succ_at END,
  COALESCE(fc.first_ok, false),
  fs.attempts,
  CASE WHEN d.delivered_at IS NOT NULL
       THEN round(EXTRACT(EPOCH FROM (d.delivered_at - d.created_at)) / 86400.0, 2) END,
  CASE WHEN d.delivered_at IS NOT NULL OR d.lost_at IS NOT NULL
       THEN round(EXTRACT(EPOCH FROM (COALESCE(d.delivered_at, d.lost_at) - d.created_at)) / 86400.0, 2) END
FROM sa.deals d
LEFT JOIN fc ON fc.deal_id = d.deal_id
LEFT JOIN fs ON fs.deal_id = d.deal_id
ON CONFLICT (deal_id) DO UPDATE SET
  first_touch_minutes      = EXCLUDED.first_touch_minutes,
  first_touch_at           = EXCLUDED.first_touch_at,
  successful_touch_minutes = EXCLUDED.successful_touch_minutes,
  successful_touch_at      = EXCLUDED.successful_touch_at,
  first_call_success       = EXCLUDED.first_call_success,
  attempts_to_success      = EXCLUDED.attempts_to_success,
  cycle_time_days          = EXCLUDED.cycle_time_days,
  deal_age_days            = EXCLUDED.deal_age_days,
  updated_at               = now();

-- Метрики 7–8: уникальные ТОВАРНЫЕ группы (услуги исключены) + количество.
-- head_group_name товара уже лежит в sa.deals.products (jsonb) — каталог Битрикса не нужен.
UPDATE rop.analsteroid_deal_metrics m
SET product_groups = g.groups,
    product_groups_count = COALESCE(g.cnt, 0),
    product_groups_frozen_at = CASE WHEN d.delivered_at IS NOT NULL OR d.lost_at IS NOT NULL
                                    THEN COALESCE(d.delivered_at, d.lost_at) END,
    updated_at = now()
FROM sa.deals d
LEFT JOIN LATERAL (
  SELECT jsonb_agg(DISTINCT e->>'head_group_name') AS groups,
         count(DISTINCT e->>'head_group_name') AS cnt
  FROM jsonb_array_elements(d.products) e
  WHERE e->>'head_group_name' IS NOT NULL
    AND (e->>'type') IS DISTINCT FROM 'услуга'
) g ON true
WHERE m.deal_id = d.deal_id AND jsonb_typeof(d.products) = 'array';

-- Индекс под джойн из движка отчётов (repeat.ts) — PK уже покрывает deal_id, доп. не нужно.
