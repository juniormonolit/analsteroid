import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { departmentNameMap, screenInScope, tvScope } from '@/features/tv/engine/access';
import { getScreen, pairDeviceByCode } from '@/features/tv/engine/store';
import { rateLimited, tooMany } from '@/features/tv/engine/rateLimit';

// Привязка телевизора по коду с его экрана. Лимит попыток на пользователя —
// 20 в 10 минут: кодов 32^4 ≈ 1 млн живых не более 20 минут, перебор бессмыслен.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return denied;
  if (rateLimited(`tv:pair:${session!.id}`, 20, 600)) return tooMany();
  const names = await departmentNameMap();
  const screen = await getScreen(id, names);
  if (!screen) return NextResponse.json({ error: 'Экран не найден' }, { status: 404 });
  const scope = await tvScope(session!);
  if (!screenInScope(scope, screen.departmentIds)) return NextResponse.json({ error: 'Экран вне вашей зоны ответственности' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const code = String(body?.code ?? '');
  const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null;
  const deviceId = await pairDeviceByCode(code, id, label);
  if (!deviceId) return NextResponse.json({ error: 'Код не найден или истёк — посмотрите на телевизор, там актуальный' }, { status: 404 });
  return NextResponse.json({ ok: true, deviceId, screen: await getScreen(id, names) });
}
