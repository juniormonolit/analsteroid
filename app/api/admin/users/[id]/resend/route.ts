import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { createAndSendInvite } from '@/lib/invites/tokens';
import { getPublicOrigin } from '@/lib/http/publicOrigin';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'action.users.manage');
  if (denied) return denied;

  const { id } = await params;
  const db = systemDb();

  const res = await db.query<{ display_name: string; bitrix_user_id: string | null; is_active: boolean }>(
    `SELECT display_name, bitrix_user_id, is_active FROM users WHERE id = $1`,
    [id]
  );
  const user = res.rows[0];
  if (!user) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });
  if (user.is_active) return NextResponse.json({ error: 'Пользователь уже активен' }, { status: 400 });
  if (!user.bitrix_user_id) return NextResponse.json({ error: 'У пользователя не привязан Bitrix' }, { status: 400 });

  try {
    await createAndSendInvite(id, user.bitrix_user_id, user.display_name, getPublicOrigin(req));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Не удалось отправить приглашение в Bitrix' },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
