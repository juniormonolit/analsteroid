-- Add product rows and "by largest amount" category to deals
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS product_rows jsonb,
  ADD COLUMN IF NOT EXISTS product_group_by_max text;

COMMENT ON COLUMN deals.product_rows IS 'Raw product rows from crm.deal.productrows.get, stored as JSON array';
COMMENT ON COLUMN deals.product_group_by_max IS 'Product group determined by largest sum of product amounts in the deal';
