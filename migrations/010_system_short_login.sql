-- Add short_login column to org_resolved_hierarchy in system DB
ALTER TABLE org_resolved_hierarchy ADD COLUMN IF NOT EXISTS short_login TEXT;

-- Populate with default: '#' || manager_bitrix_user_id (standard Bitrix manager login format)
UPDATE org_resolved_hierarchy
SET short_login = '#' || manager_bitrix_user_id::text
WHERE short_login IS NULL;
