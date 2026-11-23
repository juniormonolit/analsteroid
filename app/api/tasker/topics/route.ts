// Задачник: темы задач (конструктор, миграция 282). GET — все темы с архивом; POST — новая тема
// или { action: 'reorder', ids }. Право action.tasker.templates (админ — и так).
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse, loadMetricDefs, publicMetric } from '@/features/tasker/engine/config';
import { canManageTemplates } from '@/features/tasker/engine/templates';
import { createTopic, reorderTopics } from '@/features/tasker/engine/topics';
import type { TaskerTopicsResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  if (!canManageTemplates(auth.session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const out: TaskerTopicsResponse = { topics: (await loadMetricDefs()).map(publicMetric), canEdit: true };
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  if (!canManageTemplates(auth.session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json().catch(() => null);
  try {
    if (body?.action === 'reorder') {
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean).slice(0, 500) : [];
      await reorderTopics(auth.session, ids);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ topic: await createTopic(auth.session, body ?? {}) });
  } catch (e) {
    return errorResponse(e);
  }
}
