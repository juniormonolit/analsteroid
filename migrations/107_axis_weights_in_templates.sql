-- Веса рейтинга переезжают В ОСИ шаблонов карточек (задача владельца 30.07:
-- «веса не синхронизируются с тем, что выбрано в карточках… и должны быть в 2
-- вариантах: для карточки менеджера и для карточки РОПа»).
--
-- БЫЛО: таблица scoring_weights — singleton (id=1) с 6 ФИКСИРОВАННЫМИ колонками
-- по именам legacy-осей. Ось из каталога метрик в неё не попадала и молча
-- получала вес 5 (см. прежний weightForAxis), а отдельного набора весов для
-- шаблона 'department' не существовало вовсе.
-- СТАЛО: card_templates.axes[].weight (0-10) — вес живёт в самой оси, поэтому
-- синхронизирован с выбором по построению, и у каждого шаблона свой набор.
--
-- Миграция идемпотентна: weight добавляется только тем осям, где его ещё нет
-- (jsonb ? 'weight'), значение берётся из scoring_weights для 6 исторических
-- legacy-ключей, остальным — 5 (тот же дефолт, что применялся в коде).
-- scoring_weights НЕ удаляется: страница /settings/scoring-weights превращена в
-- указатель на новый экран, а таблица остаётся историческим следом (drop —
-- отдельным решением владельца).

DO $$
DECLARE
  w RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'card_templates') THEN
    RAISE NOTICE 'card_templates нет — пропускаю (миграция 073 не накатана)';
    RETURN;
  END IF;

  -- Старые веса (если таблицы нет — все по 5)
  BEGIN
    SELECT cr_deal_to_reservation, cr_reservation_to_sale, sales_amount,
           avg_check, touch_speed, refusal_rate
      INTO w
      FROM scoring_weights WHERE id = 1;
  EXCEPTION WHEN undefined_table THEN
    w := NULL;
  END;

  UPDATE card_templates ct
     SET axes = sub.new_axes
    FROM (
      SELECT c.template_key,
             jsonb_agg(
               CASE WHEN ax ? 'weight' THEN ax
                    ELSE ax || jsonb_build_object('weight', COALESCE(
                      CASE ax->>'metricKey'
                        WHEN 'legacy:cr_deal_to_reservation' THEN (SELECT cr_deal_to_reservation FROM scoring_weights WHERE id = 1)
                        WHEN 'legacy:cr_reservation_to_sale' THEN (SELECT cr_reservation_to_sale FROM scoring_weights WHERE id = 1)
                        WHEN 'legacy:sales_amount'           THEN (SELECT sales_amount FROM scoring_weights WHERE id = 1)
                        WHEN 'legacy:avg_check'              THEN (SELECT avg_check FROM scoring_weights WHERE id = 1)
                        WHEN 'legacy:touch_speed'            THEN (SELECT touch_speed FROM scoring_weights WHERE id = 1)
                        WHEN 'legacy:refusal_rate'           THEN (SELECT refusal_rate FROM scoring_weights WHERE id = 1)
                        ELSE NULL
                      END, 5))
               END
               ORDER BY ord
             ) AS new_axes
        FROM card_templates c,
             LATERAL jsonb_array_elements(c.axes) WITH ORDINALITY AS t(ax, ord)
       WHERE jsonb_typeof(c.axes) = 'array'
       GROUP BY c.template_key
    ) sub
   WHERE ct.template_key = sub.template_key
     AND NOT (ct.axes @> '[{"weight": 0}]'::jsonb AND false); -- no-op guard, апдейт идемпотентен по ax ? 'weight'
END $$;
