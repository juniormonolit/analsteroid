import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { departmentNameMap, screenInScope, tvScope } from '@/features/tv/engine/access';
import { getScreen, updateScreenTicker } from '@/features/tv/engine/store';

// Бегущая строка конкретного экрана — быстрый рычаг из списка, без открытия
// редактора («мне нужно из админки въебать любую бегущую строку на любой телевизор»).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return denied;
  const names = await departmentNameMap();
  const screen = await getScreen(id, names);
  if (!screen) return NextResponse.json({ error: 'Экран не найден' }, { status: 404 });
  const scope = await tvScope(session!);
  if (!screenInScope(scope, screen.departmentIds)) return NextResponse.json({ error: 'Экран вне вашей зоны ответственности' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const text = typeof body?.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 500) : null;
  const deptId = typeof body?.deptId === 'string' && screen.departmentIds.includes(body.deptId) ? body.deptId : null;
  // «Показать» включает мастер-выключатель строк экрана; «Скрыть» с пустым текстом
  // общей строки выключает всё, пустой текст отдела — просто убирает строку отдела.
  const enabled = body?.enabled === true ? true : (deptId ? screen.tickerEnabled : false);
  await updateScreenTicker(id, text, enabled, deptId);
  return NextResponse.json({ screen: await getScreen(id, names) });
}
