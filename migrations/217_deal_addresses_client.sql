-- 217: в кэш адресов — привязка сделки к заказчику и ключ «объекта».
--
-- Зачем: признак «возит на разные объекты» (потенциальный застройщик) и карта
-- должны считаться без обращения к Битриксу и без кросс-базного джойна с
-- sa.deals (адреса живут в системной БД, сделки — в SA). Битрикс отдаёт
-- COMPANY_ID/CONTACT_ID/CATEGORY_ID тем же запросом, что и адрес, — кладём их
-- рядом и выводим ключ заказчика ровно по формуле
-- features/customers/engine/clientKey.ts (CATEGORY_ID = funnel_id в sa.deals).
--
-- obj_key — «это тот же объект или другой»: координаты, округлённые до ~100 м
-- (одна стройплощадка в разных сделках даёт слегка разные точки), иначе
-- нормализованная строка адреса. Та же логика, что objectKey() в
-- lib/bitrix/addressUtils.ts — держать синхронно.

ALTER TABLE deal_addresses
  ADD COLUMN IF NOT EXISTS company_id  bigint,
  ADD COLUMN IF NOT EXISTS contact_id  bigint,
  ADD COLUMN IF NOT EXISTS category_id int;

ALTER TABLE deal_addresses
  ADD COLUMN IF NOT EXISTS client_key text GENERATED ALWAYS AS (
    CASE
      WHEN category_id IN (0,2) AND contact_id IS NOT NULL AND contact_id <> 0 THEN 'c'||contact_id
      WHEN coalesce(company_id,0) = 0 AND contact_id IS NOT NULL AND contact_id <> 0 THEN 'x'||contact_id
      WHEN coalesce(company_id,0) <> 0 THEN 'k'||company_id
      ELSE NULL
    END
  ) STORED;

ALTER TABLE deal_addresses
  ADD COLUMN IF NOT EXISTS obj_key text GENERATED ALWAYS AS (
    CASE
      WHEN lat IS NOT NULL AND lon IS NOT NULL
        THEN round(lat::numeric, 3)::text || ',' || round(lon::numeric, 3)::text
      WHEN address IS NOT NULL AND btrim(address) <> ''
        THEN lower(btrim(regexp_replace(address, '\s+', ' ', 'g')))
      ELSE NULL
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS deal_addresses_client_idx ON deal_addresses (client_key) WHERE client_key IS NOT NULL;
