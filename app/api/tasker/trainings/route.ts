import { NextRequest, NextResponse } from 'next/server';
import { createEvent, listEvents } from '@/features/tasker/trainings/engine';
import type { TrainingEventResponse, TrainingsResponse } from '@/features/tasker/trainings/types';
import { dateParam, NO_STORE, withTrainingActor } from './_shared';

// Расписание обучений (TASKER_SPEC.md «Обучения»). GET — все с section.tasker;
// POST — только тренер (action.tasker.trainings.manage).
export const dynamic = 'force-dynamic';

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD&upcoming=1&includeCancelled=1 */
export async function GET(req: NextRequest) {
  return withTrainingActor('GET', async actor => {
    const sp = req.nextUrl.searchParams;
    const events = await listEvents(actor, {
      from: dateParam(sp.get('from')),
      to: dateParam(sp.get('to')),
      upcoming: sp.get('upcoming') === '1',
      includeCancelled: sp.get('includeCancelled') === '1',
    });
    const body: TrainingsResponse = { events, canManage: actor.canManage, canEnroll: actor.canEnroll };
    return NextResponse.json(body, { headers: NO_STORE });
  });
}

export async function POST(req: NextRequest) {
  return withTrainingActor('POST', async actor => {
    const event = await createEvent(actor, await req.json().catch(() => null));
    return NextResponse.json({ event } satisfies TrainingEventResponse);
  });
}
