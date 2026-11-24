// Общее для роутов app/api/dismissal/**: гейт canUseDismissal в КАЖДОМ роуте и единый формат ошибок { error }.
import { NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { canUseDismissal } from '../access';
import { canDismiss, canSeeRun, dismissalScope, planScopeError, type DismissalScope } from './scope';
import type { DismissalRunDetail, DismissalUser } from '../types';
import { DismissalError, getRunDetail, getRunRow, type PlanCheck } from './store';
import { userNameMap } from './users';

export async function dismissalGuard(): Promise<{ session: SessionUser; error?: undefined } | { error: NextResponse; session?: undefined }> {
  const session = await getSession().catch(() => null);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!canUseDismissal(session)) return { error: NextResponse.json({ error: 'Только для администратора, директора и РОПа' }, { status: 403 }) };
  return { session };
}

export function dismissalFail(e: unknown, where: string): NextResponse {
  if (e instanceof DismissalError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error(`[dismissal] ${where}:`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: e instanceof Error ? e.message : 'Внутренняя ошибка' }, { status: 500 });
}

/** Гейт + срез инициатора по иерархии (scope.ts). */
export async function dismissalScopedGuard(): Promise<{ session: SessionUser; scope: DismissalScope; error?: undefined } | { error: NextResponse; session?: undefined; scope?: undefined }> {
  const g = await dismissalGuard();
  if (g.error) return g;
  try {
    return { session: g.session, scope: await dismissalScope(g.session) };
  } catch (e) {
    return { error: dismissalFail(e, 'scope') };
  }
}

/** Прогон вне среза инициатора — 404 (как несуществующий: не подтверждаем, что он есть). */
export async function assertRunInScope(id: string, scope: DismissalScope): Promise<void> {
  const run = await getRunRow(id);
  if (!run || !canSeeRun(scope, Number(run.source_bitrix_id))) throw new DismissalError('Прогон не найден', 404);
}

/** Проверка получателей плана по срезу — для savePlan / startRun. */
export function planCheckFor(scope: DismissalScope): PlanCheck {
  return async (plan, runRop) => {
    if (scope.scope.kind === 'all') return null;
    const ids = [...Object.values(plan.rules).flatMap(r => r?.targets ?? []), ...Object.values(plan.overrides).map(o => o?.target ?? 0), plan.ropBitrixId ?? 0];
    const names = await userNameMap(ids).catch(() => ({} as Record<number, string>));
    return planScopeError(scope, plan, runRop, id => names[id] ?? `#${id}`);
  };
}

/** dismissable у людей в ответе — по срезу текущего инициатора (в БД source хранится без него). */
export function withDismissable<T extends DismissalUser | null>(u: T, scope: DismissalScope): T {
  return (u ? { ...u, dismissable: canDismiss(scope, u.bitrixId) } : u) as T;
}

/** Детали прогона для ответа роута (404, если исчез). */
export async function scopedRunDetail(id: string, scope: DismissalScope): Promise<DismissalRunDetail> {
  const d = await getRunDetail(id);
  if (!d) throw new DismissalError('Прогон не найден', 404);
  return { ...d, source: withDismissable(d.source, scope), rop: withDismissable(d.rop, scope) };
}
