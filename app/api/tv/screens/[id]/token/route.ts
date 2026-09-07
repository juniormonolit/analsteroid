import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { departmentNameMap, screenInScope, tvScope } from '@/features/tv/engine/access';
import { getScreen, rotateScreenToken } from '@/features/tv/engine/store';

// Перевыпуск публичной ссылки экрана (старая перестаёт работать; привязанные по
// коду телевизоры не затрагиваются — они ходят по токену устройства).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return denied;
  const names = await departmentNameMap();
  const screen = await getScreen(id, names);
  if (!screen) return NextResponse.json({ error: 'Экран не найден' }, { status: 404 });
  const scope = await tvScope(session!);
  if (!screenInScope(scope, screen.departmentIds)) return NextResponse.json({ error: 'Экран вне вашей зоны ответственности' }, { status: 403 });
  const token = await rotateScreenToken(id);
  return NextResponse.json({ publicToken: token });
}
