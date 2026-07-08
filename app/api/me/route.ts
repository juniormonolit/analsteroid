import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { ensureAvatar } from '@/lib/bitrix/avatar';

// Профиль текущего пользователя для ЛК (/profile).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = systemDb();
  const [meta, deps] = await Promise.all([
    db.query<{ avatar_synced_at: Date | null }>(
      `SELECT avatar_synced_at FROM users WHERE id = $1`,
      [session.id]
    ),
    db.query<{ id: string; name: string }>(
      `SELECT d.id::text AS id, d.name
         FROM user_departments ud
         JOIN departments d ON d.id = ud.department_id
        WHERE ud.user_id = $1
        ORDER BY d.name`,
      [session.id]
    ),
  ]);

  // Лениво подтягиваем аватар из Битрикса (TTL 7 дней); свежий URL — сразу в ответ
  const freshUrl = await ensureAvatar(session.id, session.bitrixUserId, meta.rows[0]?.avatar_synced_at ?? null);

  return NextResponse.json({
    user: {
      login: session.login,
      displayName: session.displayName,
      roleName: session.isSuperadmin ? 'Супер-админ' : (session.roleName ?? 'Без роли'),
      avatarUrl: freshUrl ?? session.avatarUrl,
      bitrixUserId: session.bitrixUserId,
    },
    departments: deps.rows,
  });
}
