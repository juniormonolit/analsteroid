import { NextResponse } from 'next/server';
import { dismissalFail, dismissalScopedGuard } from '@/features/dismissal/engine/http';
import { canDismiss, inScope } from '@/features/dismissal/engine/scope';
import { listDismissalUsers } from '@/features/dismissal/engine/users';

export const dynamic = 'force-dynamic';

// Пользователи Битрикса для выбора увольняемого и получателей (вкл. уволенных). Живой user.get, кэш 10 мин.
// v3: только сотрудники среза инициатора (админ — все); dismissable — кого он вправе увольнять (scope.ts).
export async function GET() {
  const g = await dismissalScopedGuard();
  if (g.error) return g.error;
  try {
    const users = (await listDismissalUsers())
      .filter(u => inScope(g.scope, u.bitrixId))
      .map(u => ({ ...u, dismissable: canDismiss(g.scope, u.bitrixId) }));
    return NextResponse.json({ users });
  } catch (e) {
    return dismissalFail(e, 'users');
  }
}
