-- Migration 192: ручная отметка «Проверено» у метрики каталога
-- БД: YC analytics (таблица metrics). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/192_metrics_verified.sql --db=analytics
--
-- Владелец глазами сверяет метрики каталога с Битриксом (сверки 02-03.09) и
-- хочет видеть, какие уже проверены, а какие ещё нет. Отметка ручная: ставит и
-- снимает ТОЛЬКО супер-админ (POST /api/catalog/metrics/[id]/verify). Храним не
-- boolean, а «когда и кем» — этого хватает и для галочки, и для ответа на вопрос
-- «а она не устарела?».
--
-- Галочка привязана к ОПРЕДЕЛЕНИЮ метрики: админский PUT /api/admin/metrics/[id]
-- обнуляет обе колонки, если поменялось хоть что-то из formula / filters / agg_fn /
-- agg_field / date_field / metric_type / source. Правка только названий, описаний
-- и флагов видимости отметку не трогает.
--
-- DOWN:
--   ALTER TABLE metrics DROP COLUMN IF EXISTS verified_at, DROP COLUMN IF EXISTS verified_by;

BEGIN;

ALTER TABLE metrics
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by text;

COMMENT ON COLUMN metrics.verified_at IS
  'Когда метрику отметили «Проверено» (только супер-админ). NULL — не проверена. Сбрасывается при смене определения метрики через админский PUT.';
COMMENT ON COLUMN metrics.verified_by IS
  'Логин (users.login) супер-админа, поставившего отметку «Проверено». NULL вместе с verified_at.';

COMMIT;
