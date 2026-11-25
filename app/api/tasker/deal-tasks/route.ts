// Задачник: задачи по СДЕЛКЕ из дриллдауна отчёта (миграция 289, TASKER_SPEC.md «Задачи по сделкам»).
// GET ?dealIds=1,2 — снимки сделок для формы (в зоне ли менеджер, есть ли уже открытая задача);
// POST — поставить по задаче на сделку. Обе — с правом action.tasker.assign.
import { NextRequest, NextResponse } from 'next/server';
import { permError } from '@/lib/auth/perms';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse } from '@/features/tasker/engine/config';
import { createDealTasks, previewDeals } from '@/features/tasker/engine/dealTasks';
import { logTaskerCreated } from '@/lib/activity/services';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  const denied = permError(auth.session, 'action.tasker.assign');
  if (denied) return denied;
  try {
    return NextResponse.json(await previewDeals(auth.scope, req.nextUrl.searchParams.get('dealIds') ?? ''));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  const denied = permError(auth.session, 'action.tasker.assign');
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => null);
    const out = await createDealTasks(auth.session, auth.scope, body);
    void logTaskerCreated(auth.session, out.created, 'deal');
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
