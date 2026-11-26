import { NextRequest, NextResponse } from 'next/server';
import { myTestDetail, saveAnswers, startAttempt } from '@/features/tasker/tests/engine';
import type { MyTestDetailResponse } from '@/features/tasker/tests/types';
import { badId, NO_STORE, parseId, withSelf } from '../../_shared';

// Прохождение теста менеджером (id = назначение). GET — состояние; POST { action: start | save | submit, answers? }.
export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return badId();
  return withSelf('my one', async s => NextResponse.json((await myTestDetail(s, id)) satisfies MyTestDetailResponse, { headers: NO_STORE }));
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return badId();
  return withSelf('my action', async s => {
    const b = (await req.json().catch(() => null)) as { action?: string; answers?: unknown } | null;
    const out = b?.action === 'start' ? await startAttempt(s, id)
      : b?.action === 'save' || b?.action === 'submit' ? await saveAnswers(s, id, b.answers, b.action === 'submit')
      : null;
    if (!out) return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
    return NextResponse.json(out satisfies MyTestDetailResponse);
  });
}
