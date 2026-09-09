-- 182: «Контроль звонков» — вне реестра функций «Аналитика». БД: system.
-- Правка владельца 09.09: «у Контроля звонков одна функция — уведомления о
-- пропущенных, он должен работать ВСЕГДА, его настройки — только на
-- /settings/bots/call-control. У Аналитика — всё остальное». Строка call_control
-- в bot_channels (заведена ещё каналом 09.08, перенесена в реестр 181) удаляется;
-- код sendCallControlBotMessage больше не спрашивает реестр — бот отдельный, свои
-- креды (CALL_CONTROL_*), рубильника у него нет намеренно.
-- DOWN: INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name)
--   VALUES ('call_control', 'Контроль звонков', '…', 'Контроль звонков', true, 50, 'Бот «Контроль звонков»');
DELETE FROM bot_channels WHERE key = 'call_control';
