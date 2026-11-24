import { NextRequest, NextResponse } from 'next/server';
import { dismissalFail, dismissalScopedGuard, withDismissable } from '@/features/dismissal/engine/http';
import { canDismiss, canSeeRun } from '@/features/dismissal/engine/scope';
import { activeRunFor, createRun, listRuns } from '@/features/dismissal/engine/store';
import { findDismissalUser } from '@/features/dismissal/engine/users';
import { kickDismissalWorker } from '@/features/dismissal/engine/worker';

export const dynamic = 'force-dynamic';

/** v3: только прогоны по сотрудникам из среза инициатора (и не по нему самому). */
export async function GET() {
  const g = await dismissalScopedGuard();
  if (g.error) return g.error;
  try {
    const runs = (await listRuns()).filter(r => canSeeRun(g.scope, r.source.bitrixId))
      .map(r => ({ ...r, source: withDismissable(r.source, g.scope) }));
    return NextResponse.json({ runs });
  } catch (e) {
    return dismissalFail(e, 'runs list');
  }
}

/** Новый прогон (status=scanning; сбор — воркер). Незавершённый прогон по этому сотруднику уже есть — отдаём его id.
 *  v3: увольнять можно только сотрудника своего среза; админов/суперадминов и себя — никому (scope.ts). */
export async function POST(req: NextRequest) {
  const g = await dismissalScopedGuard();
  if (g.error) return g.error;
  const body = await req.json().catch(() => ({})) as { sourceBitrixId?: unknown };
  const sourceId = Number(body.sourceBitrixId);
  if (!Number.isInteger(sourceId) || sourceId <= 0) return NextResponse.json({ error: 'Не выбран сотрудник' }, { status: 400 });
  if (!canDismiss(g.scope, sourceId)) {
    const why = sourceId === g.scope.selfId ? 'Себя увольнять нельзя'
      : g.scope.protectedIds.has(sourceId) ? 'Администраторов и суперадминов Монолитики Увольнятор не трогает'
      : 'Сотрудник вне вашей иерархии — запустить Увольнятор на него нельзя';
    return NextResponse.json({ error: why }, { status: 403 });
  }
  try {
    const existing = await activeRunFor(sourceId);
    if (existing) return NextResponse.json({ id: existing, existing: true });
    const source = await findDismissalUser(sourceId);
    if (!source) return NextResponse.json({ error: `Пользователь Битрикса #${sourceId} не найден` }, { status: 400 });
    const s = g.session;
    const id = await createRun({ ...source, dismissable: true }, { login: s.login, name: s.displayName || s.login, bitrixId: Number(s.bitrixUserId) || null });
    kickDismissalWorker();
    return NextResponse.json({ id });
  } catch (e) {
    return dismissalFail(e, 'runs create');
  }
}
