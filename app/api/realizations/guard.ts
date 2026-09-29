import { NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { canViewRealizations } from '@/lib/realizations/access';

// Серверный гейт всех /api/realizations/* (задача #8034): нет сессии → 401,
// не «Администратор» → 403. Скрытие пункта меню — только косметика.
export async function guardRealizations(): Promise<{ session: SessionUser } | { res: NextResponse }> {
  const session = await getSession();
  if (!session) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!canViewRealizations(session)) {
    return { res: NextResponse.json({ error: 'Недостаточно прав: раздел «Реализация» доступен только роли «Администратор»' }, { status: 403 }) };
  }
  return { session };
}
