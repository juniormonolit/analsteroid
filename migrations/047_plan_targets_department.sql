-- Годовые планы по под-отделам (бизнес-категориям продаж) внутри филиала — для
-- раскрытия карточки филиала в «Сводной» (features/summary/ui/SummaryPage.tsx).
-- Цифры взяты из /decomposition (features/decomposition/data.ts), но факт по этим
-- категориям считается по реальным Bitrix-отделам, а не 1:1 по дереву decomposition —
-- см. lib/jobs/planSummary.ts (ANCESTOR_ANCHORS/EXACT_ANCHORS). Решения владельца:
--   - МСК «НЦ Металл» слит в «НЦ» (нет отдельного отдела — уже отражено в 046);
--   - СПб «НЦ ЖБИ-рег» слит в «НЦ ЖБИ» (нет отдельного отдела, только продуктовый
--     ярлык без своих сотрудников: 331 215 849 + 115 499 993 = 446 715 842);
--   - КРД «НЦ ЖБИ» показывается как «НЦ» (реальный отдел — просто «КРД НЦ»);
--   - СПб «Департамент ЮЛ»/«Звезды Монолита» (1 чел.) и голый «Отдел продаж» без
--     подотдела (2 чел.) — посчитаны в «ОС».
-- scope_name = '<филиал>:<категория>' (филиал — те же метки, что и у scope='branch').
-- БД: YC system.
INSERT INTO plan_targets_year (year, scope, scope_name, target_amount) VALUES
  (2026, 'department', 'СПБ:ОС',        1361406538),
  (2026, 'department', 'СПБ:НЦ',         331790524),
  (2026, 'department', 'СПБ:НЦ ЖБИ',     446715842),
  (2026, 'department', 'СПБ:НЦ Металл',  180606747),
  (2026, 'department', 'МСК:ОС',         534195526),
  (2026, 'department', 'МСК:НЦ',         167450000),
  (2026, 'department', 'МСК:ЖБИ',        218700000),
  (2026, 'department', 'КРД:ОС',         142200000),
  (2026, 'department', 'КРД:НЦ',          76000000)
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS plan_targets_year_department_uq
  ON plan_targets_year (year, scope_name) WHERE scope = 'department';
