import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// Выбранные отделы — настройка АККАУНТА (users.selected_department_ids, миграция 102),
// применяется во всех отчётах (задача Иосифа 15.07). NULL/[] = все отделы.
// Отдельный SELECT, НЕ session.ts: миграция не должна быть блокером логина
// (тот же приём, что у table_scale — см. WORKLOG 09.07).

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = systemDb();
  const res = await db.query<{ selected_department_ids: string[] | null }>(
    `SELECT selected_department_ids FROM users WHERE id = $1`,
    [session.id]
  );
  return NextResponse.json({ departmentIds: res.rows[0]?.selected_department_ids ?? [] });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null) as { departmentIds?: unknown } | null;
  if (!body || !Array.isArray(body.departmentIds)) {
    return NextResponse.json({ error: 'departmentIds: массив id' }, { status: 400 });
  }
  const ids = body.departmentIds.map(String).filter(s => /^[\w-]{1,64}$/.test(s)).slice(0, 500);

  const db = systemDb();
  await db.query(
    `UPDATE users SET selected_department_ids = $2 WHERE id = $1`,
    [session.id, ids]
  );
  return NextResponse.json({ ok: true, departmentIds: ids });
}
