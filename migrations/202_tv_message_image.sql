-- 202: «Телевизоры» — картинка на фон полноэкранного сообщения (правка владельца 07.09).
-- Файлового хранилища в проекте нет (standalone-деплой тарит .next заново), поэтому
-- картинка лежит в БД: админка ужимает её на клиенте до ≤1920px JPEG (обычно 150–400 КБ),
-- отдаётся публично /api/tv/media/<id> с immutable-кэшем. Сообщение ссылается по image_id.
CREATE TABLE IF NOT EXISTS tv_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  size        INT NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tv_messages ADD COLUMN IF NOT EXISTS image_id uuid REFERENCES tv_media(id) ON DELETE SET NULL;
