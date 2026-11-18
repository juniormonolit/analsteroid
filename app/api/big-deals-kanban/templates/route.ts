import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { BigTemplateError, listTemplates, saveTemplates } from '@/features/big-deals-kanban/engine/templates';

// Шаблоны вопросов РОПа канбана больших чеков (users.ui_prefs.bigDealsTemplates, engine/templates.ts).
// GET — свои (или стартовый набор); PUT { templates } — заменить весь список (порядок = порядок кнопок).
export const dynamic = 'force-dynamic';

async function guard() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!hasPerm(session, 'section.repeat_kanban')) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}

export async function GET() {
  const g = await guard();
  if (g.error) return g.error;
  return NextResponse.json({ templates: await listTemplates(g.session.id) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PUT(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const body = await req.json().catch(() => null) as { templates?: unknown } | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, templates: await saveTemplates(g.session.id, body.templates) });
  } catch (e) {
    if (e instanceof BigTemplateError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error('[big-deals templates PUT]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось сохранить шаблоны' }, { status: 500 });
  }
}
