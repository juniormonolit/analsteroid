// Тред чата по сделке: GET ?chatId= (открытие гасит непрочитанное)
// или ?dealId= (тред текущего пользователя по сделке — для сайдбара из списка сделок).

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { getDealChatThread } from '@/lib/deal-chats/service';

export async function GET(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'action.deal_chats');
  if (denied) return denied;

  let chatId = Number(req.nextUrl.searchParams.get('chatId'));
  const dealId = Number(req.nextUrl.searchParams.get('dealId'));

  if (!chatId && dealId) {
    const res = await systemDb().query<{ id: number }>(
      'SELECT id FROM deal_chats WHERE deal_id = $1 AND created_by_user_id = $2',
      [dealId, session!.id],
    );
    if (!res.rows.length) return NextResponse.json({ thread: null });
    chatId = res.rows[0].id;
  }
  if (!chatId) return NextResponse.json({ error: 'chatId или dealId обязателен' }, { status: 400 });

  const thread = await getDealChatThread(session!.id, chatId);
  if (!thread) return NextResponse.json({ error: 'Тред не найден' }, { status: 404 });
  return NextResponse.json({ thread });
}
