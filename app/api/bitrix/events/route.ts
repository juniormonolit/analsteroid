import { NextRequest, NextResponse } from 'next/server';
import { handleIncomingBotMessage, handleBindDealCommand } from '@/lib/deal-chats/service';

// Обработчик событий бота «Аналитик». Сейчас обслуживает чаты по сделкам
// (ответы менеджеров и клики по кнопкам bind_deal); разбор вопросов на
// естественном языке — по-прежнему Phase 2.
//
// Битрикс шлёт события form-encoded с плоскими ключами вида
// data[PARAMS][MESSAGE]; работаем прямо по этим ключам.
export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') || '';
  const data: Record<string, unknown> = {};

  if (contentType.includes('application/json')) {
    Object.assign(data, await req.json().catch(() => ({})));
  } else {
    const form = await req.formData().catch(() => null);
    if (form) for (const [key, value] of form.entries()) data[key] = String(value);
  }

  const event = String(data.event ?? '');
  console.log('[bitrix/events]', event || 'unknown event', JSON.stringify(data).slice(0, 500));

  const str = (key: string): string => String(data[key] ?? '');
  const botId = process.env.BITRIX_BOT_ID || '';

  try {
    // Ответ менеджера боту в личке. Системные и свои (бота) сообщения пропускаем.
    if (event === 'ONIMBOTMESSAGEADD'
        && str('data[PARAMS][MESSAGE_TYPE]') === 'P'
        && str('data[PARAMS][SYSTEM]') !== 'Y'
        && str('data[PARAMS][FROM_USER_ID]') !== botId) {
      const replyIdRaw = str('data[PARAMS][PARAMS][REPLY_ID]');
      await handleIncomingBotMessage({
        fromUserId: str('data[PARAMS][FROM_USER_ID]'),
        text: str('data[PARAMS][MESSAGE]'),
        replyToBitrixMessageId: replyIdRaw ? Number(replyIdRaw) : null,
      });
    }

    // Клик по кнопке «к какой сделке относится ответ?». Ключ содержит id команды:
    // data[COMMAND][<id>][COMMAND] = 'bind_deal' — ищем по значению, id не хардкодим.
    if (event === 'ONIMCOMMANDADD') {
      const cmdKey = Object.keys(data).find(
        k => /^data\[COMMAND\]\[\d+\]\[COMMAND\]$/.test(k) && data[k] === 'bind_deal',
      );
      if (cmdKey) {
        const chatId = Number(str(cmdKey.replace(/\[COMMAND\]$/, '[COMMAND_PARAMS]')));
        if (chatId) {
          await handleBindDealCommand({ fromUserId: str('data[PARAMS][FROM_USER_ID]'), chatId });
        }
      }
    }
  } catch (e) {
    // Событиям бота всегда отвечаем 200 — иначе Битрикс ретраит и может отключить
    // обработчик (мы такое уже проходили с 301 после переезда домена).
    console.error('[bitrix/events] обработка не удалась:', e);
  }

  return NextResponse.json({});
}
