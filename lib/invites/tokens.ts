import { systemDb } from '@/lib/db/clients';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createAndSendInvite(
  userId: string,
  bitrixUserId: string,
  displayName: string,
  origin: string
): Promise<void> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  await systemDb().query(
    `INSERT INTO invite_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );

  const link = `${origin}/invite/${token}`;
  await sendBitrixBotMessage(
    bitrixUserId,
    `Здравствуйте, ${displayName}! Вам открыли доступ в Монолитику.\n` +
      `Перейдите по ссылке, чтобы задать пароль и войти: ${link}\n` +
      `Ссылка одноразовая и действует 7 дней.`
  );
}
