-- Кэш аватарок произвольных менеджеров из Битрикса (ЛК менеджера, «Карточка 10.0»).
-- В отличие от users.avatar_url (только пользователи приложения), покрывает любого
-- менеджера из sa.org_resolved_hierarchy. Ленивая синхронизация с TTL — как
-- lib/bitrix/avatar.ts. System DB.

CREATE TABLE IF NOT EXISTS manager_avatars (
  bitrix_user_id TEXT PRIMARY KEY,
  avatar_url TEXT,             -- NULL = у пользователя нет фото (но проверяли)
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
