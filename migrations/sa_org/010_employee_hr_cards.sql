-- 010: кадровые карточки из смарт-процесса Битрикса «СОТРУДНИКИ МОНОЛИТ» (entityTypeId 1054)
--      + периоды «логин → человек» (таймлайн раздела «Сотрудники», sa.employee_tenures).
--
-- Зачем: стаж до сих пор жил только на ручной дате (sa.employee_registry.manual_start_date).
-- Ночной импорт (lib/org/hrCards.ts, вызывается из /api/admin/org-sync после оргструктуры)
-- кладёт сюда по строке на карточку и сопоставляет её с логином Битрикса по ФИО.
-- Стаж = COALESCE(manual_start_date, hired_date активной однозначно сопоставленной карточки).
--
-- Что НЕ импортируем сознательно: дата рождения, паспорт/СНИЛС/ИНН/резюме/договор (файлы),
-- «Информация с найма», выходное интервью, IQ — персональные данные, приложению не нужны.
--
-- hired_date: в 1054 нет поля «дата найма»; «Дата начала» (begindate) у всех карточек =
-- дата создания карточки. Процесс заведён 09.12.2024 и в этот день загружено ~140 карточек
-- разом — для них дата не означает найм, hired_date = NULL (стаж дозаполняют руками).
-- Для остальных создание карточки ≈ найм.
--
-- Накатка: под владельцем БД monolitik (YC monolitika). Роль приложения на проде — JanCloude.
-- Идемпотентна. Откат: DROP TABLE IF EXISTS sa.employee_tenures, sa.employee_hr_cards;

CREATE TABLE IF NOT EXISTS sa.employee_hr_cards (
  item_id       integer PRIMARY KEY,              -- id элемента смарт-процесса 1054
  title         text NOT NULL,                    -- ФИО как в карточке
  stage_id      text NOT NULL,                    -- DT1054_9:…
  stage_name    text,
  is_employed   boolean NOT NULL,                 -- стадия не «Уволен»/«Уволился»
  card_created  date NOT NULL,                    -- begindate (= дата создания карточки)
  hired_date    date,                             -- card_created, кроме массовой загрузки 09.12.2024
  fired_date    date,                             -- movedTime для уволенных (точно с 27.07.2026, раньше — дата последнего движения)
  position      text,                             -- «Должность в компании»
  department    text,                             -- «Отдел»
  division      text,                             -- «Департамент»
  city          text,                             -- «Город»
  bitrix_id     integer,                          -- сопоставленный пользователь Битрикса (NULL — не нашли / неоднозначно)
  match_status  text NOT NULL,                    -- 'unique' | 'ambiguous' | 'none'
  synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_hr_cards_bitrix_idx ON sa.employee_hr_cards (bitrix_id);

COMMENT ON TABLE sa.employee_hr_cards IS
  'Кадровые карточки из смарт-процесса Битрикса 1054 «СОТРУДНИКИ МОНОЛИТ» (analsteroid, lib/org/hrCards.ts). Без ПДн. Пишет ночной org-sync.';

GRANT USAGE ON SCHEMA sa TO "JanCloude";
GRANT SELECT, INSERT, UPDATE, DELETE ON sa.employee_hr_cards TO "JanCloude";

-- ---------------------------------------------------------------------------
-- Периоды «логин → человек» (решение владельца 18.11): на одном логине Битрикса люди
-- меняются (слот-модель). Каждая строка — кто сидел на логине с–по. Источник правды
-- для стажа (дата начала открытого периода) и таймлайна раздела «Сотрудники».
-- Ведёт lib/org/tenures.ts: первый запуск фиксирует всех действующих (snapshot) и
-- прошлые имена из sa.employee_name_history; ночной org-sync закрывает период при
-- смене имени на логине и открывает новый; остальное правят руками (право
-- section.employees_edit), в т.ч. привязывают уволенных из карточек 1054.
-- end_date IS NULL = человек сейчас на логине; такой период на логине один.

CREATE TABLE IF NOT EXISTS sa.employee_tenures (
  id           serial PRIMARY KEY,
  bitrix_id    integer NOT NULL,                  -- логин Битрикса (слот)
  person_name  text NOT NULL,                     -- ФИО (правится руками)
  bx_name      text,                              -- имя на логине в Битриксе при открытии периода: смена имени
                                                  -- ловится по нему, а не по person_name (ручная правка ФИО ≠ новый человек)
  start_date   date,                              -- NULL = неизвестна
  end_date     date,                              -- NULL = сейчас на логине
  position     text,
  hr_item_id   integer,                           -- привязанная карточка 1054
  source       text NOT NULL,                     -- 'snapshot' | 'rename' | 'manual' | 'hr_card'
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_tenures_dates_chk CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS employee_tenures_bitrix_idx ON sa.employee_tenures (bitrix_id);
CREATE UNIQUE INDEX IF NOT EXISTS employee_tenures_open_uq ON sa.employee_tenures (bitrix_id) WHERE end_date IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS employee_tenures_hr_item_uq ON sa.employee_tenures (hr_item_id) WHERE hr_item_id IS NOT NULL;

COMMENT ON TABLE sa.employee_tenures IS
  'Периоды «логин Битрикса → человек» (analsteroid, lib/org/tenures.ts): таймлайн «Сотрудники» и база стажа.';

GRANT SELECT, INSERT, UPDATE, DELETE ON sa.employee_tenures TO "JanCloude";
GRANT USAGE, SELECT ON SEQUENCE sa.employee_tenures_id_seq TO "JanCloude";
