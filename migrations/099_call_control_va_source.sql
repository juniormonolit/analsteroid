-- Миграция 099: бот «Контроль звонков» — переход на источник va.calls (решение
-- Иосифа 13.07 после сверки: va.calls пишет те же звонки, что и вебхук, но ТОЛЬКО
-- связанные со сделкой (n8n резолвит сразу), p50-лаг ~0 мин / p90 ~11 мин.
-- Курсор синка va.calls → call_events. БД: YC system (+ junibaseone для dev-стенда).
-- Идемпотентна.
ALTER TABLE call_control_settings
  ADD COLUMN IF NOT EXISTS va_sync_cursor timestamptz;
