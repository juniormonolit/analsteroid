-- Тема «Дизайн Куликова» — по умолчанию для всех (решение Сергея 10.10, задача #9374).
-- 1) DEFAULT колонки users.theme -> 'kulikov' (новые пользователи, приглашённые из Битрикса);
-- 2) все, у кого сейчас 'classic', переводятся на 'kulikov'. 'classic' = прежний DEFAULT,
--    осознанный выбор «classic» от дефолта в данных не отличить (как в миграциях 148/224) —
--    Сергей согласовал; light/dark/mono (осознанный выбор) НЕ трогаются.
-- Откат: ALTER COLUMN theme SET DEFAULT 'classic'; UPDATE users SET theme='classic'
--   WHERE id IN (<id из дампа, где было classic>). БД: system. Идемпотентна.
ALTER TABLE users ALTER COLUMN theme SET DEFAULT 'kulikov';
UPDATE users SET theme = 'kulikov' WHERE theme = 'classic';
