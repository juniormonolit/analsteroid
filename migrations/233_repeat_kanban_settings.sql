-- 233: «Канбан повторных продаж» — настройки и шаблоны сообщений к задаче (владелец 21.10:
-- «РОП ставит задачу с комментарием — пусть текст собирается из шаблона с подстановкой
-- данных заказчика»; панель «Настройки» доски, только админам).
-- БД: system. Идемпотентна. Владелец таблиц — роль приложения (урок миграции 230).
--
-- repeat_kanban_settings — ключ → значение (jsonb). Сейчас один ключ:
--   manager_task_limit — норма активных задач на менеджера (число, по умолчанию 10).
-- Нет строки — движок берёт дефолт (features/repeat-kanban/engine/settings.ts).
--
-- repeat_kanban_templates — шаблоны текста задачи. Плейсхолдеры {{ключ}} (client, manager,
-- last_purchase, recommended, days_since, shipments, ltv, window_until) подставляет
-- renderTemplate. Ровно один шаблон «по умолчанию» — частичный уникальный индекс.
--
-- Откат: DROP TABLE repeat_kanban_templates, repeat_kanban_settings;

CREATE TABLE IF NOT EXISTS repeat_kanban_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS repeat_kanban_templates (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  body        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE UNIQUE INDEX IF NOT EXISTS repeat_kanban_templates_one_default_idx
  ON repeat_kanban_templates (is_default) WHERE is_default;

-- Стартовый шаблон — только если шаблонов ещё нет (повторный прогон не плодит копий).
INSERT INTO repeat_kanban_templates (name, body, is_default, sort, created_by, updated_by)
SELECT 'Повторная продажа — стандарт',
       'Заказчик брал {{last_purchase}}. Скорее всего, сейчас ему нужны {{recommended}} — позвони и предложи. '
       || 'Работай по скрипту повторных продаж: уточни про другие объекты и потребность в целом.',
       true, 0, 'migration-233', 'migration-233'
 WHERE NOT EXISTS (SELECT 1 FROM repeat_kanban_templates);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'JanCloude') THEN
    ALTER TABLE repeat_kanban_settings OWNER TO "JanCloude";
    ALTER TABLE repeat_kanban_templates OWNER TO "JanCloude";
    ALTER SEQUENCE repeat_kanban_templates_id_seq OWNER TO "JanCloude";
  END IF;
END $$;
