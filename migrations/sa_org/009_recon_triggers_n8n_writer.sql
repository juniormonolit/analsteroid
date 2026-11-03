-- 009: сверка сделок (fey) и права n8n_writer после переезда sa в monolitika (03.11.2026).
--
-- 1) Дневная сверка на время вставки выключает триггеры sa.deals, чтобы не трогать
--    event-timestamps и не дёргать ТВ. ALTER TABLE … DISABLE TRIGGER — право владельца
--    таблицы (monolitik), у n8n_writer его нет. Отдаём ровно это действие через
--    SECURITY DEFINER-функцию: только три известных триггера sa.deals, только вкл/выкл.
--    search_path зафиксирован — функция с правами владельца не должна резолвить имена
--    через путь вызывающего. Возвращает фактическое состояние триггеров после вызова.
--    Если сверка упадёт между выкл и вкл, триггеры останутся выключенными — сверка
--    обязана звать recon_set_triggers(true) в finally.
--
-- 2) Default privileges (WORKLOG 03.11) дали n8n_writer запись во все таблицы sa, включая
--    наши: модуль клиента, manual_fixes, employee_registry. Сессии n8n туда писать не нужно
--    (их ответ 03.11: «хватит чтения») — оставляем SELECT.
--
-- Накатка: под владельцем БД monolitik (миграции sa_org теперь в YC monolitika, не в Supabase).
-- Идемпотентна. Откат: DROP FUNCTION sa.recon_set_triggers(boolean); GRANT INSERT, UPDATE … TO n8n_writer.

CREATE OR REPLACE FUNCTION sa.recon_set_triggers(enabled boolean)
RETURNS TABLE (trigger_name text, is_enabled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, sa
AS $$
DECLARE
  t text;
BEGIN
  IF enabled IS NULL THEN
    RAISE EXCEPTION 'recon_set_triggers: enabled не может быть NULL';
  END IF;
  FOREACH t IN ARRAY ARRAY['trg_deals_set_event_timestamps_ins', 'trg_deals_set_event_timestamps_upd', 'trg_deals_notify_tv'] LOOP
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'sa.deals'::regclass AND tgname = t AND NOT tgisinternal) THEN
      EXECUTE format('ALTER TABLE sa.deals %s TRIGGER %I', CASE WHEN enabled THEN 'ENABLE' ELSE 'DISABLE' END, t);
    END IF;
  END LOOP;
  RETURN QUERY
    SELECT tg.tgname::text, tg.tgenabled <> 'D'
      FROM pg_trigger tg
     WHERE tg.tgrelid = 'sa.deals'::regclass AND NOT tg.tgisinternal
     ORDER BY 1;
END $$;

REVOKE ALL ON FUNCTION sa.recon_set_triggers(boolean) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_writer') THEN
    GRANT EXECUTE ON FUNCTION sa.recon_set_triggers(boolean) TO n8n_writer;
    REVOKE INSERT, UPDATE, DELETE ON
      sa.client_module_profiles, sa.client_module_objects, sa.client_module_deal_objects,
      sa.client_module_settings, sa.client_module_dismissed, sa.manual_fixes, sa.employee_registry
    FROM n8n_writer;
    GRANT SELECT ON
      sa.client_module_profiles, sa.client_module_objects, sa.client_module_deal_objects,
      sa.client_module_settings, sa.client_module_dismissed, sa.manual_fixes, sa.employee_registry
    TO n8n_writer;
  END IF;
END $$;
