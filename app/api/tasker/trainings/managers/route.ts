import { NextResponse } from 'next/server';
import { listEnrollableManagers } from '@/features/tasker/trainings/engine';
import type { TrainingManagersResponse } from '@/features/tasker/trainings/types';
import { NO_STORE, withTrainingActor } from '../_shared';

// Кого текущий пользователь может записать на обучение (РОП — свои, директор — филиал, админ/тренер — все).
export const dynamic = 'force-dynamic';

export async function GET() {
  return withTrainingActor('managers', async actor =>
    NextResponse.json({ managers: await listEnrollableManagers(actor) } satisfies TrainingManagersResponse, { headers: NO_STORE }));
}
