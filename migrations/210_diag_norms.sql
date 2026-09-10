-- 210: практическая значимость узлов (владелец 10.09: «сделка без единого звонка — и О БОЖЕ
-- НАДО СРОЧНО ЗВОНИТЬ?! Что за хуета»). Статистической значимости (σ) недостаточно: при 53
-- сделках и базе 0% любые 4 сделки без звонка дают 2σ и «диагноз». Теперь у узла есть:
--   norm_good  — значение, при котором узел ЗАВЕДОМО в норме (для «больше лучше» — не ниже,
--                для «меньше лучше» — не выше). Внутри нормы диагноза нет, что бы ни говорила база;
--   min_delta  — минимальное практически значимое отклонение от базы в единицах узла;
--   unit       — единицы для формулировок.
ALTER TABLE diag_nodes ADD COLUMN IF NOT EXISTS norm_good numeric;
ALTER TABLE diag_nodes ADD COLUMN IF NOT EXISTS min_delta numeric;
ALTER TABLE diag_nodes ADD COLUMN IF NOT EXISTS unit text;

UPDATE diag_nodes SET norm_good = v.norm, min_delta = v.delta, unit = v.unit
  FROM (VALUES
    ('cr_deal_to_sale',            NULL::numeric, 3,   'pct'),
    ('cr_deal_to_sale_repeat',     NULL,          5,   'pct'),
    ('cr_deal_to_priced',          70,            10,  'pct'),
    ('cr_priced_to_reservation',   NULL,          8,   'pct'),
    ('cr_reservation_to_sale',     NULL,          8,   'pct'),
    ('booking_call_rate_reserved', 80,            15,  'pct'),
    ('calls_deals_no_call',        10,            10,  'pct'),
    ('calls_to_reservation_avg',   NULL,          2,   'count'),
    ('calls_touch_speed_median',   60,            30,  'min'),
    ('price_speed_median_hours',   8,             4,   'hours'),
    ('calls_silence_deals',        5,             5,   'count'),
    ('zombie_share',               25,            10,  'pct'),
    ('zombie_count',               10,            5,   'count'),
    ('multi_group_order_share',    NULL,          8,   'pct'),
    ('cross_sell_expected_share',  NULL,          8,   'pct'),
    ('primary_deals_count',        NULL,          10,  'count'),
    ('repeat_created_count',       NULL,          10,  'count'),
    ('primary_shipments_avg_amount', NULL,        50000, 'rub'),
    ('repeat_shipments_avg_amount',  NULL,        50000, 'rub')
  ) AS v(id, norm, delta, unit)
 WHERE diag_nodes.id = v.id;

-- «Меньше — лучше» для узлов-скоростей и мусора (было выставлено при сиде, фиксируем явно).
UPDATE diag_nodes SET higher_is_better = false
 WHERE id IN ('calls_touch_speed_median', 'price_speed_median_hours', 'calls_deals_no_call', 'calls_silence_deals', 'zombie_share', 'zombie_count', 'calls_missed_rate');
