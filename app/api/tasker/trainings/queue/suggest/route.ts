import { NextRequest, NextResponse } from 'next/server';
import { suggest } from '@/features/tasker/trainings/engine/queue';
import type { TrainingSuggestRequest, TrainingSuggestResponse } from '@/features/tasker/trainings/types';
import { NO_STORE, withTrainingActor } from '../../_shared';

// Ближайшие свободные слоты сетки тренера под группу по теме (только тренер).
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return withTrainingActor('queue suggest', async actor => {
    const b = (await req.json().catch(() => null) ?? {}) as Partial<TrainingSuggestRequest>;
    const suggestions = await suggest(actor, String(b.metricId ?? ''), b.taskIds, b.limit);
    return NextResponse.json({ suggestions } satisfies TrainingSuggestResponse, { headers: NO_STORE });
  });
}
