import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { fetchManagerCustomers } from '@/features/customers/engine/customers';
import { createExclusionRequest, decideExclusion, listPendingExclusions } from '@/features/customers/engine/contacts';
import { fetchTeamRoster } from '@/features/customers/engine/team';

// Исключение заказчика из канбана навсегда — через РОПа (решение владельца 17.09:
// «может, на негативе всё прошло, мы не знаем»). Менеджер — POST с причиной
// (запрос), руководитель, которому виден кабинет менеджера, — PATCH (решение).
// Сам себе одобрить нельзя: решение принимает тот, кто смотрит чужой кабинет.

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  if (url.searchParams.get('team') === '1') {
    // Командный вид: запросы всех менеджеров подконтрольных отделов, решать можно.
    const roster = await fetchTeamRoster(session);
    const lists = await Promise.all(roster.map(m => listPendingExclusions(m.id)));
    return NextResponse.json({ items: lists.flat(), canDecide: true });
  }
  const managerId = url.searchParams.get('managerId') ?? session.bitrixUserId ?? '';
  if (!/^\d+$/.test(managerId)) return NextResponse.json({ items: [], canDecide: false });
  if (managerId !== session.bitrixUserId && !(await canViewManager(session, managerId))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return NextResponse.json({ items: await listPendingExclusions(managerId), canDecide: managerId !== session.bitrixUserId });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null) as { clientKey?: string; managerId?: string; reason?: string } | null;
  const clientKey = typeof body?.clientKey === 'string' && /^[ckx]\d+$/.test(body.clientKey) ? body.clientKey : null;
  if (!clientKey) return NextResponse.json({ error: 'Некорректный клиент' }, { status: 400 });
  const managerId = typeof body?.managerId === 'string' && /^\d+$/.test(body.managerId) ? body.managerId : session.bitrixUserId;
  if (!managerId) return NextResponse.json({ error: 'Аккаунт не привязан к менеджеру Битрикса' }, { status: 400 });
  if (managerId !== session.bitrixUserId && !(await canViewManager(session, managerId))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3) return NextResponse.json({ error: 'Опишите причину — РОП должен понять, почему' }, { status: 400 });
  const rows = await fetchManagerCustomers(Number(managerId));
  if (!rows.some(r => r.clientKey === clientKey)) return NextResponse.json({ error: 'Клиент не найден в списке менеджера' }, { status: 404 });
  const request = await createExclusionRequest({ clientKey, managerBitrixId: managerId, reason, session });
  return NextResponse.json({ ok: true, request });
}

export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null) as { id?: number; approve?: boolean; comment?: string; managerId?: string } | null;
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0 || typeof body?.approve !== 'boolean') return NextResponse.json({ error: 'Нужны id и approve' }, { status: 400 });
  const managerId = typeof body?.managerId === 'string' && /^\d+$/.test(body.managerId) ? body.managerId : null;
  if (!managerId) return NextResponse.json({ error: 'Нужен managerId' }, { status: 400 });
  // Решает руководитель, а не сам менеджер.
  if (managerId === session.bitrixUserId || !(await canViewManager(session, managerId))) {
    return NextResponse.json({ error: 'Решение принимает руководитель, который видит кабинет менеджера' }, { status: 403 });
  }
  const pending = await listPendingExclusions(managerId);
  if (!pending.some(p => p.id === id)) return NextResponse.json({ error: 'Запрос не найден или уже решён' }, { status: 404 });
  const comment = typeof body?.comment === 'string' && body.comment.trim() ? body.comment.trim().slice(0, 500) : null;
  const res = await decideExclusion(id, body.approve, comment, session);
  return NextResponse.json({ ok: true, request: res });
}
