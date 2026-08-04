import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// История подтверждений пином (задача #2995, спека §7) — вкладка «История
// подтверждений» в ЛК. Сотрудник видит свои события; админ (action.users.manage)
// может посмотреть чужие через ?userId=. НИКОГДА не отдаём пин/хеш/перец — их
// в wallet_pin_events и не пишем.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const requestedUserId = req.nextUrl.searchParams.get('userId');
  let targetUserId = session.id;
  if (requestedUserId && requestedUserId !== session.id) {
    if (!hasPerm(session, 'action.users.manage')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    targetUserId = requestedUserId;
  }

  const res = await systemDb().query(
    `SELECT id::int AS id, event, operation, target_ref, amount, currency,
            threshold_before, threshold_after, surface, ip::text AS ip, actor_login,
            to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS at
       FROM wallet_pin_events
      WHERE user_id = $1
      ORDER BY id DESC
      LIMIT 200`,
    [targetUserId],
  );
  return NextResponse.json({ events: res.rows });
}
