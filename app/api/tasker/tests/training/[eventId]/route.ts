import { NextRequest, NextResponse } from 'next/server';
import { assignTrainingNow, setTrainingTest } from '@/features/tasker/tests/engine';
import { badId, parseId, withTestActor } from '../../_shared';

// Тест к обучению (тренер): PUT { testId | null, afterDays, dueDays } — авто-назначение всем «был» через N дней;
// POST — назначить сейчас.
export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ eventId: string }> };

export async function PUT(req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).eventId);
  if (!id) return badId();
  return withTestActor('training link', async actor => NextResponse.json({ stats: await setTrainingTest(actor, id, await req.json().catch(() => null)) }));
}

export async function POST(_req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).eventId);
  if (!id) return badId();
  return withTestActor('training assign', async actor => NextResponse.json(await assignTrainingNow(actor, id)));
}
