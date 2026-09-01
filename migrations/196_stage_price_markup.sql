-- Миграция 196: разметка стадий «Нет цены / Есть цена / Спорно» (задача владельца
-- 01.09: скорость озвучивания цены). БД: SYSTEM. Накат:
--   node migrations/run_local.mjs migrations/196_stage_price_markup.sql --db=system
--
-- Три состояния (ТЗ владельца): 'no_price' — цена ещё не озвучена; 'has_price' —
-- стадия невозможна без озвученной цены (вход в неё фиксирует момент цены);
-- 'unclear' — «Спорно», НЕ участвует в расчёте: сделка, вошедшая в спорную
-- стадию ДО первой ценовой, исключается и из числителя, и из знаменателя.
-- Стадии, которых нет в таблице (новые из Битрикса), считаются 'no_price' и
-- подсвечиваются в «Настройки → Цена: разметка стадий» бейджем «не размечена».
--
-- Сид — стартовая классификация (разведка 01.09, воронки 0/1/2/3/4/7):
-- ON CONFLICT DO NOTHING — повторный накат НЕ затирает ручные правки владельца.

CREATE TABLE IF NOT EXISTS stage_price_markup (
  stage_id   text PRIMARY KEY,   -- Bitrix stage id (sa.stages.id), напр. 'C1:FINAL_INVOICE'
  state      text NOT NULL CHECK (state IN ('no_price', 'has_price', 'unclear')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- «Есть цена»: озвучил/КП/счёт, все брони и продажи/отгрузки, все ценовые отказы.
INSERT INTO stage_price_markup (stage_id, state) VALUES
  ('FINAL_INVOICE', 'has_price'), ('UC_PU4HM2', 'has_price'), ('UC_SQEHTU', 'has_price'),
  ('1', 'has_price'), ('2', 'has_price'), ('WON', 'has_price'), ('LOSE', 'has_price'),
  ('APOLOGY', 'has_price'), ('3', 'has_price'), ('8', 'has_price'),
  ('C1:FINAL_INVOICE', 'has_price'), ('C1:1', 'has_price'), ('C1:2', 'has_price'),
  ('C1:3', 'has_price'), ('C1:WON', 'has_price'), ('C1:LOSE', 'has_price'), ('C1:11', 'has_price'),
  ('C2:EXECUTING', 'has_price'), ('C2:FINAL_INVOICE', 'has_price'), ('C2:WON', 'has_price'),
  ('C2:LOSE', 'has_price'), ('C2:5', 'has_price'), ('C2:4', 'has_price'),
  ('C3:PREPAYMENT_INVOICE', 'has_price'), ('C3:EXECUTING', 'has_price'), ('C3:FINAL_INVOICE', 'has_price'),
  ('C3:1', 'has_price'), ('C3:WON', 'has_price'), ('C3:LOSE', 'has_price'), ('C3:4', 'has_price'),
  ('C4:2', 'has_price'), ('C4:3', 'has_price'), ('C4:WON', 'has_price'),
  ('C4:LOSE', 'has_price'), ('C4:APOLOGY', 'has_price'),
  ('C7:PREPAYMENT_INVOICE', 'has_price'), ('C7:UC_WLU9MK', 'has_price'), ('C7:UC_CJSYMN', 'has_price'),
  ('C7:FINAL_INVOICE', 'has_price'), ('C7:UC_B8WDR7', 'has_price'), ('C7:WON', 'has_price'),
  ('C7:1', 'has_price'), ('C7:4', 'has_price')
ON CONFLICT (stage_id) DO NOTHING;

-- «Спорно» (владелец решит в настройках): «Уже заказали и оплатили» (ЧЛ '4',
-- ЮЛ C1:APOLOGY), «Хотят постоплату» (C1:5), «Заполнил все материалы и
-- запланировал звонок (B2C)» (C2:PREPAYMENT_INVOICE), «Рассматривает РБ»
-- (C4:FINAL_INVOICE), «Предложил кровлю» (C4:1), «Не готовы работать по
-- постоплате по этой заявке» (C7:5).
INSERT INTO stage_price_markup (stage_id, state) VALUES
  ('4', 'unclear'), ('C1:APOLOGY', 'unclear'), ('C1:5', 'unclear'),
  ('C2:PREPAYMENT_INVOICE', 'unclear'), ('C4:FINAL_INVOICE', 'unclear'),
  ('C4:1', 'unclear'), ('C7:5', 'unclear')
ON CONFLICT (stage_id) DO NOTHING;

SELECT state, count(*) FROM stage_price_markup GROUP BY 1 ORDER BY 1;
