import { NextRequest, NextResponse } from 'next/server';
import { effectiveness } from '@/features/tasker/trainings/engine/reports';
import { addDays } from '@/features/tasker/trainings/engine/effect';
import { mskToday } from '@/features/tasker/engine/config';
import { dateParam, NO_STORE, withTrainingActor } from '../_shared';

// Эффективность обучений за период (по дате события; по умолчанию — 90 дней): по тренерам, темам и показателям.
// Тренер/админ — по всем людям, РОП — по своим менеджерам, менеджер — по себе.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withTrainingActor('effectiveness', async actor => {
    const sp = req.nextUrl.searchParams;
    const to = dateParam(sp.get('to')) ?? mskToday();
    const from = dateParam(sp.get('from')) ?? addDays(to, -90);
    if (from > to) return NextResponse.json({ error: 'Начало периода позже конца', code: 'bad_request' }, { status: 400 });
    return NextResponse.json(await effectiveness(actor, from, to), { headers: NO_STORE });
  });
}
