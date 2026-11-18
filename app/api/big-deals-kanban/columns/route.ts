import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { BigColumnError, createColumn, deleteColumn, listColumns, updateColumn } from '@/features/big-deals-kanban/engine/customColumns';

// Свои колонки «Сегодня» канбана больших чеков (users.ui_prefs.bigDealsColumns, до 5).
// GET — список; POST { name, filters: BigFilters } — создать; PATCH { id, name?, filters? }; DELETE ?id=.
// Колонки с карточками приходят и с доской (GET /api/big-deals-kanban → customColumns, today[custom:<id>]).
export const dynamic = 'force-dynamic';

async function guard() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!hasPerm(session, 'section.repeat_kanban')) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}
const fail = (e: unknown, what: string) => {
  if (e instanceof BigColumnError) return NextResponse.json({ error: e.message }, { status: 400 });
  console.error(`[big-deals-kanban columns ${what}]`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: 'Не удалось сохранить колонку' }, { status: 500 });
};
const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9]{4,40}$/i.test(v);

export async function GET() {
  const g = await guard();
  if (g.error) return g.error;
  return NextResponse.json({ columns: await listColumns(g.session.id) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  try { return NextResponse.json({ ok: true, column: await createColumn(g.session.id, body) }); } catch (e) { return fail(e, 'POST'); }
}

export async function PATCH(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !validId(body.id)) return NextResponse.json({ error: 'Не указана колонка' }, { status: 400 });
  try { return NextResponse.json({ ok: true, column: await updateColumn(g.session.id, body.id, body) }); } catch (e) { return fail(e, 'PATCH'); }
}

export async function DELETE(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const id = req.nextUrl.searchParams.get('id');
  if (!validId(id)) return NextResponse.json({ error: 'Не указана колонка' }, { status: 400 });
  try { await deleteColumn(g.session.id, id); return NextResponse.json({ ok: true }); } catch (e) { return fail(e, 'DELETE'); }
}
