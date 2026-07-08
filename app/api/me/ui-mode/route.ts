import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { effectiveUiMode } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Тумблер «Обычная/Про» из ЛК (п.3а спеки): серверное состояние per-user,
// переживает смену устройства/сессии. GET отдаёт ЭФФЕКТИВНЫЙ режим (с учётом
// дефолта по роли, если пользователь ещё не переключал сам); isOverride говорит,
// переключал ли он явно (для отображения состояния тумблера в ЛК).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({
    uiMode: effectiveUiMode(session),
    isOverride: session.uiMode !== null,
  });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const uiMode = body.uiMode;
  if (uiMode !== 'basic' && uiMode !== 'pro') {
    return NextResponse.json({ error: 'uiMode must be "basic" or "pro"' }, { status: 400 });
  }

  await systemDb().query(`UPDATE users SET ui_mode = $1 WHERE id = $2`, [uiMode, session.id]);
  return NextResponse.json({ uiMode });
}
