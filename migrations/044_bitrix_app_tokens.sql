-- OAuth-токены локального приложения Bitrix24 ("Аналитик") + id зарегистрированного бота.
CREATE TABLE IF NOT EXISTS bitrix_app_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_domain text UNIQUE NOT NULL,
  member_id text NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  bot_id text,
  updated_at timestamptz DEFAULT now()
);
