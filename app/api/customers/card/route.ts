import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { fetchManagerCustomers } from '@/features/customers/engine/customers';
import { fetchCustomerCard } from '@/features/customers/engine/card';

// Карточка клиента (фича Серёги 01.08): доп-данные к строке «Моих заказчиков».
// Права — тот же рубеж, что на списке (canViewManager: менеджер — своих,
// РОП — подчинённых, руководство — всех) + клиент обязан присутствовать в
// списке этого менеджера (кэш движка) — чужие client_key не отдаются.

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const clientKey = /^[ck]\d+$/.test(sp.get('clientKey') ?? '') ? sp.get('clientKey')! : null;
  const requested = sp.get('bitrixId');
  const bitrixId = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (!clientKey || !bitrixId) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });

  if (bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const rows = await fetchManagerCustomers(Number(bitrixId));
  if (!rows.some(r => r.clientKey === clientKey)) {
    return NextResponse.json({ error: 'Клиент не найден в списке менеджера' }, { status: 404 });
  }

  const card = await fetchCustomerCard(clientKey);
  return NextResponse.json(card);
}
