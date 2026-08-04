-- Своя картинка для карточки товара магазина (задача 2994, правка владельца:
-- «а можно вставить картинку из интернета?»). Байты — прямо в БД, тем же
-- приёмом, что idea_attachments (миграция 101): прод деплоится тарболом
-- (.next/standalone перезаписывается), локальный диск не переживает деплой,
-- объектного хранилища (Supabase Storage/S3) в приложении нет. NULL —
-- позиция показывает emoji (как раньше, ничего не сломано для существующих
-- 18 позиций).
-- СИСТЕМНАЯ БД (YC) — применяется вручную migrations/run_system.mjs,
-- ОТДЕЛЬНО на dev (junibaseone) и на prod (system).
-- DOWN: ALTER TABLE shop_items DROP COLUMN image_mime, image_data;

ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS image_mime text
    CHECK (image_mime IS NULL OR image_mime IN ('image/png','image/jpeg','image/webp')),
  ADD COLUMN IF NOT EXISTS image_data bytea;

COMMENT ON COLUMN shop_items.image_mime IS
  'MIME своей картинки карточки (PNG/JPEG/WEBP — SVG не поддерживается, нет санитайзера). NULL = используется emoji. Тип определяется по сигнатуре байтов на сервере (lib/images/shopItemImage.ts sniffImageMime), не по заголовку/расширению.';
COMMENT ON COLUMN shop_items.image_data IS
  'Байты своей картинки (аналог idea_attachments.data, миграция 101) — своего объектного хранилища нет, диск не переживает деплой тарболом. Отдаётся GET /api/shop-item-image/[id]. Квадрат карточки — CSS object-fit:cover при показе, не пере-кодирование при сохранении.';
