-- Миграция 100: бот «Контроль звонков» — ручное назначение получателей эскалации
-- по отделам В ОБХОД оргструктуры (задача Иосифа, 14.07). Если для (отдел, роль)
-- есть строка — движок шлёт ей, иначе — по org_resolved_hierarchy («автоматически»).
-- department_id = org_resolved_hierarchy.department_id (uuid). БЕЗ FK: орг-таблицы
-- пересобираются ночным синком, жёсткая ссылка сломала бы его.
-- БД: YC system (+ junibaseone для dev-стенда). Идемпотентна.
CREATE TABLE IF NOT EXISTS call_control_recipient_overrides (
  department_id   uuid NOT NULL,
  role            text NOT NULL CHECK (role IN ('rop', 'department_director')),
  bitrix_user_id  text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, role)
);
