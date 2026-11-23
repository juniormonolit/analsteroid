import { NextRequest, NextResponse } from 'next/server';
import { listEnrollments } from '@/features/tasker/trainings/engine';
import type { TrainingEnrollmentsResponse } from '@/features/tasker/trainings/types';
import { dateParam, NO_STORE, withTrainingActor } from '../_shared';

// Записи менеджеров на обучения — для «Недели»/«Сегодня» Задачника (сессия B) и /api/tasker/tasks (A).
// ?managerIds=1,2&from=YYYY-MM-DD&to=YYYY-MM-DD. managerIds режутся срезом сессии; пусто = весь срез.
// Отменённые события не отдаются.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withTrainingActor('enrollments', async actor => {
    const sp = req.nextUrl.searchParams;
    const managerIds = (sp.get('managerIds') ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
    const enrollments = await listEnrollments(actor, { managerIds, from: dateParam(sp.get('from')), to: dateParam(sp.get('to')) });
    return NextResponse.json({ enrollments } satisfies TrainingEnrollmentsResponse, { headers: NO_STORE });
  });
}
