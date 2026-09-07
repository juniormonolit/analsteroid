import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { departmentNameMap, filterScreens, tvScope } from '@/features/tv/engine/access';
import { getMessageTargets, listScreens, stopMessage } from '@/features/tv/engine/store';

// Снять сообщение с экранов (ends_at = сейчас; в истории остаётся).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return denied;
  const targets = await getMessageTargets(id);
  if (targets === undefined) return NextResponse.json({ error: 'Сообщение не найдено' }, { status: 404 });
  const scope = await tvScope(session!);
  if (!scope.full) {
    if (targets === null) return NextResponse.json({ error: 'Снять общую рассылку может только руководство' }, { status: 403 });
    const visible = new Set(filterScreens(scope, await listScreens(await departmentNameMap())).map(s => s.id));
    if (targets.some(t => !visible.has(t))) return NextResponse.json({ error: 'Сообщение адресовано экранам вне вашей зоны' }, { status: 403 });
  }
  await stopMessage(id);
  return NextResponse.json({ ok: true });
}
