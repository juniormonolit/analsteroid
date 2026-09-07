import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { departmentNameMap, filterScreens, tvScope } from '@/features/tv/engine/access';
import { createMessage, listMessages, listScreens } from '@/features/tv/engine/store';
import { parseMessageInput } from '@/features/tv/engine/validate';

// Рассылки на телевизоры. «На все экраны» (targetScreenIds = null) — только
// руководство (полный доступ); РОП адресует сообщения экранам своих отделов.
export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return denied;
  const [scope, names] = await Promise.all([tvScope(session!), departmentNameMap()]);
  const screens = await listScreens(names);
  const visible = new Set(filterScreens(scope, screens).map(s => s.id));
  const screenNames = new Map(screens.map(s => [s.id, s.name]));
  const all = await listMessages(screenNames);
  const messages = scope.full ? all : all.filter(m => m.targetScreenIds !== null && m.targetScreenIds.some(id => visible.has(id)));
  return NextResponse.json({ messages });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return denied;
  const parsed = parseMessageInput(await req.json().catch(() => ({})));
  if (typeof parsed === 'string') return NextResponse.json({ error: parsed }, { status: 400 });
  const [scope, names] = await Promise.all([tvScope(session!), departmentNameMap()]);
  if (parsed.targetScreenIds === null) {
    if (!scope.full) return NextResponse.json({ error: 'Рассылка на все экраны доступна только руководству' }, { status: 403 });
  } else {
    const visible = new Set(filterScreens(scope, await listScreens(names)).map(s => s.id));
    if (parsed.targetScreenIds.some(id => !visible.has(id))) {
      return NextResponse.json({ error: 'Среди адресатов есть экраны вне вашей зоны ответственности' }, { status: 403 });
    }
  }
  const id = await createMessage(parsed, parsed.endsAtDate, session!.id, session!.displayName);
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
