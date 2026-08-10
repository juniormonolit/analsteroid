import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { getPublicOrigin } from '@/lib/http/publicOrigin';

// «Получить доступ по прямой ссылке» (сценарий владельца 05.08: зашёл через
// локальное приложение Битрикса → нажал кнопку → получил ссылку → открыл в
// браузере, задал пароль, сохранил как приложение).
//
// ПОЧЕМУ ЭТО БЕЗОПАСНО: человек УЖЕ аутентифицирован — сессию завёл обработчик
// /api/bitrix/app по подписанному токену портала. Значит выдать ему же ссылку на
// установку СОБСТВЕННОГО пароля не даёт новых прав: это тот же аккаунт, просто
// второй способ входа. Ссылка одноразовая, живёт 7 дней (общий INVITE_TTL_MS),
// привязана к user_id сессии — подставить чужой id нельзя, он не принимается.
//
// ПОЧЕМУ ССЫЛКА ВОЗВРАЩАЕТСЯ В ОТВЕТЕ, А НЕ ТОЛЬКО ШЛЁТСЯ БОТОМ: бот сейчас в
// режиме тишины (BOT_SEND_ENABLED не выставлен) и молча ничего не доставляет —
// на этом уже сгорели приглашения новых пользователей (см. карту бота, дыра №1).
// Показываем ссылку на экране, а отправку ботом делаем попыткой: получилось —
// хорошо, нет — человек копирует с экрана.

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + TTL_MS);

  await systemDb().query(
    `INSERT INTO invite_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [session.id, token, expiresAt],
  );

  // Тот же помощник, что у админских инвайтов: за прокси берёт x-forwarded-host.
  const origin = getPublicOrigin(req);
  const link = `${origin}/invite/${token}`;

  let sentViaBot = false;
  if (session.bitrixUserId) {
    try {
      const id = await sendBitrixBotMessage(
        session.bitrixUserId,
        `Доступ в Монолитику по прямой ссылке.\n${link}\n` +
        'Откройте в браузере, задайте пароль — и приложение можно сохранить на телефон. ' +
        'Ссылка одноразовая, действует 7 дней.',
        undefined,
        'service',   // адресное сообщение по действию человека, не автоматика
      );
      sentViaBot = Number(id) > 0; // 0 = бот в тишине, ничего не ушло
    } catch {
      sentViaBot = false;
    }
  }

  return NextResponse.json({ link, expiresAt: expiresAt.toISOString(), sentViaBot });
}
