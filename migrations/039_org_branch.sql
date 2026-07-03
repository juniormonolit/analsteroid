-- Филиал сотрудника в оргструктуре. Правила (по убыванию приоритета):
-- 1) очевидно из названия отдела (МСК/КРД/СПб/ЕКБ-маркеры);
-- 2) по номеру логина: 3+ значные — первая цифра: 1→СПб, 2→Москва, 3→Краснодар, 4→Екатеринбург;
--    короткие (1-2 цифры) — старые питерские логины → СПб.
-- Код дублирует это правило фолбэком (lib/marketing/sources.ts) — новые сотрудники
-- из синка оргструктуры получают филиал даже при NULL в колонке.
-- БД: YC system (run_system.mjs).

ALTER TABLE org_resolved_hierarchy ADD COLUMN IF NOT EXISTS branch text;

-- 1) По структуре
UPDATE org_resolved_hierarchy SET branch = CASE
  WHEN department_name ~* 'МСК|Московск|^мск_' THEN 'Москва/МО'
  WHEN department_name ~* 'КРД|Краснодар|^крд_' THEN 'Краснодар'
  WHEN department_name ~* 'Екатеринбург|ЕКБ' THEN 'Екатеринбург'
  WHEN department_name ~* 'Санкт-Петербург|СПб' THEN 'СПб'
END
WHERE department_name IS NOT NULL;

-- 2) По логину (там, где структура не дала ответа)
UPDATE org_resolved_hierarchy SET branch = (
  CASE
    WHEN length(regexp_replace(COALESCE(short_login, ''), '\D', '', 'g')) BETWEEN 1 AND 2 THEN 'СПб'
    WHEN regexp_replace(short_login, '\D', '', 'g') LIKE '1%' THEN 'СПб'
    WHEN regexp_replace(short_login, '\D', '', 'g') LIKE '2%' THEN 'Москва/МО'
    WHEN regexp_replace(short_login, '\D', '', 'g') LIKE '3%' THEN 'Краснодар'
    WHEN regexp_replace(short_login, '\D', '', 'g') LIKE '4%' THEN 'Екатеринбург'
    ELSE 'СПб'
  END
)
WHERE branch IS NULL AND short_login IS NOT NULL;
