import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// «Отметить всё прочитанным» (клик по пункту меню открывает панель — п.4 задачи —
// или клик по ссылке в шапке панели): переносит changelog_seen_at на текущий момент,
// счётчик непрочитанных в GET /api/changelog обнуляется.
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const res = await systemDb().query<{ changelog_seen_at: Date }>(
    `UPDATE users SET changelog_seen_at = now() WHERE id = $1 RETURNING changelog_seen_at`,
    [session.id]
  );
  return NextResponse.json({ ok: true, seenAt: res.rows[0]?.changelog_seen_at?.toISOString() ?? null });
}
