import { NextRequest, NextResponse } from 'next/server';
import { repeatEvent } from '@/features/tasker/trainings/engine/approve';
import { parseId, withTrainingActor } from '../../_shared';

// «Повторить занятие» (собрание 26.11, п.7) — только тренер: тот же состав и тема в новое время.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = parseId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: 'Некорректный id', code: 'bad_request' }, { status: 400 });
  return withTrainingActor('repeat', async actor => NextResponse.json(await repeatEvent(actor, id, await req.json().catch(() => null))));
}
