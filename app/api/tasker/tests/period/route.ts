import { NextRequest, NextResponse } from 'next/server';
import { trainingTestPeriod } from '@/features/tasker/tests/engine';
import type { TrainingTestPeriodResponse } from '@/features/tasker/tests/types';
import { NO_STORE, withTestActor } from '../_shared';

// «Эффективность»: обучения за период с тестом — средний балл и доля сдавших. ?from&to=YYYY-MM-DD
export const dynamic = 'force-dynamic';
const D = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  return withTestActor('period', async actor => {
    const sp = req.nextUrl.searchParams;
    const from = sp.get('from'), to = sp.get('to');
    if (!from || !to || !D.test(from) || !D.test(to)) return NextResponse.json({ error: 'Нужны from и to' }, { status: 400 });
    return NextResponse.json({ rows: await trainingTestPeriod(actor, from, to) } satisfies TrainingTestPeriodResponse, { headers: NO_STORE });
  });
}
