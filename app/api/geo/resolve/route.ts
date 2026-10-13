import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveAddressInput } from '@/lib/geo/resolve';

// Каскад резолва адреса (ТЗ 13.10, «Адрес идеальный»): ссылка на карту /
// координаты / текст → кандидаты с точностью. Любая сессия: поле адреса потом
// появится и в сделках у менеджеров (BACKLOG «Окно адреса в каждой сделке»).
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null) as { input?: unknown } | null;
  const input = typeof body?.input === 'string' ? body.input : '';
  return NextResponse.json(await resolveAddressInput(input));
}
