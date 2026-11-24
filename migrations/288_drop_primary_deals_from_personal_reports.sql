-- 288: из ежедневного ЛИЧНОГО отчёта менеджера убрать строку «Перв. сделки»
-- (метрика primary_deals_count, «Кол-во сделок (перв.)») — у всех и навсегда
-- (задача владельца 24.11).
--
-- Откуда строка: бот «Аналитик» рассылает сохранённые шаблоны «Моего отчёта»
-- (report_schedules → report_templates.state.metricIds, раннер lib/jobs/reportSchedules.ts).
-- Список строк отчёта = state.metricIds, поэтому чистим его в шаблонах. Новые личные
-- шаблоны метрику не получат: она убрана из пресета «Личный отчёт»
-- (MANAGER_METRICS в lib/reports-builder/presets.ts).
--
-- Охват: только ЛИЧНЫЕ шаблоны — все сущности kind = 'self'. Отчёты по отделам и
-- филиалам (РОПы, «МОСКВА» и т.п.) не трогаем: там «Перв. сделки» — часть набора
-- руководителя. Саму метрику из каталога не удаляем — она живёт в других отчётах.
-- Подпись-псевдоним метрики (state.metricAliases.primary_deals_count) убираем
-- вместе с ней. Шаблон, где эта метрика единственная, не трогаем: пустой metricIds
-- parseTemplateState считает битым, и рассылка упала бы.
--
-- БД: monolitika (systemDb). Накат — под monolitik. Идемпотентна: повторный прогон
-- ничего не находит (условие `metricIds ? 'primary_deals_count'`). На прод — только владелец.
-- Откат: вернуть метрику руками в нужные шаблоны (исходный порядок не сохраняется).

UPDATE report_templates t
   SET state = jsonb_set(
                 t.state,
                 '{metricIds}',
                 (SELECT jsonb_agg(m ORDER BY ord)
                    FROM jsonb_array_elements(t.state->'metricIds') WITH ORDINALITY AS a(m, ord)
                   WHERE m <> '"primary_deals_count"'::jsonb)
               )
               #- '{metricAliases,primary_deals_count}',
       updated_at = now()
 WHERE jsonb_typeof(t.state->'metricIds') = 'array'
   AND t.state->'metricIds' ? 'primary_deals_count'
   AND jsonb_array_length(t.state->'metricIds') > 1
   AND jsonb_typeof(t.state->'entities') = 'array'
   AND jsonb_array_length(t.state->'entities') > 0
   AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(t.state->'entities') e
          WHERE e->>'kind' IS DISTINCT FROM 'self'
       );
