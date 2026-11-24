import { NextResponse } from 'next/server';
import { dismissalFail, dismissalGuard } from '@/features/dismissal/engine/http';
import { listDismissalUsers } from '@/features/dismissal/engine/users';

export const dynamic = 'force-dynamic';

// Пользователи Битрикса для выбора увольняемого и получателей (вкл. уволенных). Живой user.get, кэш 10 мин.
export async function GET() {
  const g = await dismissalGuard();
  if (g.error) return g.error;
  try {
    return NextResponse.json({ users: await listDismissalUsers() });
  } catch (e) {
    return dismissalFail(e, 'users');
  }
}
