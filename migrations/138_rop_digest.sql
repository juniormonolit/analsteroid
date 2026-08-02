-- 138: Дайджест «Аналитика» РОПу — агрегированный по отделу (задача 2769,
-- продолжение 2765). Владелец (Серёга) 02.08 на приёмке 2765 явно отложил эту
-- часть отдельной задачей — см. WORKLOG 2026-08-02 «Не сделано в этом заходе».
--
-- Переиспользует ВСЮ инфраструктуру 2765 (bot_settings.dry_run_managers,
-- sendManagerBotMessage, bot_outbound_log/decision_trace, bot_feedback,
-- digest_settings.{daily,weekly}_{enabled,hour}/max_reminders — те же общие
-- часы отправки и лимит напоминаний, что у менеджеров, отдельных колонок для
-- РОПа не заводим). НЕ трогает advice_log/manager_bot_prefs — у РОПа СВОИ
-- таблицы, потому что домен подсказки другой (не «клиент», а «конверсия по
-- товарной группе» / «непрозвоненные брони отдела» / «крупный заказчик
-- отдела»), общего конкретного client_key для двух из трёх типов нет.
--
-- «Отдел РОПа» = прямые подчинённые по sa.org_resolved_hierarchy.rop_bitrix_
-- user_id (тот же столбец, что уже используют эскалации «Контроля звонков»,
-- lib/org/callControlScope.ts). Эмпирически проверено на живых данных
-- (задача 2769): ВСЕ служебные узлы оргструктуры — личные intake-аккаунты
-- глав отделов («Департамент ОС»/«Департамент НЦ»/…), «Общие (штат)»
-- (деактивированные Caller-аккаунты), «Дирекция», HR/стажёры/роботы — имеют
-- rop_bitrix_user_id = NULL (сами никому не подчинены как «менеджер»), поэтому
-- фильтр `WHERE rop_bitrix_user_id = $ropId` их исключает БЕЗ явного
-- денай-листа (см. отчёт задачи 2769 — точные SQL/выборка). Это же исключает
-- их и из пула «других отделов»/«лучшего отдела» для бенчмарка (группировка
-- по rop_bitrix_user_id, а не по department_id/branch).
--
-- rop_bot_prefs — личные настройки подписки РОПа (owner: «настройки подписки
-- у РОПа свои»), по образцу manager_bot_prefs (135): отсутствие строки = всё
-- включено. show_numbers/show_hints — состав (гамбургер цифр / управленческие
-- подсказки), а не «по заказчикам/по цифрам», как у менеджера — разный набор
-- секций дайджеста.
--
-- rop_advice_log — журнал управленческих подсказок РОПу, ТРИ типа
-- (hint_type), у каждого свой смысл target_key/target_label и свой критерий
-- «успеха» (см. lib/jobs/ropAdviceFeedback.ts):
--   conversion_drop    — target_key = product_group_id (или head-группа),
--                        успех = CR группы отросла обратно;
--   unphoned_bookings  — target_key = 'dept' (синглтон на РОПа: одна открытая
--                        подсказка сразу за все непрозвоненные брони отдела),
--                        успех = непрозвоненных не осталось;
--   stale_customer     — target_key = client_key ('c<id>'|'k<id>', тот же
--                        формат, что advice_log), успех = звонок/продажа
--                        по клиенту (переиспользует hasSaleSince/
--                        firstCallSince из adviceFeedback.ts — сам факт от
--                        получателя не зависит).
-- Статусы/переходы — 1-в-1 та же семантика, что advice_log (134): active →
-- contacted (только для stale_customer, где «контакт» детектируем) → success
-- / closed_no_contact / closed_no_deal, up to digest_settings.max_reminders
-- напоминаний, никогда не разглашаем, КТО из менеджеров отдела не позвонил —
-- РОПу шлётся факт по отделу/группе/клиенту, не оценка менеджера ботом.
--
-- DOWN:
--   DROP TABLE IF EXISTS rop_advice_log;
--   DROP TABLE IF EXISTS rop_bot_prefs;

CREATE TABLE IF NOT EXISTS rop_bot_prefs (
  bitrix_id      integer PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT true,  -- главный тумблер «получать сообщения от Аналитика»
  daily_digest   boolean NOT NULL DEFAULT true,
  weekly_digest  boolean NOT NULL DEFAULT true,
  show_numbers   boolean NOT NULL DEFAULT true,   -- гамбургер цифр/трендов отдела
  show_hints     boolean NOT NULL DEFAULT true,   -- управленческие подсказки (конверсия/брони/заказчики)
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rop_advice_log (
  id               bigserial PRIMARY KEY,
  rop_bitrix_id    integer NOT NULL,
  hint_type        text NOT NULL CHECK (hint_type IN ('conversion_drop', 'unphoned_bookings', 'stale_customer')),
  target_key       text NOT NULL,                 -- product_group_id | 'dept' | client_key — смысл зависит от hint_type
  target_label     text NOT NULL,                 -- человекочитаемая метка на момент выдачи (группа/«отдел»/имя заказчика)
  digest_kind      text NOT NULL CHECK (digest_kind IN ('daily', 'weekly')),
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'contacted', 'success', 'closed_no_contact', 'closed_no_deal')),
  reminder_count   integer NOT NULL DEFAULT 0,
  advised_at       timestamptz NOT NULL DEFAULT now(),
  last_nudge_at    timestamptz,
  contacted_at     timestamptz,
  resolved_at      timestamptz,
  resolved_reason  text,
  next_eligible_at timestamptz,                   -- когда снова можно предложить ЭТУ пару (rop, hint_type, target_key)
  test_run         boolean NOT NULL DEFAULT false, -- ручные тестовые прогоны (app/api/admin/rop-digest-test) — не в статистике
  decision_trace   jsonb
);

CREATE INDEX IF NOT EXISTS rop_advice_log_open_idx ON rop_advice_log (status) WHERE status IN ('active', 'contacted');
CREATE INDEX IF NOT EXISTS rop_advice_log_pair_idx ON rop_advice_log (rop_bitrix_id, hint_type, target_key, advised_at DESC);
