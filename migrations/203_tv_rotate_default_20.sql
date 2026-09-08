-- 203: «Телевизоры» — топ-6 висит 20 с (правка владельца 08.09: «статические 6 лучших
-- на 20 секунд, остальные в карусель по 10»). Меняем дефолт колонки и поднимаем
-- существующие экраны, оставшиеся на старом дефолте 15.
ALTER TABLE tv_screens ALTER COLUMN rotate_sec SET DEFAULT 20;
UPDATE tv_screens SET rotate_sec = 20 WHERE rotate_sec = 15;
