-- 180: витрина «Повторные» — «По наибольшему» + период «Год» (правка владельца 17.08:
--      «весь пул отчётов Повторные считался категорией товаров По наибольшему и по
--      умолчанию загружался за период Год»). БД: system (saved_reports).
--
-- Что меняется у всех живых отчётов shared_section='repeat':
--   * product_group_mode: 'kc' → 'by_max' — шкала «По наибольшему» (главная группа
--     сделки по самой дорогой позиции); у «Товарные группы — Частота» уже стояло;
--   * relative_period: {month,current} → {year,current} — «Год», как уже было у
--     «Периоды — Повторная выручка» и «Периоды — Компании» (period_mode='relative'
--     у всех, не трогаем).
--
-- Идемпотентно: повторный прогон ничего не меняет.
--
-- DOWN (вернуть как было, кроме двух периодных и «Частоты», у которых значения были
-- свои изначально — их этот UPDATE и так не менял бы):
--   UPDATE saved_reports SET product_group_mode='kc',
--     relative_period='{"unit":"month","anchor":"current"}'::jsonb
--   WHERE shared_section='repeat' AND deleted_at IS NULL;

UPDATE saved_reports
   SET product_group_mode = 'by_max',
       relative_period = '{"unit":"year","anchor":"current"}'::jsonb
 WHERE shared_section = 'repeat'
   AND deleted_at IS NULL;
