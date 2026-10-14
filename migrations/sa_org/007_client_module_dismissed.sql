-- Модуль «Карточка клиента»: «Не предлагать» у рекомендации (аудит 14.10, Fable:
-- обратная связь, чтобы карточка не повторяла неуместное). АНАЛИТИЧЕСКАЯ БД sa.
--
-- ПРИМЕНЯЕТСЯ СУПЕР-ЮЗЕРОМ ВРУЧНУЮ:
--   docker exec -i supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -1 < migrations/sa_org/007_client_module_dismissed.sql
-- До наката кнопка «Не предлагать» в карточке недоступна (виджет пишет об этом).
--
-- Строка = «эту товарную группу этому клиенту не предлагать»:
--   object_key = ''  — на уровне клиента (и всех его объектов);
--   object_key = '…' — только на этом объекте.
-- Снять скрытие — active = false (DELETE у приложения нет, история сохраняется).
--
-- DOWN: DROP TABLE IF EXISTS sa.client_module_dismissed;

CREATE TABLE IF NOT EXISTS sa.client_module_dismissed (
  client_ref  text NOT NULL,                 -- 'c<contact_id>' | 'k<company_id>'
  object_key  text NOT NULL DEFAULT '',      -- '' — весь клиент
  group_name  text NOT NULL,                 -- товарная группа (head_group_name)
  active      boolean NOT NULL DEFAULT true,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_ref, object_key, group_name)
);

COMMENT ON TABLE sa.client_module_dismissed IS
  'Модуль «Карточка клиента» (analsteroid, 14.10): рекомендации «не предлагать» по клиенту/объекту.';

GRANT USAGE ON SCHEMA sa TO junior_user;
GRANT SELECT, INSERT, UPDATE ON sa.client_module_dismissed TO junior_user;
REVOKE DELETE ON sa.client_module_dismissed FROM junior_user;
