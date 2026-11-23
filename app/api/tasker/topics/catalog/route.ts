// Задачник: из чего собирать темы — метрики каталога отчётов и товарные группы (шкала kc). Право action.tasker.templates.
import { NextResponse } from 'next/server';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse } from '@/features/tasker/engine/config';
import { canManageTemplates } from '@/features/tasker/engine/templates';
import { topicCatalog } from '@/features/tasker/engine/topics';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  if (!canManageTemplates(auth.session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    return NextResponse.json(await topicCatalog());
  } catch (e) {
    return errorResponse(e);
  }
}
