// Задачник: сессии РОПа (подсказка «у вас уже есть сессия по этой теме — добавить туда?»).
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth, intParam, ymdParam } from '@/features/tasker/engine/http';
import { listSessions } from '@/features/tasker/engine/repo';
import { errorResponse } from '@/features/tasker/engine/config';
import type { TaskerSessionsResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  const sp = req.nextUrl.searchParams;
  try {
    const out: TaskerSessionsResponse = {
      sessions: await listSessions(auth.session, auth.scope, {
        ropId: intParam(sp.get('ropId')), metricId: sp.get('metricId'), from: ymdParam(sp.get('from')), to: ymdParam(sp.get('to')),
      }),
    };
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
