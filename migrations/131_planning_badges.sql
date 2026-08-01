-- 131: Определения+цены трёх наград пула «Планёрка» (01.08, одобрено Серёгой):
-- «Дисциплина броней» (30), «Камбэк» (75), «Досрочник» (150). Определения
-- вставляются здесь (badge_prices FK на badge_definitions, сид catalog.ts
-- случится только при первом пересчёте) — те же значения, что в catalog.ts.
--
-- DOWN:
--   DELETE FROM badge_prices WHERE badge_key IN ('planning_discipline','comeback','early_bird');
--   DELETE FROM badge_awards WHERE badge_key IN ('planning_discipline','comeback','early_bird');
--   DELETE FROM badge_definitions WHERE key IN ('planning_discipline','comeback','early_bird');

INSERT INTO badge_definitions (key, name, description, icon, category, tiered, criteria, sort_order) VALUES
  ('planning_discipline', 'Дисциплина броней', 'За календарную неделю ВСЕ ваши брони получили звонок в течение 7 дней. Еженедельная.', '📞', 'streak', false, '{}'::jsonb, 88),
  ('comeback', 'Камбэк', 'Месяц с ростом суммы продаж после месяца падения. Ежемесячная.', '📈', 'streak', false, '{}'::jsonb, 89),
  ('early_bird', 'Досрочник', 'План месяца выполнен к 20-му числу. Ежемесячная.', '🏁', 'milestone', false, '{}'::jsonb, 90)
ON CONFLICT (key) DO NOTHING;

INSERT INTO badge_prices (badge_key, tier, price) VALUES
  ('planning_discipline', '-', 30),
  ('comeback', '-', 75),
  ('early_bird', '-', 150)
ON CONFLICT (badge_key, tier) DO NOTHING;
