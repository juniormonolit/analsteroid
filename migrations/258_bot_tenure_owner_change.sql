-- Задача 11110: функция бота «Аналитик» — пуш РОПу, когда учётка сменила хозяина.
-- Системная БД (run_system.mjs). Аддитивно: одна строка в bot_channels.
-- Выключена по умолчанию, как все функции после 181 — включает владелец
-- в «Настройки → Боты → Аналитик». Плюс общий рубильник dry_run_managers.
--
-- DOWN: DELETE FROM bot_channels WHERE key = 'tenure_owner_change';

INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config)
VALUES ('tenure_owner_change', 'Смена хозяина учётки',
        'Ночной синк оргструктуры увидел на учётке нового человека — РОПу отдела подсказка проставить дату начала, чтобы стаж и опыт считались по человеку.',
        'Аналитик', false, 34, 'Дайджесты', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;
