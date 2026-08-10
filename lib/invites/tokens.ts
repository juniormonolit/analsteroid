import { systemDb } from '@/lib/db/clients';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InviteResult {
  /** Одноразовая ссылка на установку пароля. */
  link: string;
  /**
   * Дошло ли сообщение бота. false — бот в режиме тишины до релиза или Битрикс
   * не принял сообщение. Раньше это молча терялось: админ видел «пользователь
   * создан», человек не получал ничего, и никто не понимал, почему нет доступа.
   * Теперь вызывающий обязан показать ссылку админу на экране.
   */
  delivered: boolean;
}

export async function createAndSendInvite(
  userId: string,
  bitrixUserId: string,
  displayName: string,
  origin: string
): Promise<InviteResult> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  await systemDb().query(
    `INSERT INTO invite_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );

  const link = `${origin}/invite/${token}`;
  // Токен в БД уже лежит, поэтому падение отправки НЕ отменяет приглашение:
  // ссылку всё равно можно передать человеку руками. Иначе админ получал 502,
  // а невидимый ему валидный токен оставался висеть в базе.
  let messageId = 0;
  try {
    messageId = await sendBitrixBotMessage(
      bitrixUserId,
      `Здравствуйте, ${displayName}! Вам открыли доступ в Монолитику.\n` +
        `Перейдите по ссылке, чтобы задать пароль и войти: ${link}\n` +
        `Ссылка одноразовая и действует 7 дней.`,
      undefined,
      'service',   // приглашение шлётся по действию администратора
    );
  } catch (e) {
    console.warn('[invite] бот не принял сообщение, ссылку отдаём админу на экран:', e);
  }
  return { link, delivered: messageId > 0 };
}
