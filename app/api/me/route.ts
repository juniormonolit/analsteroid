import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { ensureAvatar } from '@/lib/bitrix/avatar';

// Профиль текущего пользователя для ЛК (/profile).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // users — в system; user_departments/departments переехали в sa (задача Серёги 13.07).
  const [meta, deps] = await Promise.all([
    systemDb().query<{ avatar_synced_at: Date | null }>(
      `SELECT avatar_synced_at FROM users WHERE id = $1`,
      [session.id]
    ),
    analyticsDb().query<{ id: string; name: string }>(
      `SELECT d.id::text AS id, d.name
         FROM sa.user_departments ud
         JOIN sa.departments d ON d.id = ud.department_id
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
      // Сырое имя роли (без замены на «Супер-админ») + флаг — карточка менеджера v2
      // (ФИФА-сетка «Мой отдел», «Моя карточка» МОП) гейтится по РОЛИ, не по
      // display-строке выше (см. features/profile/ui/ProfilePage.tsx).
      rawRoleName: session.roleName,
      isSuperadmin: session.isSuperadmin,
      avatarUrl: freshUrl ?? session.avatarUrl,
      bitrixUserId: session.bitrixUserId,
    },
    departments: deps.rows,
  });
}
