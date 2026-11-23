import { NextRequest, NextResponse } from 'next/server';
import { saveSlots, slotsResponse } from '@/features/tasker/trainings/engine/slots';
import { NO_STORE, withTrainingActor } from '../_shared';

// Сетка тренера (миграция 281). GET — все с section.tasker (сетка в расписании); PUT — тренер, сохранение целиком.
export const dynamic = 'force-dynamic';

export async function GET() {
  return withTrainingActor('slots GET', async actor => NextResponse.json(await slotsResponse(actor), { headers: NO_STORE }));
}

export async function PUT(req: NextRequest) {
  return withTrainingActor('slots PUT', async actor => NextResponse.json(await saveSlots(actor, await req.json().catch(() => null))));
}
