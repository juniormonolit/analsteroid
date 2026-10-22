import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { createTag, fetchVisibleTagDefs, TagError, updateTag } from '@/features/repeat-kanban/engine/tags';

// Словарь тегов заказчиков (миграция 245): базовые — для всех, личные — свои у каждого аккаунта.
// Здесь только словарь; поставить тег заказчику — POST /api/repeat-kanban { action: 'set_tags' }.
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    return NextResponse.json({ tags: await fetchVisibleTagDefs(session.id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[repeat-kanban tags]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось загрузить теги' }, { status: 500 });
  }
}

/** { action: 'create', name, color } | { action: 'update', id, name?, color? } | { action: 'delete', id } — только свои. */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  try {
    if (body?.action === 'create') return NextResponse.json({ ok: true, tag: await createTag(session, body.name, body.color) });
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Не указан тег' }, { status: 400 });
    if (body?.action === 'update') { await updateTag(session, id, { name: body.name, color: body.color }); return NextResponse.json({ ok: true }); }
    if (body?.action === 'delete') { await updateTag(session, id, { remove: true }); return NextResponse.json({ ok: true }); }
    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
  } catch (e) {
    if (e instanceof TagError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error('[repeat-kanban tags POST]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось сохранить тег' }, { status: 500 });
  }
}
