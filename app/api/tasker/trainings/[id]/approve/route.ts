import { NextRequest, NextResponse } from 'next/server';
import { approveEvent } from '@/features/tasker/trainings/engine/approve';
import { parseId, withTrainingActor } from '../../_shared';

// «Утвердить состав и тему» (собрание 26.11, п.7) — только тренер: записанным уходит сообщение бота.
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = parseId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: 'Некорректный id', code: 'bad_request' }, { status: 400 });
  return withTrainingActor('approve', async actor => NextResponse.json(await approveEvent(actor, id)));
}
