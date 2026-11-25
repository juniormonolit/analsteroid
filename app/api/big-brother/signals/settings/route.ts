import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { canViewBigBrother } from '@/lib/activity/access';
import { loadDigestSettings, saveDigestSettings } from '@/features/big-brother/engine/signals/settings';

// Настройки еженедельного дайджеста (bot_channels.big_brother_digest). Читать — «директор и выше», менять — только
// админы (superadmin / Администратор): это рассылка бота.
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewBigBrother(session)) return NextResponse.json({ error: 'Нет доступа' }, { status: 403 });
  const [s, cand] = await Promise.all([
    loadDigestSettings(),
    // Кому можно слать: у кого есть доступ к разделу (директор / администратор / суперадмин) и Битрикс-id.
    systemDb().query<{ id: string; name: string; role: string | null }>(
      `SELECT DISTINCT ON (u.bitrix_user_id) u.bitrix_user_id::text AS id, COALESCE(u.display_name, u.login) AS name, r.name AS role
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.bitrix_user_id IS NOT NULL AND (u.is_superadmin OR r.name IN ('Администратор', 'Директор'))
        ORDER BY u.bitrix_user_id, u.is_superadmin DESC`,
    ).then(r => r.rows).catch(() => [] as { id: string; name: string; role: string | null }[]),
  ]);
  return NextResponse.json({
    ...s, canEdit: session.isSuperadmin || session.roleName === 'Администратор',
    candidates: cand.map(c => ({ value: c.id, label: c.name, hint: c.role ?? 'суперадмин' })),
  });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(session.isSuperadmin || session.roleName === 'Администратор')) {
    return NextResponse.json({ error: 'Настройки рассылки меняют только администраторы' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await saveDigestSettings(body));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Не сохранилось' }, { status: 400 });
  }
}
