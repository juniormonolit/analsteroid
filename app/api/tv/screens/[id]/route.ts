import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { departmentNameMap, screenInScope, tvScope } from '@/features/tv/engine/access';
import { deleteScreen, getScreen, updateScreen } from '@/features/tv/engine/store';
import { parseScreenInput } from '@/features/tv/engine/validate';

type Ctx = { params: Promise<{ id: string }> };

async function guard(id: string) {
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return { denied };
  const names = await departmentNameMap();
  const screen = await getScreen(id, names);
  if (!screen) return { denied: NextResponse.json({ error: 'Экран не найден' }, { status: 404 }) };
  const scope = await tvScope(session!);
  if (!screenInScope(scope, screen.departmentIds)) return { denied: NextResponse.json({ error: 'Экран вне вашей зоны ответственности' }, { status: 403 }) };
  return { session: session!, screen, scope, names };
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const g = await guard(id);
  if (g.denied) return g.denied;
  return NextResponse.json({ screen: g.screen });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const g = await guard(id);
  if (g.denied) return g.denied;
  const input = parseScreenInput(await req.json().catch(() => ({})));
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });
  if (!screenInScope(g.scope!, input.departmentIds)) {
    return NextResponse.json({ error: 'Среди выбранных есть отделы вне вашей зоны ответственности' }, { status: 403 });
  }
  await updateScreen(id, input);
  return NextResponse.json({ screen: await getScreen(id, g.names!) });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const g = await guard(id);
  if (g.denied) return g.denied;
  await deleteScreen(id);
  return NextResponse.json({ ok: true });
}
