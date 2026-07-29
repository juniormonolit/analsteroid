// Чаты по сделкам (право action.deal_chats).
// GET  ?dealIds=1,2,3 — статусы тредов текущего пользователя для индикации кнопок.
// GET  без dealIds    — список тредов для раздела «Чаты».
// POST { dealId, text } — отправить сообщение менеджеру сделки через бота.

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { getDealChatStatuses, listDealChats, sendDealChatMessage } from '@/lib/deal-chats/service';

export async function GET(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'action.deal_chats');
  if (denied) return denied;

  const dealIdsRaw = req.nextUrl.searchParams.get('dealIds');
  if (dealIdsRaw !== null) {
    const dealIds = dealIdsRaw.split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 2000);
    const statuses = await getDealChatStatuses(session!.id, dealIds);
    return NextResponse.json({ statuses });
  }

  const chats = await listDealChats(session!.id);
  return NextResponse.json({ chats });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'action.deal_chats');
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const dealId = Number(body.dealId);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!Number.isInteger(dealId) || dealId <= 0) return NextResponse.json({ error: 'dealId обязателен' }, { status: 400 });
  if (!text) return NextResponse.json({ error: 'Пустое сообщение' }, { status: 400 });
  if (text.length > 4000) return NextResponse.json({ error: 'Сообщение слишком длинное (макс. 4000)' }, { status: 400 });

  try {
    const { chatId } = await sendDealChatMessage({
      dealId,
      authorUserId: session!.id,
      authorName: session!.displayName || session!.login,
      text,
    });
    return NextResponse.json({ ok: true, chatId });
  } catch (e) {
    console.error('[deal-chats] send failed:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Не удалось отправить' }, { status: 500 });
  }
}
