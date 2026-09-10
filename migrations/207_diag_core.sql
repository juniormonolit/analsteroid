-- 207: движок диагностики «Аналитик» (ТЗ №1) — ядро схемы. БД: system.
-- Решения владельца 10.09 — ai_docs/fresh_docs/DIAGNOSTICS_DECISIONS.md. Дерево — ДАННЫЕ
-- (diag_nodes/diag_edges), не код; движок — features/diag/engine/*. Всё идемпотентно.

-- ── Настройки с описаниями (владелец: «все настраиваемые, с подробными описаниями») ──
CREATE TABLE IF NOT EXISTS diag_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  title       text NOT NULL,
  description text NOT NULL,
  group_name  text NOT NULL DEFAULT 'Общее',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
INSERT INTO diag_settings (key, value, title, description, group_name) VALUES
 ('window_closed', '60', 'Окно: закрытых сделок', 'Сколько последних закрытых сделок менеджера (продано / отказ / зомби) входит в тиковое окно, по которому считаются конверсии и поведенческие метрики. По данным 10.09: 60 набирается за месяц у половины активных менеджеров, точность конверсии ±7,6 п.п. Больше — точнее, но медленнее реагирует.', 'Окна и тики'),
 ('tick_size', '10', 'Тик: закрытых сделок', 'Каждые N закрытых сделок менеджера — событие «тик»: пересчитать все тиковые узлы. Соседние окна пересекаются, поэтому сравнивать соседние тики запрещено — сравнение только с базой или с окном на ≥ window/tick тиков назад.', 'Окна и тики'),
 ('min_closed', '30', 'Минимум закрытых для диагноза', 'Если в окне меньше N закрытых сделок — узел получает статус insufficient_data: диагнозы не ставятся, менеджер виден только РОПу (сравнение с пирами). Ниже 30 интервал конверсии шире ±10 п.п. — это шум.', 'Окна и тики'),
 ('zombie_quantile', '0.9', 'Зомби: квантиль времени до движения', 'Сделка без брони считается зомби (в движке — проигранной), если висит дольше, чем P-квантиль времени «создана → первое движение (бронь/продажа)» по своей товарной группе. 0.9 = 90% сделок, которые вообще двинулись, двинулись раньше этого срока. По данным 10.09: P90 от 5 дн (ондулин) до 26 дн (кровля). Если зомби потом продаётся — запись перезаписывается фактом.', 'Зомби'),
 ('zombie_min_days', '5', 'Зомби: не раньше, дней', 'Нижняя граница порога зомби для любой группы — защита от групп с очень быстрым циклом.', 'Зомби'),
 ('zombie_max_days', '30', 'Зомби: не позже, дней', 'Верхняя граница порога зомби — даже у медленных групп (кровля) сделка без движения месяц считается зомби.', 'Зомби'),
 ('zombie_min_n', '200', 'Зомби: минимум сделок для своей кривой', 'Если у товарной группы за 6 мес меньше N закрытых сделок — берётся общая кривая («*»).', 'Зомби'),
 ('control_share_testing', '0.5', 'Контроль: доля для непроверенных рёбер', 'Доля диагнозов, которым сообщение НЕ отправляется (контрольная группа), пока ребро дерева в статусе expert/testing. 0.5 — максимальная скорость набора статистики (равные руки).', 'Контрольная группа'),
 ('control_share_confirmed', '0.2', 'Контроль: доля для подтверждённых рёбер', 'Доля контроля для рёбер со статусом confirmed — помогаем большинству, контроль только чтобы не потерять сигнал.', 'Контрольная группа'),
 ('min_arm_n', '20', 'Минимум наблюдений в руке', 'Сколько закрытых диагнозов нужно в каждой руке (treatment и control), чтобы пересчитать вес ребра. Меньше — быстрее, но больше ложных подтверждений; вес двигается шагом 0.1 и откатывается.', 'Контрольная группа'),
 ('critical_gap_share', '0.3', 'Критический разрыв плана', 'Если разрыв к плану больше этой доли плана — диагноз всегда treatment (без рандомизации): человеку надо помогать, а не измерять.', 'Контрольная группа'),
 ('ewma_lambda', '0.2', 'EWMA λ', 'Коэффициент сглаживания ряда узла (0..1). 0.2 — половина веса на ~3 последних точках. Используется для отображения тренда и для «сдвинулось ли после вмешательства».', 'Детекторы'),
 ('cusum_k_sigma', '0.5', 'CUSUM k (в σ)', 'Допуск CUSUM: отклонение от базы меньше k·σ не накапливается. Стандарт 0.5σ.', 'Детекторы'),
 ('cusum_h_sigma', '4', 'CUSUM h для менеджера (в σ)', 'Порог накопленного отклонения, при котором фиксируется drift_down. 4σ — баланс скорости и ложных тревог.', 'Детекторы'),
 ('cusum_h_sigma_group', '5', 'CUSUM h для группы/филиала/источника (в σ)', 'Строже, чем для менеджера: ложная тревога руководителю дороже. Либо пробитие 4σ два периода подряд.', 'Детекторы'),
 ('wilson_conf', '0.9', 'Доверие интервала Уилсона', 'Уровень доверия интервала для долей. Отклонение считается только если база вне интервала.', 'Детекторы'),
 ('root_silent_days', '5', 'Корень молчит первые N рабочих дней месяца', 'Прогноз выполнения плана в начале месяца — шум; диагнозы по корню не ставятся. Тиковые листья работают всегда.', 'Прогноз плана'),
 ('root_late_days', '5', 'Корень: «поздно для месяца», последние N рабочих дней', 'Диагнозы по корню помечаются too_late_for_month — сценарии меняют тон («задел на следующий месяц»).', 'Прогноз плана'),
 ('novice_days', '90', 'Новичок: стаж, дней', 'Менеджер со стажем меньше N дней (по первой сделке) — база только пиры-новички, режим onboarding.', 'Базы сравнения'),
 ('season_ref_from', '"2025-08-01"', 'Сезонность: эталон с', 'Начало эталонного периода для коэффициентов сезонности (владелец: корреляция из года в год не меняется, эталон авг-2025…авг-2026).', 'Базы сравнения'),
 ('season_ref_to', '"2026-08-31"', 'Сезонность: эталон по', 'Конец эталонного периода сезонности.', 'Базы сравнения'),
 ('calls_data_start', '"2025-01-01"', 'Звонки: данные с', 'С какой даты доверяем va.calls. По проверке 12.2б звонки с 01.2025 привязаны к сделкам на 99–100%.', 'Данные')
ON CONFLICT (key) DO NOTHING;

-- ── Дерево показателей ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS diag_nodes (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  metric_id      text,                 -- ближайшая метрика каталога (для «?» и отчётов); движок считает сам
  node_kind      text NOT NULL CHECK (node_kind IN ('result','conversion','speed','activity','quality','forecast','volume')),
  subjects       text[] NOT NULL DEFAULT '{manager}',   -- manager | company | head_group | branch | source
  window_kind    text NOT NULL CHECK (window_kind IN ('calendar','tick','cohort','snapshot')),
  controllable   text NOT NULL CHECK (controllable IN ('yes','partial','no')),
  recipient_role text,                 -- кому идёт диагноз, если не менеджеру: supply | logistics | commerce | marketing | distribution | director
  season_adjust  boolean NOT NULL DEFAULT false,
  higher_is_better boolean NOT NULL DEFAULT true,
  description    text,
  enabled        boolean NOT NULL DEFAULT true,
  sort_order     int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS diag_edges (
  id        serial PRIMARY KEY,
  parent_id text NOT NULL REFERENCES diag_nodes(id) ON DELETE CASCADE,
  child_id  text NOT NULL REFERENCES diag_nodes(id) ON DELETE CASCADE,
  edge_type text NOT NULL CHECK (edge_type IN ('mult','add','hyp')),
  lag_kind  text NOT NULL DEFAULT 'none' CHECK (lag_kind IN ('none','const','by_head_group')),
  lag_days  numeric,
  lag_transition text,                 -- для by_head_group: created_to_reserved | reserved_to_sold | sold_to_shipped | created_to_sold
  weight    numeric NOT NULL DEFAULT 1 CHECK (weight >= 0 AND weight <= 1),
  status    text NOT NULL DEFAULT 'expert' CHECK (status IN ('confirmed','expert','testing','rejected')),
  notes     text,
  UNIQUE (parent_id, child_id)
);
CREATE TABLE IF NOT EXISTS diag_edge_history (
  id         bigserial PRIMARY KEY,
  edge_id    int NOT NULL REFERENCES diag_edges(id) ON DELETE CASCADE,
  changed_at timestamptz NOT NULL DEFAULT now(),
  old_weight numeric, new_weight numeric, old_status text, new_status text,
  reason     text, calc jsonb, changed_by text
);

-- ── Справочники, пересчитываемые раз в месяц ────────────────────────────────
CREATE TABLE IF NOT EXISTS diag_lags (
  head_group_name text NOT NULL,       -- '*' — фолбэк
  transition      text NOT NULL,       -- created_to_reserved | reserved_to_sold | sold_to_shipped | created_to_sold | created_to_priced
  n int NOT NULL, p25_h numeric, p50_h numeric, p75_h numeric, p90_h numeric,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (head_group_name, transition)
);
CREATE TABLE IF NOT EXISTS diag_zombie_thresholds (
  head_group_name   text PRIMARY KEY,  -- '*' — фолбэк
  zombie_after_days int NOT NULL,
  n int NOT NULL, curve jsonb,         -- [{t, p_advance_pct, n_open}]
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS diag_season (
  entity_key text NOT NULL,            -- branch×category, напр. 'СПб|ОС'; '*' — компания
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  coef numeric NOT NULL, n_years int NOT NULL DEFAULT 1,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_key, month)
);
CREATE TABLE IF NOT EXISTS diag_loss_reasons (
  stage_id  text PRIMARY KEY,          -- stages.id (с префиксом воронки)
  funnel_id int NOT NULL,
  stage_name text NOT NULL,
  category  text NOT NULL CHECK (category IN ('not_target','supply','logistics','price','speed','market','other'))
);

-- ── Тики, ряды, диагнозы ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS diag_ticks (
  manager_id  integer NOT NULL,
  tick_no     int NOT NULL,
  closed_at   timestamptz NOT NULL,    -- момент N-го закрытия
  window_from_deal bigint, window_to_deal bigint,
  n_closed int NOT NULL, n_won int NOT NULL, n_zombie int NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (manager_id, tick_no)
);
CREATE TABLE IF NOT EXISTS diag_series (
  id            bigserial PRIMARY KEY,
  subject_type  text NOT NULL,         -- manager | company | head_group | branch | source
  subject_key   text NOT NULL,
  node_id       text NOT NULL REFERENCES diag_nodes(id) ON DELETE CASCADE,
  head_group_name text,                -- срез внутри товарной группы (уровень менеджера) или NULL
  as_of         date NOT NULL,         -- день расчёта
  tick_no       int,                   -- для tick-узлов
  value numeric, n int,
  ci_low numeric, ci_high numeric,
  ewma numeric, cusum_pos numeric, cusum_neg numeric,
  base_own numeric, base_peers numeric, base_target numeric, sigma numeric,
  status text NOT NULL CHECK (status IN ('ok','drift_down','drift_up','insufficient_data','no_plan')),
  trace jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS diag_series_uq ON diag_series (subject_type, subject_key, node_id, coalesce(head_group_name, ''), as_of);
CREATE INDEX IF NOT EXISTS diag_series_subject_idx ON diag_series (subject_type, subject_key, node_id, as_of DESC);

CREATE TABLE IF NOT EXISTS diag_diagnoses (
  id            bigserial PRIMARY KEY,
  subject_type  text NOT NULL,
  subject_key   text NOT NULL,
  node_id       text NOT NULL REFERENCES diag_nodes(id),
  lever_id      text REFERENCES diag_nodes(id),
  head_group_name text,
  gap_value     numeric,               -- разрыв в единицах узла (₽ для корня, п.п. для конверсий)
  gap_share     numeric,               -- доля разрыва корня, объяснённая этим узлом
  score         numeric,
  confidence    numeric,
  mode          text NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal','onboarding')),
  arm           text NOT NULL DEFAULT 'treatment' CHECK (arm IN ('treatment','control')),
  too_late_for_month boolean NOT NULL DEFAULT false,
  recipient_role text,                 -- NULL = сам менеджер
  recipient_bitrix_ids int[],
  suppressed_by bigint REFERENCES diag_diagnoses(id),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','queued','in_scenario','closed','disputed','suppressed')),
  outcome       text,
  trace         jsonb NOT NULL,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  run_id        bigint                 -- bot_scenario_runs.id, когда сценарий подхватил
);
CREATE INDEX IF NOT EXISTS diag_diagnoses_subject_idx ON diag_diagnoses (subject_type, subject_key, status);
CREATE INDEX IF NOT EXISTS diag_diagnoses_open_idx ON diag_diagnoses (status, opened_at DESC);

CREATE TABLE IF NOT EXISTS diag_feedback (
  id bigserial PRIMARY KEY,
  diagnosis_id bigint NOT NULL REFERENCES diag_diagnoses(id) ON DELETE CASCADE,
  author_login text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('wrong_lever','not_managers_fault','data_error','already_handled','other')),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Маршрутизация: получатели по ролям НА КАЖДЫЙ ФИЛИАЛ (владелец: настраиваемый список,
--    по умолчанию везде он — 2098) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS diag_routing (
  role   text NOT NULL CHECK (role IN ('supply','logistics','commerce','marketing','distribution','director','rop')),
  branch text NOT NULL,                -- 'СПб' | 'Москва/МО' | 'Краснодар' | '*'
  recipient_bitrix_ids int[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (role, branch)
);
INSERT INTO diag_routing (role, branch, recipient_bitrix_ids)
SELECT r, b, '{2098}'::int[] FROM unnest(ARRAY['supply','logistics','commerce','marketing','distribution','director','rop']) r
  CROSS JOIN unnest(ARRAY['СПб','Москва/МО','Краснодар','*']) b
ON CONFLICT DO NOTHING;

-- ── Причины отказа — разметка, согласованная владельцем 10.09 ────────────────
INSERT INTO diag_loss_reasons (stage_id, funnel_id, stage_name, category) VALUES
 ('6', 0, 'Передумали покупать', 'market'), ('7', 0, 'Не дозвонился, звонил 5 раз', 'speed'),
 ('9', 0, 'НЕ ТРОГАТЬ - ЗАПРЕЩЕНО (штраф 10 000 руб)', 'not_target'), ('4', 0, 'Уже заказали и оплатили', 'speed'),
 ('APOLOGY', 0, 'Дорого, заказчик взял исходный материал дешевле', 'price'), ('LOSE', 0, 'Дорого, альтернатив не существует', 'price'),
 ('5', 0, 'Нет в наличии (штраф 5 000 руб)', 'supply'), ('3', 0, 'Дорого, заказчик взял альтернативу дешевле', 'price'),
 ('8', 0, 'Была продана - но не отвезли', 'logistics'), ('10', 0, 'СТОП-ЛИСТ (не трогать)', 'not_target'),
 ('C1:7', 1, 'Сметчик-тендерщик или не взяли объект', 'not_target'), ('C1:APOLOGY', 1, 'Уже заказали и оплатили', 'speed'),
 ('C1:LOSE', 1, 'Дорого', 'price'), ('C1:6', 1, 'Не дозвонился, звонил 5 раз', 'speed'),
 ('C1:9', 1, 'НЕ ТРОГАТЬ - ЗАПРЕЩЕНО (штраф 10 000 руб)', 'not_target'), ('C1:4', 1, 'Нет в наличии (штраф 5 000 руб)', 'supply'),
 ('C1:5', 1, 'Хотят постоплату', 'not_target'), ('C1:8', 1, 'По почте не отвечают, номера нет', 'speed'), ('C1:10', 1, 'СТОП-ЛИСТ (не трогать)', 'not_target'),
 ('C2:APOLOGY', 2, 'Больше ничего не нужно', 'market'), ('C2:2', 2, 'НЕ ТРОГАТЬ - ЗАПРЕЩЕНО (штраф 10 000 руб)', 'not_target'),
 ('C2:LOSE', 2, 'Дорого, больше ничего не нужно', 'price'), ('C2:1', 2, 'Подвели клиента - не хочет работать', 'logistics'),
 ('C3:2', 3, 'Объектов больше нет', 'market'), ('C3:LOSE', 3, 'Дорого, предложил другие материалы, больше ничего не нужно', 'price'),
 ('C3:APOLOGY', 3, 'Подвели клиента - не хочет с нами работать', 'logistics'),
 ('C4:4', 4, 'Не дозвонился, звонил 5 раз', 'speed'), ('C4:APOLOGY', 4, 'Купил дешевле Россию', 'price'), ('C4:LOSE', 4, 'Купил дешевле РБ', 'price'), ('C4:5', 4, 'Маленький объем', 'not_target'),
 ('C7:6', 7, 'Не можем посчитать материал', 'supply'), ('C7:4', 7, 'Не прошли по цене', 'price'), ('C7:3', 7, 'Маленький объем', 'not_target'),
 ('C7:1', 7, 'Не выиграли конкурс', 'market'), ('C7:2', 7, 'Не прошли аккредитацию на площадке', 'other'), ('C7:LOSE', 7, 'Не успели податься', 'speed'),
 ('C7:5', 7, 'Не готовы работать по постоплате по этой заявке', 'not_target')
ON CONFLICT (stage_id) DO NOTHING;

-- ── Сид дерева v1 (ТЗ §3.2 с поправками по каталогу и решениям 10.09) ─────────
-- subjects: manager — считается на менеджера; head_group/branch/source/company — на уровнях 1–4.
INSERT INTO diag_nodes (id, name, metric_id, node_kind, subjects, window_kind, controllable, recipient_role, season_adjust, higher_is_better, description, sort_order) VALUES
 ('plan_forecast_pct_month', 'Прогноз выполнения плана отгрузок, %', NULL, 'forecast', '{manager,branch,company}', 'calendar', 'partial', NULL, false, true,
  'Корень: (факт отгрузок + продано-не-отгружено × P(отгрузится до конца месяца) + прогноз продаж на остаток × конверсия продажа→отгрузка) ÷ план. Разрыв к плану — то, что декомпозируется по дереву.', 0),
 ('shipments_forecast_month', 'Прогноз отгрузок на конец месяца, ₽', NULL, 'forecast', '{manager,branch,company}', 'calendar', 'partial', NULL, true, true, NULL, 1),
 ('plan_shipments_month', 'План отгрузок на месяц, ₽', NULL, 'result', '{manager,branch,company}', 'calendar', 'no', 'director', false, true, 'manager_plans.plan_shipments; нет плана — менеджер не диагностируется.', 2),
 ('primary_shipments_amount', 'Сумма отгрузок, первичные', 'primary_shipments_amount', 'result', '{manager,head_group,branch,company}', 'calendar', 'yes', NULL, true, true, 'Повторность — по истории клиента, не по воронке.', 10),
 ('repeat_shipments_amount', 'Сумма отгрузок, повторные', 'repeat_shipments_amount', 'result', '{manager,head_group,branch,company}', 'calendar', 'yes', NULL, true, true, NULL, 11),
 ('primary_shipments_count', 'Кол-во отгрузок, первичные', 'primary_shipments_count', 'volume', '{manager,head_group,branch,company}', 'calendar', 'yes', NULL, true, true, NULL, 20),
 ('primary_shipments_avg_amount', 'Средний чек отгрузки, первичные', 'primary_shipments_avg_amount', 'result', '{manager,head_group,branch,company}', 'calendar', 'partial', NULL, false, true, NULL, 21),
 ('repeat_shipments_count', 'Кол-во отгрузок, повторные', 'repeat_shipments_count', 'volume', '{manager,head_group,branch,company}', 'calendar', 'yes', NULL, true, true, NULL, 22),
 ('repeat_shipments_avg_amount', 'Средний чек отгрузки, повторные', 'repeat_shipments_avg_amount', 'result', '{manager,head_group,branch,company}', 'calendar', 'partial', NULL, false, true, NULL, 23),
 ('primary_deals_count', 'Поток первичных сделок', 'primary_deals_count', 'volume', '{manager,head_group,branch,source,company}', 'calendar', 'no', 'distribution', true, true, 'Менеджер поток не контролирует: мало сделок у одного при нормальном потоке филиала — вопрос распределения; мало у всех — источник/маркетинг.', 30),
 ('cr_deal_to_sale', 'CR сделка → продажа (сквозная, первичные)', 'cr_deal_to_sale_all', 'conversion', '{manager,head_group,branch,source,company}', 'tick', 'yes', NULL, false, true, NULL, 31),
 ('cr_sale_to_shipment', 'CR продажа → отгрузка', 'cr_sale_to_shipment_primary', 'conversion', '{manager,head_group,branch,company}', 'calendar', 'no', 'logistics', false, true, 'Зона логистики.', 32),
 ('repeat_created_count', 'Поток повторных сделок', 'repeat_created_count', 'volume', '{manager,head_group,branch,company}', 'calendar', 'yes', NULL, true, true, 'Повторные сделки менеджер создаёт сам (работа с базой) — контролируемо.', 33),
 ('cr_deal_to_sale_repeat', 'CR сделка → продажа (повторные)', 'cr_repeat_created_to_sale', 'conversion', '{manager,head_group,branch,company}', 'tick', 'yes', NULL, false, true, NULL, 34),
 ('cr_sale_to_shipment_repeat', 'CR продажа → отгрузка (повторные)', 'cr_sale_to_shipment_repeat', 'conversion', '{manager,head_group,branch,company}', 'calendar', 'no', 'logistics', false, true, NULL, 35),
 ('cr_deal_to_priced', 'CR сделка → цена озвучена', 'cr_deal_to_price', 'conversion', '{manager,head_group,branch,source}', 'tick', 'yes', NULL, false, true, 'По deal_events: сделка дошла до стадии «озвучил цену».', 40),
 ('cr_priced_to_reservation', 'CR цена → бронь', 'cr_stage_priced_to_reservation', 'conversion', '{manager,head_group,branch,source}', 'tick', 'yes', NULL, false, true, NULL, 41),
 ('cr_reservation_to_sale', 'CR бронь → продажа', 'cr_reservation_to_sale_all', 'conversion', '{manager,head_group,branch,source}', 'tick', 'yes', NULL, false, true, 'cr_confirmed_to_sale исключён: вырожден (подтверждение и продажа — одно действие).', 42),
 -- листья: поведение менеджера
 ('calls_touch_speed_median', 'Скорость первого касания, мин (медиана)', 'calls_touch_speed_median', 'speed', '{manager,branch}', 'cohort', 'yes', NULL, false, false, NULL, 50),
 ('price_speed_median_hours', 'Скорость до цены, часов (медиана)', 'price_speed_median_hours', 'speed', '{manager,head_group,branch}', 'cohort', 'yes', NULL, false, false, 'Медленная цена у всех менеджеров по группе — вопрос снабжения (не отвечают на запросы), у одного — менеджера.', 51),
 ('calls_deals_no_call', 'Сделки без единого звонка', 'calls_deals_no_call', 'activity', '{manager}', 'tick', 'yes', NULL, false, false, NULL, 52),
 ('calls_to_reservation_avg', 'Звонков до брони, среднее', 'calls_to_reservation_avg', 'activity', '{manager}', 'tick', 'yes', NULL, false, true, 'H6: связь сильная (ρ=0.6), но возможна обратная причинность.', 53),
 ('booking_call_rate_reserved', 'Доля прозвона броней на след. день', 'booking_call_rate_reserved', 'activity', '{manager,branch}', 'tick', 'yes', NULL, false, true, 'H1 — первый рычаг к запуску.', 54),
 ('calls_silence_deals', '«Тишина»: сделки без звонков 7+ дней', 'calls_silence_deals', 'activity', '{manager}', 'snapshot', 'yes', NULL, false, false, 'H5.', 55),
 ('calls_missed_rate', 'Доля недозвонов', 'calls_missed_rate', 'activity', '{manager}', 'tick', 'yes', NULL, false, false, 'H3: знак связи обратный ожидаемому (конфаундер) — отклонён до пересчёта внутри менеджера.', 56),
 ('zombie_share', 'Доля зомби среди открытых сделок', NULL, 'quality', '{manager,branch}', 'snapshot', 'yes', NULL, false, false, 'Сделки без движения дольше порога группы (diag_zombie_thresholds). Источник ежедневного списка «добей или закрой».', 57),
 ('zombie_count', 'Зомби, шт (сейчас)', NULL, 'quality', '{manager}', 'snapshot', 'yes', NULL, false, false, NULL, 58),
 ('multi_group_order_share', 'Доля заказов с ≥2 товарными группами', NULL, 'quality', '{manager,branch}', 'tick', 'yes', NULL, false, true, 'Рычаг среднего чека (допродажа).', 60),
 ('advice_contact_rate', 'Доля подсказок «кому звонить», по которым позвонили в срок', NULL, 'activity', '{manager}', 'calendar', 'yes', NULL, false, true, 'advice_log → va.calls.', 61),
 ('advice_to_sale_rate', 'Доля подсказок, закончившихся продажей', NULL, 'quality', '{manager}', 'calendar', 'yes', NULL, false, true, NULL, 62),
 -- субъект «источник» (маркетинг): поток и качество
 ('deals_count_by_source', 'Поток сделок с источника', NULL, 'volume', '{source}', 'calendar', 'no', 'marketing', true, true, 'Сигнал 1 маркетингу: сделок с источника/канала аномально меньше базы (с поправкой на день недели и сезон).', 70),
 ('source_conversion_gap', 'Конверсия сделок источника vs остальные, п.п.', NULL, 'quality', '{source}', 'calendar', 'no', 'marketing', false, true, 'Сигнал 2 маркетингу: сделки с источника (или источник × товарная группа) у ВСЕХ менеджеров продаются хуже таких же с других источников — качество трафика, не менеджеры.', 71),
 ('lost_reason_share', 'Сдвиг долей причин отказа', NULL, 'quality', '{head_group,branch,source,company}', 'calendar', 'no', NULL, false, false, 'Прикладывается к диагнозам уровней 1–4: какая причина выросла ≥1.5× (diag_loss_reasons).', 80)
ON CONFLICT (id) DO NOTHING;

INSERT INTO diag_edges (parent_id, child_id, edge_type, lag_kind, lag_transition, weight, status, notes) VALUES
 ('plan_forecast_pct_month', 'shipments_forecast_month', 'mult', 'none', NULL, 1, 'confirmed', NULL),
 ('plan_forecast_pct_month', 'plan_shipments_month', 'mult', 'none', NULL, 1, 'confirmed', 'делитель'),
 ('shipments_forecast_month', 'primary_shipments_amount', 'add', 'none', NULL, 1, 'confirmed', NULL),
 ('shipments_forecast_month', 'repeat_shipments_amount', 'add', 'none', NULL, 1, 'confirmed', NULL),
 ('primary_shipments_amount', 'primary_shipments_count', 'mult', 'none', NULL, 1, 'confirmed', NULL),
 ('primary_shipments_amount', 'primary_shipments_avg_amount', 'mult', 'none', NULL, 1, 'confirmed', NULL),
 ('repeat_shipments_amount', 'repeat_shipments_count', 'mult', 'none', NULL, 1, 'confirmed', NULL),
 ('repeat_shipments_amount', 'repeat_shipments_avg_amount', 'mult', 'none', NULL, 1, 'confirmed', NULL),
 ('primary_shipments_count', 'primary_deals_count', 'mult', 'by_head_group', 'created_to_shipped', 1, 'confirmed', NULL),
 ('primary_shipments_count', 'cr_deal_to_sale', 'mult', 'by_head_group', 'created_to_sold', 1, 'confirmed', NULL),
 ('primary_shipments_count', 'cr_sale_to_shipment', 'mult', 'by_head_group', 'sold_to_shipped', 1, 'confirmed', NULL),
 ('repeat_shipments_count', 'repeat_created_count', 'mult', 'by_head_group', 'created_to_shipped', 1, 'confirmed', NULL),
 ('repeat_shipments_count', 'cr_deal_to_sale_repeat', 'mult', 'by_head_group', 'created_to_sold', 1, 'confirmed', NULL),
 ('repeat_shipments_count', 'cr_sale_to_shipment_repeat', 'mult', 'by_head_group', 'sold_to_shipped', 1, 'confirmed', NULL),
 ('cr_deal_to_sale', 'cr_deal_to_priced', 'mult', 'by_head_group', 'created_to_priced', 1, 'confirmed', 'произведение — приближение; при расхождении со сквозной > X% узел помечается ненадёжным'),
 ('cr_deal_to_sale', 'cr_priced_to_reservation', 'mult', 'by_head_group', 'created_to_reserved', 1, 'confirmed', NULL),
 ('cr_deal_to_sale', 'cr_reservation_to_sale', 'mult', 'by_head_group', 'reserved_to_sold', 1, 'confirmed', NULL),
 -- гипотезы (листья)
 ('cr_deal_to_priced', 'calls_touch_speed_median', 'hyp', 'none', NULL, 0.7, 'expert', 'H2'),
 ('cr_deal_to_priced', 'price_speed_median_hours', 'hyp', 'none', NULL, 0.7, 'expert', NULL),
 ('cr_deal_to_priced', 'calls_deals_no_call', 'hyp', 'none', NULL, 0.6, 'expert', NULL),
 ('cr_priced_to_reservation', 'calls_to_reservation_avg', 'hyp', 'none', NULL, 0.4, 'testing', 'H6: подозрение на обратную причинность'),
 ('cr_reservation_to_sale', 'booking_call_rate_reserved', 'hyp', 'none', NULL, 0.7, 'expert', 'H1 — первый рычаг'),
 ('cr_reservation_to_sale', 'calls_silence_deals', 'hyp', 'none', NULL, 0.5, 'expert', 'H5'),
 ('cr_deal_to_sale', 'zombie_share', 'hyp', 'none', NULL, 0.8, 'expert', 'висяк = потеря или грязь'),
 ('cr_deal_to_priced', 'calls_missed_rate', 'hyp', 'none', NULL, 0.3, 'rejected', 'H3: знак обратный'),
 ('primary_shipments_avg_amount', 'multi_group_order_share', 'hyp', 'none', NULL, 0.6, 'expert', NULL),
 ('repeat_created_count', 'advice_contact_rate', 'hyp', 'none', NULL, 0.7, 'expert', NULL),
 ('repeat_created_count', 'advice_to_sale_rate', 'hyp', 'none', NULL, 0.5, 'expert', NULL),
 ('primary_deals_count', 'deals_count_by_source', 'hyp', 'none', NULL, 0.8, 'expert', 'субъект source'),
 ('cr_deal_to_sale', 'source_conversion_gap', 'hyp', 'none', NULL, 0.6, 'expert', 'субъект source: качество трафика')
ON CONFLICT (parent_id, child_id) DO NOTHING;
