import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ensureWidgetToken } from '@/lib/widget/tokens';
import { buildWidgetScript } from '@/lib/widget/scriptTemplate';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { getPublicOrigin } from '@/lib/http/publicOrigin';

// Отправляет пользователю ОДНО сообщение через бота «Аналитик» с готовым Scriptable-
// скриптом (персональный токен уже внутри). Пользователь копирует код → вставляет в
// Scriptable → добавляет виджет. Токен переиспользуется (ensureWidgetToken), не плодим.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) {
    return NextResponse.json({ error: 'no_bitrix', message: 'К аккаунту не привязан Bitrix — скопируйте скрипт вручную' }, { status: 400 });
  }

  const token = await ensureWidgetToken(session.id);
  const origin = getPublicOrigin(req);
  const script = buildWidgetScript(token, origin);

  const message =
    'Виджет «Аналстероид» для iPhone.\n' +
    '1) Установите приложение Scriptable из App Store.\n' +
    '2) Создайте новый скрипт, вставьте код ниже целиком.\n' +
    '3) На экране «Домой» добавьте виджет Scriptable и выберите этот скрипт.\n\n' +
    '```\n' + script + '\n```';

  try {
    await sendBitrixBotMessage(session.bitrixUserId, message);
  } catch {
    return NextResponse.json({ error: 'send_failed', message: 'Не удалось отправить сообщение через бота' }, { status: 502 });
  }
  return NextResponse.json({ ok: true, bytes: script.length });
}
