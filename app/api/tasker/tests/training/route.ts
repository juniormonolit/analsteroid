import { NextRequest, NextResponse } from 'next/server';
import { trainingTestStats } from '@/features/tasker/tests/engine';
import type { TrainingTestStatsResponse } from '@/features/tasker/tests/types';
import { NO_STORE, withTestActor } from '../_shared';

// Тесты по обучениям: ?eventIds=1,2 → привязанный тест + средний балл и доля сдавших (в срезе пользователя).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withTestActor('training stats', async actor => {
    const ids = (req.nextUrl.searchParams.get('eventIds') ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
    return NextResponse.json({ stats: await trainingTestStats(actor, ids) } satisfies TrainingTestStatsResponse, { headers: NO_STORE });
  });
}
