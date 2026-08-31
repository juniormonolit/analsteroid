-- Migration 188: формулы для CR стадий (повт.) — calculated без formula в каталоге
-- БД: YC analytics. Накат: node migrations/run_local.mjs migrations/188_cr_stage_repeat_formulas.sql --db=analytics
--
-- Хвост аудита 187: 14 метрик cr_stage_*_repeat имеют metric_type='calculated',
-- но ПУСТУЮ formula — их считает движок stageConversions.ts напрямую (повторные
-- воронки), автогенерации не из чего строиться. Даём ручную formula_human тем же
-- шаблоном, что у первичных CR.

BEGIN;

UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Новая» за период: доля дошедших затем (когда угодно позже) до «Взял в работу», %$mtxt$ WHERE id = 'cr_stage_new_to_taken_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Новая» за период: доля дошедших затем (когда угодно позже) до «Отказ», %$mtxt$ WHERE id = 'cr_stage_new_to_lost_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Взял в работу» за период: доля дошедших затем (когда угодно позже) до «Связался со снабженцем», %$mtxt$ WHERE id = 'cr_stage_taken_to_contacted_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Взял в работу» за период: доля дошедших затем (когда угодно позже) до «Отказ», %$mtxt$ WHERE id = 'cr_stage_taken_to_lost_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Связался со снабженцем» за период: доля дошедших затем (когда угодно позже) до «Озвучил цену/КП», %$mtxt$ WHERE id = 'cr_stage_contacted_to_priced_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Связался со снабженцем» за период: доля дошедших затем (когда угодно позже) до «Отказ», %$mtxt$ WHERE id = 'cr_stage_contacted_to_lost_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Озвучил цену/КП» за период: доля дошедших затем (когда угодно позже) до «Бронь», %$mtxt$ WHERE id = 'cr_stage_priced_to_reservation_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Озвучил цену/КП» за период: доля дошедших затем (когда угодно позже) до «Отказ», %$mtxt$ WHERE id = 'cr_stage_priced_to_lost_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Бронь» за период: доля дошедших затем (когда угодно позже) до «Подтв. бронь», %$mtxt$ WHERE id = 'cr_stage_reservation_to_confirmed_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Бронь» за период: доля дошедших затем (когда угодно позже) до «Отказ», %$mtxt$ WHERE id = 'cr_stage_reservation_to_lost_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Подтв. бронь» за период: доля дошедших затем (когда угодно позже) до «Продажа», %$mtxt$ WHERE id = 'cr_stage_confirmed_to_sale_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Подтв. бронь» за период: доля дошедших затем (когда угодно позже) до «Отказ», %$mtxt$ WHERE id = 'cr_stage_confirmed_to_lost_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Продажа» за период: доля дошедших затем (когда угодно позже) до «Отгрузка», %$mtxt$ WHERE id = 'cr_stage_sale_to_shipment_repeat' AND formula_human IS NULL;
UPDATE metrics SET formula_human = $mtxt$= из сделок ПОВТОРНЫХ воронок, впервые вошедших в «Продажа» за период: доля дошедших затем (когда угодно позже) до «Отказ», %$mtxt$ WHERE id = 'cr_stage_sale_to_lost_repeat' AND formula_human IS NULL;

COMMIT;
