-- Фича «Идеи и планы»: вложения-скриншоты к идее (владелец, задача 14.07).
-- Прод деплоится тарболом (.next/standalone перезаписывается) — локальный диск не
-- переживает деплой, а объектного хранилища (Supabase Storage/S3) в приложении нет.
-- Поэтому байты картинки храним прямо в БД: скрины — сотни КБ, инструмент внутренний,
-- вложений на идею единицы. Таблица в той же БД, что и ideas (миграция 059) — YC system,
-- где у нас есть DDL-права. Отдаём байты через роут /api/ideas/[id]/attachments/[attId].
--
-- БД: YC system (run_system.mjs).

CREATE TABLE IF NOT EXISTS idea_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idea_id     uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  mime_type   text NOT NULL,
  byte_size   integer NOT NULL,
  data        bytea NOT NULL,
  uploaded_by text NOT NULL,          -- login того, кто загрузил (для гейта удаления)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idea_attachments_idea_id_idx
  ON idea_attachments (idea_id, created_at);
