import { NextResponse } from 'next/server';
import { queue } from '@/features/tasker/trainings/engine/queue';
import { NO_STORE, withTrainingActor } from '../_shared';

// Очередь тренера: открытые задачи «Теория» по показателям. Тренер и админ — все, РОП — свои менеджеры.
export const dynamic = 'force-dynamic';

export async function GET() {
  return withTrainingActor('queue GET', async actor => NextResponse.json(await queue(actor), { headers: NO_STORE }));
}
