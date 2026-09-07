import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { departmentNameMap, filterScreens, screenInScope, tvScope } from '@/features/tv/engine/access';
import { createScreen, listScreens, getScreen } from '@/features/tv/engine/store';
import { parseScreenInput } from '@/features/tv/engine/validate';

// Экраны телевизоров: список (в зоне ответственности) и создание.
export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return denied;
  const [scope, names] = await Promise.all([tvScope(session!), departmentNameMap()]);
  const screens = filterScreens(scope, await listScreens(names));
  return NextResponse.json({ screens, full: scope.full });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return denied;
  const input = parseScreenInput(await req.json().catch(() => ({})));
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });
  const scope = await tvScope(session!);
  if (!screenInScope(scope, input.departmentIds)) {
    return NextResponse.json({ error: 'Среди выбранных есть отделы вне вашей зоны ответственности' }, { status: 403 });
  }
  const id = await createScreen(input, session!.id);
  const screen = await getScreen(id, await departmentNameMap());
  return NextResponse.json({ screen }, { status: 201 });
}
