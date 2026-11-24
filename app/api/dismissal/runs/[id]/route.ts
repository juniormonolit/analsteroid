import { NextRequest, NextResponse } from 'next/server';
import { assertRunInScope, dismissalFail, dismissalScopedGuard, planCheckFor, scopedRunDetail } from '@/features/dismissal/engine/http';
import { savePlan } from '@/features/dismissal/engine/store';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// v3: прогон вне среза инициатора — 404; получатели плана — в пределах среза (РОП уволенного — всегда).
export async function GET(_req: NextRequest, ctx: Ctx) {
  const g = await dismissalScopedGuard();
  if (g.error) return g.error;
  try {
    const id = (await ctx.params).id;
    await assertRunInScope(id, g.scope);
    return NextResponse.json(await scopedRunDetail(id, g.scope));
  } catch (e) {
    return dismissalFail(e, 'run get');
  }
}

/** Правила и исключения — только в черновике. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const g = await dismissalScopedGuard();
  if (g.error) return g.error;
  const id = (await ctx.params).id;
  const body = await req.json().catch(() => ({})) as { plan?: unknown };
  try {
    await assertRunInScope(id, g.scope);
    await savePlan(id, body.plan, planCheckFor(g.scope));
    return NextResponse.json(await scopedRunDetail(id, g.scope));
  } catch (e) {
    return dismissalFail(e, 'run plan');
  }
}
