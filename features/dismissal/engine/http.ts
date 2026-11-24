// Общее для роутов app/api/dismissal/**: гейт canUseDismissal в КАЖДОМ роуте и единый формат ошибок { error }.
import { NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { canUseDismissal } from '../access';
import { DismissalError } from './store';

export async function dismissalGuard(): Promise<{ session: SessionUser; error?: undefined } | { error: NextResponse; session?: undefined }> {
  const session = await getSession().catch(() => null);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!canUseDismissal(session)) return { error: NextResponse.json({ error: 'Только для администратора и директора' }, { status: 403 }) };
  return { session };
}

export function dismissalFail(e: unknown, where: string): NextResponse {
  if (e instanceof DismissalError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error(`[dismissal] ${where}:`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: e instanceof Error ? e.message : 'Внутренняя ошибка' }, { status: 500 });
}
