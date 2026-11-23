// Задачник: заказчики менеджера для чек-листа — открытое окно (22 дня) и ровно одна отгрузка.
import { NextRequest, NextResponse } from 'next/server';
import { canSeeManager, scopeForbidden } from '@/lib/org/sessionScope';
import { taskerAuth, intParam } from '@/features/tasker/engine/http';
import { loadHotCustomers } from '@/features/tasker/engine/customers';
import { errorResponse } from '@/features/tasker/engine/config';
import type { TaskerCustomersResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  const managerId = intParam(req.nextUrl.searchParams.get('managerId'));
  if (!managerId) return NextResponse.json({ error: 'Не указан managerId', code: 'bad_request' }, { status: 400 });
  if (!canSeeManager(auth.scope, String(managerId))) return scopeForbidden('Этот менеджер вам недоступен');
  try {
    const out: TaskerCustomersResponse = { customers: await loadHotCustomers(String(managerId)) };
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
