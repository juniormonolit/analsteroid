// Задачник: шаблоны рекомендаций (2–3 на метрику).
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse, loadTemplates } from '@/features/tasker/engine/config';
import type { TaskerTemplatesResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    const out: TaskerTemplatesResponse = { templates: await loadTemplates(req.nextUrl.searchParams.get('metricId')) };
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
