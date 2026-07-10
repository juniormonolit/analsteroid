import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// Тема оформления (ЛК, рядом с «Масштаб таблиц») — серверное состояние per-user
// (users.theme, migration 070), тот же паттерн, что /api/me/table-scale.
//
// НАМЕРЕННО не в lib/auth/session.ts (см. комментарий в table-scale/route.ts и в
// самой миграции 070) — getSession() на пути КАЖДОГО запроса, отдельный SELECT здесь
// падает только на этом эндпоинте, если колонки ещё нет (до наката миграции Артёмом).
const ALLOWED = new Set(['light', 'dark']);

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const res = await systemDb().query<{ theme: string }>(
    `SELECT theme FROM users WHERE id = $1`,
    [session.id]
  );
  return NextResponse.json({ theme: res.rows[0]?.theme ?? 'light' });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const theme = String(body.theme ?? '');
  if (!ALLOWED.has(theme)) {
    return NextResponse.json({ error: 'theme must be light or dark' }, { status: 400 });
  }

  await systemDb().query(`UPDATE users SET theme = $1 WHERE id = $2`, [theme, session.id]);
  return NextResponse.json({ theme });
}
