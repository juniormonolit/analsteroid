import { NextResponse } from 'next/server';
import { dismissalFail, dismissalScopedGuard } from '@/features/dismissal/engine/http';
import { canDismiss, inScope, scopeDeptBitrixIds } from '@/features/dismissal/engine/scope';
import { listDismissalDepartments } from '@/features/dismissal/engine/users';

export const dynamic = 'force-dynamic';

// Отделы для «раскидать по отделу»: только активные сотрудники (тот же снимок user.get, что и /users).
// v3: только отделы среза инициатора (админ — все).
export async function GET() {
  const g = await dismissalScopedGuard();
  if (g.error) return g.error;
  try {
    const allowed = await scopeDeptBitrixIds(g.scope);
    const departments = (await listDismissalDepartments())
      .filter(d => !allowed || allowed.has(d.id))
      .map(d => ({ ...d, managers: d.managers.filter(m => inScope(g.scope, m.bitrixId)).map(m => ({ ...m, dismissable: canDismiss(g.scope, m.bitrixId) })) }))
      .filter(d => d.managers.length);
    return NextResponse.json({ departments });
  } catch (e) {
    return dismissalFail(e, 'departments');
  }
}
