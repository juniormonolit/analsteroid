-- 127: Три новые ачивки по кошельку (доп. Серёги к задаче 2741, 01.08):
--   «Шопоголик» (wallet_first_purchase, 20 еб) — первая покупка в магазине,
--     любым кошельком (EBALL или RUB, source='shop_purchase').
--   «Инвестор» (wallet_big_spender, рара, 60 еб) — суммарно ПОТРАЧЕНО ≥1000
--     ебаллов (валовый расход, без вычета возвратов/призов) по источникам
--     shop_purchase + gacha_spin + quest_reroll — три «реальные траты EBALL»
--     из sink-mechanics.md §2.1-2.7; переводы (transfer_out) НЕ считаются
--     тратой в этом смысле (soft sink, деньги просто у другого сотрудника).
--   «Удачливый» (wallet_gacha_lucky, рара, 50 еб) — выпал предмет редкости
--     rare/jackpot из гачи (наша шкала — common/rare/jackpot, «эпик или выше»
--     из брифа Серёги = rare И jackpot, промежуточной ступени 'epic' в
--     gacha_pool.rarity нет — см. migrations/120_gacha.sql).
--
-- Все три — разовые (period_type/period_date = NULL, единственная строка на
-- менеджера по uq_badge_awards из 112_badges.sql); считаются в общем ночном
-- пересчёте (features/badges/engine/walletBadges.ts), ретро-начисление по уже
-- накопленным данным допустимо (фича не публична, owners-inbox правка 01.08).
-- Ядро движка (runBadgeRecompute, начисление валюты, wallet-тик) НЕ меняется —
-- добавлен только источник наград, как categoryBadges/planningBadges раньше.
--
-- СИСТЕМНАЯ БД (YC, dbname=system) — применяется вручную migrations/run_system.mjs.
-- DOWN:
--   DELETE FROM badge_definitions WHERE key IN ('wallet_first_purchase','wallet_big_spender','wallet_gacha_lucky');
--   (badge_prices удалятся каскадом по FK badge_key -> badge_definitions)

INSERT INTO badge_definitions (key, name, description, icon, category, tiered, criteria, sort_order) VALUES
  ('wallet_first_purchase', 'Шопоголик', 'Первая покупка в магазине призов — любая, любым кошельком.', '🛍️', 'milestone', false, '{"wallet":"first_purchase"}', 98),
  ('wallet_big_spender', 'Инвестор', 'Суммарно потрачено 1000 ебаллов и больше (магазин, гача, реролл квестов).', '💸', 'rare', false, '{"wallet":"big_spender","minSpent":1000}', 99),
  ('wallet_gacha_lucky', 'Удачливый', 'Выбит редкий или джекпот-предмет из гачи.', '🍀', 'rare', false, '{"wallet":"gacha_lucky","minRarity":"rare"}', 100)
ON CONFLICT (key) DO NOTHING;

INSERT INTO badge_prices (badge_key, tier, price) VALUES
  ('wallet_first_purchase', '-', 20),
  ('wallet_big_spender', '-', 60),
  ('wallet_gacha_lucky', '-', 50)
ON CONFLICT (badge_key, tier) DO NOTHING;
