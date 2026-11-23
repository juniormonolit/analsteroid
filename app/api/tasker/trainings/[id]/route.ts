import { NextRequest, NextResponse } from 'next/server';
import { cancelEvent, getEvent, updateEvent } from '@/features/tasker/trainings/engine';
import type { TrainingEventResponse } from '@/features/tasker/trainings/types';
import { NO_STORE, parseId, withTrainingActor } from '../_shared';

// Одно обучение. GET — все; PATCH/DELETE — тренер. DELETE = отмена (cancelled_at), записи остаются.
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };
const bad = () => NextResponse.json({ error: 'Некорректный id', code: 'bad_request' }, { status: 400 });

export async function GET(_req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return bad();
  return withTrainingActor('GET id', async actor =>
    NextResponse.json({ event: await getEvent(actor, id) } satisfies TrainingEventResponse, { headers: NO_STORE }));
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return bad();
  return withTrainingActor('PATCH', async actor =>
    NextResponse.json({ event: await updateEvent(actor, id, await req.json().catch(() => null)) } satisfies TrainingEventResponse));
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return bad();
  return withTrainingActor('DELETE', async actor =>
    NextResponse.json({ event: await cancelEvent(actor, id) } satisfies TrainingEventResponse));
}
