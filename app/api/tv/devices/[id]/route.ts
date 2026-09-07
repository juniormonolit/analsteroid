import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { departmentNameMap, screenInScope, tvScope } from '@/features/tv/engine/access';
import { deviceScreenId, getScreen, unpairDevice, updateDeviceLabel } from '@/features/tv/engine/store';

type Ctx = { params: Promise<{ id: string }> };

async function guard(deviceId: string) {
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return { denied };
  const screenId = await deviceScreenId(deviceId);
  if (!screenId) return { denied: NextResponse.json({ error: 'Телевизор не найден или уже отвязан' }, { status: 404 }) };
  const names = await departmentNameMap();
  const screen = await getScreen(screenId, names);
  const scope = await tvScope(session!);
  if (!screen || !screenInScope(scope, screen.departmentIds)) return { denied: NextResponse.json({ error: 'Телевизор вне вашей зоны ответственности' }, { status: 403 }) };
  return { screenId, names };
}

// Подпись телевизора («где висит»).
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const g = await guard(id);
  if (g.denied) return g.denied;
  const body = await req.json().catch(() => ({}));
  const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null;
  await updateDeviceLabel(id, label);
  return NextResponse.json({ screen: await getScreen(g.screenId!, g.names!) });
}

// Отвязать: телевизор при следующем опросе покажет новый код привязки.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const g = await guard(id);
  if (g.denied) return g.denied;
  await unpairDevice(id);
  return NextResponse.json({ screen: await getScreen(g.screenId!, g.names!) });
}
