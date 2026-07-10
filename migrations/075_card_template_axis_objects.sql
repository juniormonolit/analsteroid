-- Шаблоны карточек v2 (задача 10.07, пакет «шаблоны + карточка v3», п.2: «оси
-- паутины из ВСЕХ метрик каталога, не 8 зашитых»). Расширяет card_templates
-- (миграция 073, СХЕМА уже накатана и содержит 2 строки — 'manager'/'department',
-- проверено живым запросом 10.07: axes хранится как ПЛОСКИЙ массив строк, напр.
-- ["cr_deal_to_reservation","cr_reservation_to_sale",...]) — колонка axes остаётся
-- JSONB (DDL не меняется), меняется только ФОРМА ДАННЫХ внутри: массив строк →
-- массив объектов {metricKey, invert}.
--
-- Зачем: раньше 8 осей были зашитым enum'ом (lib/settings/cardTemplates.ts::
-- AXIS_CATALOG_KEYS), а «меньше — лучше» было хардкожено в коде (managerCard.ts::
-- AXIS_DEFS, invert=true только у touch_speed/refusal_rate). Теперь ось — ЛЮБАЯ
-- метрика полного каталога (lib/metrics/catalog.ts::loadMetrics(), ~195 видимых),
-- а invert — настройка АДМИНА на каждой оси (UI /settings/card-templates,
-- тумблер «меньше — лучше»). metricKey исходных 8 получает префикс «legacy:» —
-- 3 из них (cr_deal_to_reservation/cr_reservation_to_sale/cr_reservation_to_confirmed)
-- СОВПАДАЮТ по id с реальными метриками каталога («Конверсии», PRIMARY-only scope),
-- но считаются в карточке ДРУГОЙ формулой (по ВСЕМ сделкам — см. managerCard.ts::
-- rawAxisValues) — без префикса это была бы неустранимая коллизия значений.
--
-- ИНВАРИАНТ (как и в 073): после наката НИ ОДНА цифра не меняется, пока админ не
-- тронет форму — invert для touch_speed/refusal_rate выставлен true (сохраняет
-- ТЕКУЩЕЕ поведение, было хардкожено в AXIS_DEFS ровно так же), остальные 6 — false
-- (тоже как было, они не были инвертированы).
--
-- Идемпотентна: WHERE-условие бьёт только строки, где axes[0] — ЕЩЁ строка (старый
-- формат); после первого наката axes[0] становится объектом, повторный запуск
-- миграции — no-op (не перезатирает уже настроенные админом оси/invert).
--
-- БД: YC system. НЕ применять локально — накатывает Артём на проде атомарно.
-- Проверено 10.07 (Николай): 075 — первый свободный номер (локально migrations/ до
-- 074 включительно заняты — 073 применена и содержит card_templates, 074 не найдена
-- ни локально, ни как схема-дрифт в живой system БД сверх ожидаемого; серверный
-- changelog Артёма вне этого репозитория не проверялся напрямую — подтвердить
-- свободность 075 на его стороне перед накатом). Dry-run (BEGIN...ROLLBACK) на
-- живой system БД 10.07: обе строки ('manager'/'department') корректно
-- переведены в {metricKey,invert}[], touch_speed/refusal_rate → invert=true,
-- остальные 4 → invert=false, повторный прогон на уже мигрированных данных — 0
-- строк задето (идемпотентность подтверждена).

UPDATE card_templates
SET axes = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'metricKey', 'legacy:' || (elem #>> '{}'),
      'invert', (elem #>> '{}') IN ('touch_speed', 'refusal_rate')
    )
  )
  FROM jsonb_array_elements(axes) AS elem
),
updated_at = NOW()
WHERE jsonb_typeof(axes) = 'array'
  AND jsonb_array_length(axes) > 0
  AND jsonb_typeof(axes -> 0) = 'string';
