// Задачник: шаблоны рекомендаций. GET — активные варианты (форма задачи); ?all=1 — с архивом (редактор,
// право action.tasker.templates). POST — новый вариант или { action: 'reorder', metricId, ids }.
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse, loadTemplates } from '@/features/tasker/engine/config';
import { canManageTemplates, createTemplate, loadTemplatesFull, reorderTemplates } from '@/features/tasker/engine/templates';
import type { TaskerTemplatesFullResponse, TaskerTemplatesResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  const metricId = req.nextUrl.searchParams.get('metricId');
  try {
    if (req.nextUrl.searchParams.get('all') === '1') {
      const canEdit = canManageTemplates(auth.session);
      if (!canEdit) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      const out: TaskerTemplatesFullResponse = { templates: await loadTemplatesFull(metricId), canEdit };
      return NextResponse.json(out);
    }
    const out: TaskerTemplatesResponse = { templates: await loadTemplates(metricId) };
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
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [];
      await reorderTemplates(auth.session, String(body.metricId ?? ''), ids);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ template: await createTemplate(auth.session, body ?? {}) });
  } catch (e) {
    return errorResponse(e);
  }
}
