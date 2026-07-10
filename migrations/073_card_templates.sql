-- Шаблоны карточек (owners-inbox бриф 10.07): «Карточка менеджера» (manager-card v1/v2
-- + ФИФА-сетка «Мой отдел», см. features/manager-card/engine/managerCard.ts::buildManagerCard
-- и teamCard.ts::buildTeamRoster — оба читают шаблон 'manager', чтобы рейтинг менеджера
-- в сетке НИКОГДА не расходился с его большой карточкой) и «Карточка отдела (РОП)»
-- (teamCard.ts::buildDepartmentCard, шаблон 'department'). Настраивается: (а) до 6 осей
-- паутины из каталога 8 (lib/settings/cardTemplates.ts::AXIS_CATALOG_KEYS — исходные 6
-- + 2 новых, посчитанные без единого нового запроса: доля подтверждения брони,
-- доля отгруженного от проданного), (б) какие из 6 плиток итогов показывать.
--
-- Singleton-по-ключу — тот же паттерн, что scoring_weights (068)/plan_settings (016).
-- Дефолт (INSERT ниже) = ТЕКУЩЕЕ поведение карточки v1/v2 (все 6 исходных осей, все
-- 6 плиток) — накат миграции НЕ меняет ни одной цифры, пока админ не тронет форму.
--
-- Гейт изменения — section.settings, БЕЗ superadmin-only (в отличие от scoring-weights/
-- daily-plan-mode) — явное решение владельца 10.07: «админ должен видеть и менять».
-- Веса скоринга при рейтинге по шаблону — из scoring_weights (068) для осей, которые
-- там есть (исходные 6); для 2 новых осей вне scoring_weights — дефолт-вес 5 (см.
-- ratingFor в managerCard.ts, комментарий у вызова).
--
-- БД: YC system. НЕ применять локально — накатывает Артём на проде атомарно.
-- Проверено 10.07 (Николай): 073 — первый свободный номер (locally migrations/ до 072
-- включительно, все git-ветки репозитория/origin проверены, в живой system БД такой
-- таблицы нет). Серверный changelog Артёма вне этого репозитория не проверялся напрямую —
-- подтвердить свободность 073 на его стороне перед накатом.
CREATE TABLE IF NOT EXISTS card_templates (
  template_key TEXT PRIMARY KEY CHECK (template_key IN ('manager', 'department')),
  axes  JSONB NOT NULL, -- массив до 6 ключей из AXIS_CATALOG_KEYS, порядок = порядок в паутине
  tiles JSONB NOT NULL, -- массив ключей из TILE_CATALOG_KEYS (какие плитки итогов показывать)
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO card_templates (template_key, axes, tiles) VALUES
  ('manager', '["cr_deal_to_reservation","cr_reservation_to_sale","sales_amount","avg_check","touch_speed","refusal_rate"]'::jsonb,
              '["reservations","confirmedReservations","salesCount","salesAmount","shipments","avgCheck"]'::jsonb),
  ('department', '["cr_deal_to_reservation","cr_reservation_to_sale","sales_amount","avg_check","touch_speed","refusal_rate"]'::jsonb,
                 '["reservations","confirmedReservations","salesCount","salesAmount","shipments","avgCheck"]'::jsonb)
ON CONFLICT (template_key) DO NOTHING;
