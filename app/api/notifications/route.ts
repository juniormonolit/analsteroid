import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// Уведомления ЛК (пакет Серёги 31.07): колокольчик со счётчиком непрочитанных.
// GET — последние 30 + unread; PATCH {id} / {all:true} — отметка прочтения.

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ notifications: [], unread: 0 });
  const id = Number(session.bitrixUserId);
  const db = systemDb();
  const [list, unread] = await Promise.all([
    db.query(
      `SELECT id::int AS id, type, title, body, link, (read_at IS NULL) AS unread,
              to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS at
         FROM notifications WHERE bitrix_id = $1 ORDER BY id DESC LIMIT 30`,
      [id],
    ),
    db.query<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE bitrix_id = $1 AND read_at IS NULL`, [id]),
  ]);
  return NextResponse.json({ notifications: list.rows, unread: Number(unread.rows[0]?.n ?? 0) });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ ok: true });
  let body: { id?: unknown; all?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const id = Number(session.bitrixUserId);
  if (body.all === true) {
    await systemDb().query(`UPDATE notifications SET read_at = now() WHERE bitrix_id = $1 AND read_at IS NULL`, [id]);
    return NextResponse.json({ ok: true });
  }
  if (typeof body.id !== 'number') return NextResponse.json({ error: 'id или all:true' }, { status: 400 });
  await systemDb().query(`UPDATE notifications SET read_at = now() WHERE id = $1 AND bitrix_id = $2`, [body.id, id]);
  return NextResponse.json({ ok: true });
}
