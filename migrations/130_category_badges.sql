-- 130: Определения+цены трёх наград за категории клиентов (ок Серёги 01.08).
-- Определения вставляются и здесь (badge_prices имеет FK на badge_definitions,
-- а сид из catalog.ts случится только при первом пересчёте) — те же значения,
-- что в catalog.ts, ON CONFLICT DO NOTHING.
--
-- DOWN:
--   DELETE FROM badge_prices WHERE badge_key IN ('category_keymaker','category_upgrade','category_keykeeper');
--   DELETE FROM badge_definitions WHERE key IN ('category_keymaker','category_upgrade','category_keykeeper');

INSERT INTO badge_definitions (key, name, description, icon, category, tiered, criteria, sort_order) VALUES
  ('category_keymaker', 'Кит-мейкер', 'Клиент впервые стал «Ключевым» (отгрузок и сумма выше порогов категории) — и порог пробила ваша сделка. Редкая.', '🔑', 'rare', false, '{}'::jsonb, 33),
  ('category_upgrade', 'Апгрейд', 'Клиент впервые достиг категории «Крупный» по вашим сделкам (пороги — Настройки → Категории клиентов).', '🚀', 'milestone', false, '{}'::jsonb, 94),
  ('category_keykeeper', 'Хранитель ключей', 'За календарный месяц ни один ваш ключевой клиент не был «под угрозой» (и ключевые клиенты были). Ежемесячная.', '🗝️', 'streak', false, '{}'::jsonb, 87)
ON CONFLICT (key) DO NOTHING;

INSERT INTO badge_prices (badge_key, tier, price) VALUES
  ('category_keykeeper', '-', 60),
  ('category_upgrade', '-', 40),
  ('category_keymaker', '-', 150)
ON CONFLICT (badge_key, tier) DO NOTHING;
