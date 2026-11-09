import { NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { canViewLogistKanban } from '@/features/logist-kanban/engine/access';

export async function guardLogistKanban(): Promise<{ session: SessionUser } | { res: NextResponse }> {
  const session = await getSession();
  if (!session) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!canViewLogistKanban(session)) {
    return { res: NextResponse.json({ error: 'Недостаточно прав: «Канбан логиста» открыт роли «Логист»' }, { status: 403 }) };
  }
  return { session };
}
