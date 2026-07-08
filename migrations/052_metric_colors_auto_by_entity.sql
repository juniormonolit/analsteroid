-- Задача 6а (п.10 согласованной спеки owners-inbox/analsteroid-edits-spec-agreed-20260708.md):
-- автоцвета метрик по сущности + палитра Google Sheets.
--
-- Архитектурное решение: автоцвет ПЕРЕЕХАЛ В КОД (lib/metrics/entity-colors.ts).
-- metric_colors теперь хранит ТОЛЬКО настоящие ручные переопределения из
-- /settings/metric-colors, а не дефолты.
--
-- Миграция 043 засеяла в metric_colors 4 строки category-дефолтов (Продажи/
-- Отгрузки/Брони/Отказы) и per-metric строки для «подтв.» броней (#22d3ee) —
-- это были ДЕФОЛТЫ, а не осознанный ручной выбор пользователя через UI.
-- Раз приоритет цвета — «ручное > автоцвет > серый» (см. catalog.ts loadMetrics),
-- эти старые строки молча ПЕРЕКРОЮТ новый автоцвет по сущности (в частности,
-- старый #22d3ee для «подтв.» брони не совпадает с новым градиентом
-- голубой→светло-синий→синий, где «подтв.» = #60a5fa).
--
-- Эта миграция удаляет РОВНО те строки, что завела 043 (сравнение по точному
-- значению цвета) — идемпотентно, не трогает никакие другие ручные
-- переопределения, которые пользователь мог добавить после 043 через UI.
--
-- ВАЖНО: к проду НЕ применена (по инструкции задачи). Применять ВМЕСТЕ с
-- деплоем кода этой задачи — иначе на проде останутся старые дефолты и
-- «подтв. брони» будет цвета #22d3ee вместо нового #60a5fa, пока миграция
-- не накатится.

DELETE FROM metric_colors
WHERE scope = 'category' AND key = 'Продажи'  AND color = '#3b82f6';

DELETE FROM metric_colors
WHERE scope = 'category' AND key = 'Отгрузки' AND color = '#22c55e';

DELETE FROM metric_colors
WHERE scope = 'category' AND key = 'Брони'    AND color = '#93c5fd';

DELETE FROM metric_colors
WHERE scope = 'category' AND key = 'Отказы'   AND color = '#ef4444';

DELETE FROM metric_colors
WHERE scope = 'metric' AND color = '#22d3ee'
  AND key IN (SELECT id FROM metrics WHERE name_ru ILIKE '%подтв%');
