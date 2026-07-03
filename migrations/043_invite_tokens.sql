-- Токены приглашений для новых аккаунтов (system DB).
-- Ссылка вида /invite/<token> уходит коллеге через Bitrix, по ней он сам задаёт пароль.
CREATE TABLE IF NOT EXISTS invite_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_tokens_token ON invite_tokens(token);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_user_id ON invite_tokens(user_id);
