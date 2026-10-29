import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// Личные настройки интерфейса на аккаунте (users.ui_prefs, миграция 258). Владелец 29.10: «выбранный в канбане
// отдел должен сохраняться на аккаунте». Только свои (id из сессии). Ключи — белый список с проверкой значения;
// отдельный SELECT, как у table-scale: отсутствие колонки роняет только этот эндпоинт, не сессию.
const KEYS: Record<string, (v: unknown) => boolean> = {
  // Отделы канбана повторных: id подразделений (как в ?dept=), до 50.
  repeatKanbanDepts: v => Array.isArray(v) && v.length <= 50 && v.every(x => typeof x === 'string' && x.length > 0 && x.length < 80),
};

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await systemDb().query<{ ui_prefs: Record<string, unknown> | null }>(`SELECT ui_prefs FROM users WHERE id = $1`, [session.id])
    .catch(() => ({ rows: [] as { ui_prefs: Record<string, unknown> | null }[] }));
  return NextResponse.json({ prefs: r.rows[0]?.ui_prefs ?? {} }, { headers: { 'Cache-Control': 'no-store' } });
}

/** PATCH { key: value } — только известные ключи; null — удалить ключ. */
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  const set: Record<string, unknown> = {};
  const del: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (!KEYS[k]) return NextResponse.json({ error: `Неизвестная настройка: ${k}` }, { status: 400 });
    if (v === null) del.push(k);
    else if (KEYS[k](v)) set[k] = v;
    else return NextResponse.json({ error: `Некорректное значение: ${k}` }, { status: 400 });
  }
  await systemDb().query(`UPDATE users SET ui_prefs = (ui_prefs || $2::jsonb) - $3::text[] WHERE id = $1`, [session.id, JSON.stringify(set), del]);
  return NextResponse.json({ ok: true });
}
