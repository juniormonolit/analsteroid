-- Fix ППП: remove stage_type filter (it wrongly excludes deals that progressed past sale stage)
-- date_field='sold_at' already ensures sold_at IS NOT NULL; _ppp subquery ensures it's the 2nd sale

UPDATE metrics SET
  filters = '[{"field":"_ppp","op":"eq","value":""}]'::jsonb
WHERE id IN ('ppp_count', 'ppp_amount');

-- Fix ППО: same issue with stage_type=shipment
UPDATE metrics SET
  filters = '[{"field":"_ppo","op":"eq","value":""}]'::jsonb
WHERE id IN ('ppo_count', 'ppo_amount');
