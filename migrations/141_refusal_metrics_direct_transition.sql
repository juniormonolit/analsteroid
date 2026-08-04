-- Задача #2992 (Серёга, 04.08): метрики семейства «X → Отказ»
-- (reservation_to_lost / confirmed_to_lost / sale_to_lost, × перв./повт./все,
-- × кол-во/сумма — 18 строк) считали сделку, если lost_at ПРОСТО позже стадии X
-- (034_refusal_metrics.sql: «lost_at > x_at»), НЕ проверяя, не побывала ли сделка
-- ПОСЛЕ X на какой-то ЕЩЁ более поздней стадии перед отказом. Сделка бронь →
-- продажа → отказ засчитывалась в «Бронь → отказ» И в «Продажа → отказ» разом
-- (двойной учёт), хотя реально ушла в отказ ПРЯМО из продажи.
--
-- Правка владельца 04.08 (расширена с одной метрики «Бронь → отказ» до всего
-- семейства): «сделка засчитывается в «В отказ из X» только если она ушла в
-- отказ непосредственно со стадии X. Если между X и отказом она побывала на
-- любой другой стадии — в эту метрику не попадает».
--
-- Механизм: новый оператор gt_field_or_null в lib/metrics/sqlGen.ts (единая точка
-- для ВСЕГО семейства, код не копипастится). Для каждой метрики к существующему
-- gt_field (lost_at > X_at) добавлены проверки «ни одна более поздняя по воронке
-- стадия не наступила ДО отказа»: для каждой такой стадии — (её_at IS NULL OR
-- её_at > lost_at). Отгрузка (delivered_at) проверяется у ВСЕХ трёх метрик —
-- она терминальный успех после продажи, отдельной «Отгрузка → отказ» метрики
-- сознательно нет (см. комментарий STAGE_PAIRS в stageConversions.ts), но если
-- сделка дошла до отгрузки и ТОЛЬКО ПОТОМ была потеряна — это тоже не «прямой»
-- переход ни из брони, ни из подтв.брони, ни из продажи (см. owners-inbox отчёт
-- по задаче 2992 — такие сделки после фикса не попадают НИ В ОДНУ из трёх
-- метрик, посчитано отдельно).
--
-- Порядок воронки (funnel_id IN (0,1), см. STAGE_GROUPS в stageConversions.ts):
-- ... → reservation(reserved_at) → confirmed(confirmed_at) → sale(sold_at) →
-- shipped(delivered_at).
--
-- НЕ ТРОНУТО (вне разрешённого объёма задачи, отдельное слово владельца нужно):
--   - lost_deals_count/amount (общий отказ, без привязки к «из какой стадии»);
--   - cr_*_to_lost_* (калькулируемые CR%, зависят от num-метрик того же ID —
--     фикс числителя автоматически чинит и их проценты, отдельного изменения
--     формулы не требуется);
--   - «Конверсии стадий» (stage_*_to_lost_num, features/reports/engine/
--     stageConversions.ts) — ТА ЖЕ болячка есть и там (см. owners-inbox отчёт
--     по задаче 2992, раздел «родственные метрики»), но это «конверсии» —
--     фикс туда владелец просил НЕ вносить без отдельного слова.

-- ── Бронь → отказ: после X может не наступить confirmed/sold/delivered ──────
UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"reserved_at"},
  {"field":"confirmed_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"primary"}
]'::jsonb
WHERE id = 'primary_reservation_to_lost_count';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"reserved_at"},
  {"field":"confirmed_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"repeat"}
]'::jsonb
WHERE id = 'repeat_reservation_to_lost_count';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"reserved_at"},
  {"field":"confirmed_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"}
]'::jsonb
WHERE id = 'reservation_to_lost_count';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"reserved_at"},
  {"field":"confirmed_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"primary"}
]'::jsonb
WHERE id = 'primary_reservation_to_lost_amount';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"reserved_at"},
  {"field":"confirmed_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"repeat"}
]'::jsonb
WHERE id = 'repeat_reservation_to_lost_amount';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"reserved_at"},
  {"field":"confirmed_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"}
]'::jsonb
WHERE id = 'reservation_to_lost_amount';

-- ── Подтв. бронь → отказ: после X может не наступить sold/delivered ─────────
UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"confirmed_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"primary"}
]'::jsonb
WHERE id = 'primary_confirmed_to_lost_count';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"confirmed_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"repeat"}
]'::jsonb
WHERE id = 'repeat_confirmed_to_lost_count';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"confirmed_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"}
]'::jsonb
WHERE id = 'confirmed_to_lost_count';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"confirmed_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"primary"}
]'::jsonb
WHERE id = 'primary_confirmed_to_lost_amount';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"confirmed_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"repeat"}
]'::jsonb
WHERE id = 'repeat_confirmed_to_lost_amount';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"confirmed_at"},
  {"field":"sold_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"}
]'::jsonb
WHERE id = 'confirmed_to_lost_amount';

-- ── Продажа → отказ: после X может не наступить delivered ───────────────────
UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"sold_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"primary"}
]'::jsonb
WHERE id = 'primary_sale_to_lost_count';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"sold_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"repeat"}
]'::jsonb
WHERE id = 'repeat_sale_to_lost_count';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"sold_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"}
]'::jsonb
WHERE id = 'sale_to_lost_count';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"sold_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"primary"}
]'::jsonb
WHERE id = 'primary_sale_to_lost_amount';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"sold_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"},
  {"field":"funnel_type","op":"eq","value":"repeat"}
]'::jsonb
WHERE id = 'repeat_sale_to_lost_amount';

UPDATE metrics SET filters = '[
  {"field":"lost_at","op":"gt_field","value":"sold_at"},
  {"field":"delivered_at","op":"gt_field_or_null","value":"lost_at"}
]'::jsonb
WHERE id = 'sale_to_lost_amount';
