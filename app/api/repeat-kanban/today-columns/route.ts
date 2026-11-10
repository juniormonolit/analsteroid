import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { createColumn, CustomColumnError, deleteColumn, updateColumn } from '@/features/repeat-kanban/engine/customColumns';

// «Свои колонки» во вкладке «Сегодня» (10.11, миграция 262). Список и колонки приходят с доской (GET /api/repeat-kanban),
// здесь — изменения: POST { name, filters, alert?, shared? } — создать (не больше 5 своих); PATCH { id, … } — изменить
// свою; DELETE ?id= — удалить свою. Предпросмотр — GET /api/repeat-kanban?colPreview=…
export const dynamic = 'force-dynamic';

async function guard() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!hasPerm(session, 'section.repeat_kanban')) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}
const fail = (e: unknown, what: string) => {
  if (e instanceof CustomColumnError) return NextResponse.json({ error: e.message }, { status: 400 });
  console.error(`[repeat-kanban today-columns ${what}]`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: 'Не удалось сохранить колонку' }, { status: 500 });
};

export async function POST(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  try { return NextResponse.json({ ok: true, column: await createColumn(g.session, body) }); } catch (e) { return fail(e, 'POST'); }
}

export async function PATCH(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const id = Number(body?.id);
  if (!body || !Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Не указана колонка' }, { status: 400 });
  try { await updateColumn(g.session, id, body); return NextResponse.json({ ok: true }); } catch (e) { return fail(e, 'PATCH'); }
}

export async function DELETE(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const id = Number(req.nextUrl.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Не указана колонка' }, { status: 400 });
  try { await deleteColumn(g.session, id); return NextResponse.json({ ok: true }); } catch (e) { return fail(e, 'DELETE'); }
}
