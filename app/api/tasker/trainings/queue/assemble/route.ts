import { NextRequest, NextResponse } from 'next/server';
import { assemble } from '@/features/tasker/trainings/engine/queue';
import { withTrainingActor } from '../../_shared';

// «Собрать занятие»: событие обучения + запись менеджеров выбранных задач + связь задач с событием (только тренер).
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return withTrainingActor('queue assemble', async actor => NextResponse.json(await assemble(actor, await req.json().catch(() => null))));
}
