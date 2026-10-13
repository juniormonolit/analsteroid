-- 228: «Канбан РОПа» — галочки «менеджер × цикл» (пилот, задача #9625, v2). БД: system.
--
-- Аналог Option::setManagerCycleRestriction модуля mlt в Битриксе: для менеджера хранится список ВЫКЛЮЧЕННЫХ
-- циклов (ONE, TWO, THREE, END, OTHER). Нет строки или пустой массив = виден во всех циклах (старт: «все циклы
-- всем»). Это единственная запись раздела «Канбан РОПа»; пишется только сюда (system), в Битрикс и sa —
-- ничего. Правит РОП/владелец пилота для менеджеров своей зоны (ropScope) — проверка в API, не в БД.
-- Идемпотентна. Откат: DROP TABLE rop_manager_cycles; (данных на момент пилота нет ценных).
CREATE TABLE IF NOT EXISTS rop_manager_cycles (
  manager_bitrix_id text PRIMARY KEY,
  disabled_cycles   text[] NOT NULL DEFAULT '{}',
  updated_by        text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rop_manager_cycles_valid CHECK (disabled_cycles <@ ARRAY['ONE','TWO','THREE','END','OTHER']::text[])
);
