-- 298: «Большой брат», поток G — еженедельный дайджест директору ботом «Аналитик» (функция big_brother_digest).
-- Отдельной таблицы нет: настройки — bot_channels.config { mode: preview|live, recipients: [bitrix id], previewTo, hour }.
-- Выключен из коробки, режим «предпросмотр» — уходит только владельцу (2098). Правится на /big-brother/signals.
-- Движок: lib/jobs/bigBrotherDigest.ts, расписание — instrumentation.ts (ключ bigBrotherDigest в BACKGROUND_JOBS_ALLOW).
-- БД: monolitika (systemDb). Идемпотентна. Гранты не нужны (таблица bot_channels уже есть).
-- Откат: DELETE FROM bot_channels WHERE key = 'big_brother_digest';

INSERT INTO bot_channels (key, name, description, bot, enabled, sort, group_name, config) VALUES
  ('big_brother_digest', 'Большой брат: дайджест директору',
   'Понедельник утром — отклонения за неделю: кто перестал выходить на связь, РОПы без задач, топ и антитоп отчётов, новые сигналы риска. Получатели и режим «предпросмотр» — /big-brother/signals.',
   'Аналитик', false, 16, 'Дайджесты', '{"mode": "preview", "recipients": [], "previewTo": "2098", "hour": 9}')
ON CONFLICT (key) DO NOTHING;
