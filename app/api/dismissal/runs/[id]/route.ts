import { NextRequest, NextResponse } from 'next/server';
import { dismissalFail, dismissalGuard } from '@/features/dismissal/engine/http';
import { getRunDetail, savePlan } from '@/features/dismissal/engine/store';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const g = await dismissalGuard();
  if (g.error) return g.error;
  try {
    const d = await getRunDetail((await ctx.params).id);
    if (!d) return NextResponse.json({ error: 'Прогон не найден' }, { status: 404 });
    return NextResponse.json(d);
  } catch (e) {
    return dismissalFail(e, 'run get');
  }
}

/** Правила и исключения — только в черновике. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const g = await dismissalGuard();
  if (g.error) return g.error;
  const id = (await ctx.params).id;
  const body = await req.json().catch(() => ({})) as { plan?: unknown };
  try {
    await savePlan(id, body.plan);
    return NextResponse.json(await getRunDetail(id));
  } catch (e) {
    return dismissalFail(e, 'run plan');
  }
}
