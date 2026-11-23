import { NextRequest, NextResponse } from 'next/server';
import { resyncCalendar } from '@/features/tasker/trainings/engine';
import type { TrainingEventResponse } from '@/features/tasker/trainings/types';
import { parseId, withTrainingActor } from '../../_shared';

// Повтор синхронизации обучения с календарём тренера в Битриксе — только тренер.
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = parseId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: 'Некорректный id', code: 'bad_request' }, { status: 400 });
  return withTrainingActor('sync', async actor =>
    NextResponse.json({ event: await resyncCalendar(actor, id) } satisfies TrainingEventResponse));
}
