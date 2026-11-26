import { NextRequest, NextResponse } from 'next/server';
import { createClosure, listClosures } from '@/features/tasker/trainings/engine/closures';
import { NO_STORE, dateParam, withTrainingActor } from '../_shared';

// Закрытое время тренера (миграция 299). GET — все с section.tasker (сетка, форма задачи); POST — тренер.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withTrainingActor('closures GET', async actor => {
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(await listClosures(actor, dateParam(sp.get('from')), dateParam(sp.get('to'))), { headers: NO_STORE });
  });
}

export async function POST(req: NextRequest) {
  return withTrainingActor('closures POST', async actor =>
    NextResponse.json({ closure: await createClosure(actor, await req.json().catch(() => null)) }));
}
