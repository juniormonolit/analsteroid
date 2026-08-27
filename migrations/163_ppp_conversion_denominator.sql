-- Migration 163: «CR ППП» — знаменатель = первичные ОТГРУЗКИ (правка владельца 25.08)
-- БД: YC analytics. Накат с ноутбука:
--   node migrations/run_local.mjs migrations/163_ppp_conversion_denominator.sql --db=analytics
--
-- Владелец, дословно: «метрика конверсия ППП должна считаться как ППП в периоде /
-- первичные отгрузки в периоде * 100%».
--
-- Было: [ppp_count] / [primary_sales_count] * 100 — делили на первичные ПРОДАЖИ.
-- Стало: [ppp_count] / [primary_shipments_count] * 100 — первичные отгрузки
-- (по воронке, funnel_type=primary — та же привычная база, что выбрана владельцем
-- в задаче 160 для «Доли повторных», и ТОТ ЖЕ знаменатель, что у соседней CR ППО:
-- [ppo_count] / [primary_shipments_count] — теперь пара метрик симметрична).
--
-- Смысл: какая доля первично отгруженных клиентов совершает вторую покупку.
-- Числитель ppp_count — по истории клиента (contact_id, rn=2 по sold_at),
-- scope_independent; смешение баз числителя и знаменателя было и раньше — это
-- осознанная конструкция всех CR ПП*-метрик.

UPDATE metrics SET
  formula = '[ppp_count] / [primary_shipments_count] * 100',
  dependencies = ARRAY['ppp_count', 'primary_shipments_count'],
  description = 'Конверсия в повторную продажу: ППП периода (вторая продажа клиента по истории, contact_id) / первичные отгрузки периода (по воронке) × 100. До 25.08.2026 знаменателем были первичные ПРОДАЖИ (миграция 163).'
WHERE id = 'ppp_conversion';

-- Проверка:
--   SELECT formula FROM metrics WHERE id = 'ppp_conversion';
--   → [ppp_count] / [primary_shipments_count] * 100
