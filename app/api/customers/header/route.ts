import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { fetchRepeatHeader } from '@/features/customers/engine/repeatHeader';

// Шапка «Моих заказчиков»: метрики менеджера по повторным продажам за месяц с
// трендом к прошлому (17.09). Доступ — как у списка.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const requested = new URL(req.url).searchParams.get('bitrixId');
  const bitrixId = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (!bitrixId) return NextResponse.json({ error: 'Аккаунт не привязан к менеджеру Битрикса' }, { status: 400 });
  if (bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return NextResponse.json(await fetchRepeatHeader(Number(bitrixId)));
}
