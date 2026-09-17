import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { fetchManagerCustomers } from '@/features/customers/engine/customers';
import { addContact, fetchContactHistory, type ContactChannel } from '@/features/customers/engine/contacts';

// Кнопка «Связался» (17.09): менеджер общался с заказчиком мимо телефонии —
// честная отметка с обязательным «о чём договорились». Снимает заказчика из
// очередей «окно открыто / упущено» так же, как успешный звонок.
const CHANNELS: ContactChannel[] = ['messenger', 'email', 'meeting', 'phone_other'];

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null) as { clientKey?: string; managerId?: string; channel?: string; note?: string; contactedAt?: string } | null;
  const clientKey = typeof body?.clientKey === 'string' && /^[ckx]\d+$/.test(body.clientKey) ? body.clientKey : null;
  if (!clientKey) return NextResponse.json({ error: 'Некорректный клиент' }, { status: 400 });
  const managerId = typeof body?.managerId === 'string' && /^\d+$/.test(body.managerId) ? body.managerId : session.bitrixUserId;
  if (!managerId) return NextResponse.json({ error: 'Аккаунт не привязан к менеджеру Битрикса' }, { status: 400 });
  if (managerId !== session.bitrixUserId && !(await canViewManager(session, managerId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const channel = CHANNELS.find(c => c === body?.channel);
  if (!channel) return NextResponse.json({ error: 'Укажите, как связались' }, { status: 400 });
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (note.length < 3) return NextResponse.json({ error: 'Напишите, о чём договорились — хотя бы пару слов' }, { status: 400 });
  let contactedAt: string | null = null;
  if (typeof body?.contactedAt === 'string' && body.contactedAt) {
    const t = new Date(body.contactedAt).getTime();
    if (Number.isNaN(t) || t > Date.now() + 60_000) return NextResponse.json({ error: 'Дата контакта не может быть в будущем' }, { status: 400 });
    contactedAt = new Date(t).toISOString();
  }
  const rows = await fetchManagerCustomers(Number(managerId));
  if (!rows.some(r => r.clientKey === clientKey)) return NextResponse.json({ error: 'Клиент не найден в списке менеджера' }, { status: 404 });

  await addContact({ clientKey, managerBitrixId: managerId, channel, note, contactedAt, session });
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const key = new URL(req.url).searchParams.get('clientKey') ?? '';
  if (!/^[ckx]\d+$/.test(key)) return NextResponse.json({ error: 'Некорректный клиент' }, { status: 400 });
  return NextResponse.json({ items: await fetchContactHistory(key) });
}
