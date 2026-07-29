-- Чаты по сделкам: РОП пишет менеджеру через бота «Аналитик», ответы менеджера
-- прилетают в вебхук и складываются тредами (спайк 2026-07-20, см. WORKLOG).
-- System DB. Право на фичу — каталожный ключ action.deal_chats (без миграции).

CREATE TABLE IF NOT EXISTS deal_chats (
  id BIGSERIAL PRIMARY KEY,
  deal_id BIGINT NOT NULL,
  deal_name TEXT,                          -- снимок названия на момент создания (для списка «Чаты»)
  manager_bitrix_user_id TEXT NOT NULL,    -- ответственный менеджер (получатель в личке бота)
  created_by_user_id UUID NOT NULL,        -- users.id автора (РОП)
  created_by_name TEXT NOT NULL,           -- снимок display_name («от кого» в сообщении)
  status TEXT NOT NULL DEFAULT 'sent',     -- sent | replied (есть ответ менеджера)
  has_unread_reply BOOLEAN NOT NULL DEFAULT false, -- красная индикация; гасится при открытии треда
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Один живой тред на пару сделка+автор (повторное «Сообщение» дописывает в тот же тред)
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_chats_deal_author
  ON deal_chats (deal_id, created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_deal_chats_manager ON deal_chats (manager_bitrix_user_id);
CREATE INDEX IF NOT EXISTS idx_deal_chats_last_message ON deal_chats (last_message_at DESC);

CREATE TABLE IF NOT EXISTS deal_chat_messages (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES deal_chats(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,                 -- out (РОП → менеджер) | in (ответ менеджера)
  author_name TEXT NOT NULL,               -- display_name РОПа или имя менеджера
  text TEXT NOT NULL,
  bitrix_message_id BIGINT,                -- id сообщения бота (для корреляции REPLY_ID)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deal_chat_messages_chat ON deal_chat_messages (chat_id, created_at);
-- Корреляция ответа-реплая: REPLY_ID → наше исходящее сообщение → тред
CREATE INDEX IF NOT EXISTS idx_deal_chat_messages_bitrix_id
  ON deal_chat_messages (bitrix_message_id) WHERE bitrix_message_id IS NOT NULL;

-- Неоднозначный ответ менеджера (несколько открытых тредов, ни реплая, ни номера
-- сделки в тексте): текст паркуется здесь, бот шлёт кнопки выбора; клик по кнопке
-- (ONIMCOMMANDADD bind_deal) забирает текст и привязывает к выбранному треду.
-- Один «зависший» ответ на менеджера — новый затирает старый.
CREATE TABLE IF NOT EXISTS deal_chat_pending_replies (
  manager_bitrix_user_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
