import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// «Масштаб таблиц» в ЛК (бриф 09.07, п.3): серверное состояние per-user (users.table_scale,
// migration 069), переживает смену устройства/сессии — тот же паттерн, что /api/me/ui-mode.
// Фиксированные шаги 85/100/115 (не свободный слайдер) — см. ProfilePage.
//
// НАМЕРЕННО не в lib/auth/session.ts (в отличие от ui_mode/sectionOverrides): та функция
// на общем кэшированном пути ЛЮБОГО запроса (все layout.tsx зовут getSession()) — если бы
// table_scale читался там, миграция 069 стала бы hard-блокером ВСЕГО сайта до её наката
// (колонки ещё нет). Отдельный SELECT здесь — при отсутствующей колонке падает только
// этот эндпоинт (и ЛК/чтение масштаба отчётов), не вся сессия/логин.
const ALLOWED = new Set([85, 100, 115]);

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const res = await systemDb().query<{ table_scale: number }>(
    `SELECT table_scale FROM users WHERE id = $1`,
    [session.id]
  );
  return NextResponse.json({ tableScale: res.rows[0]?.table_scale ?? 100 });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const tableScale = Number(body.tableScale);
  if (!ALLOWED.has(tableScale)) {
    return NextResponse.json({ error: 'tableScale must be 85, 100 or 115' }, { status: 400 });
  }

  await systemDb().query(`UPDATE users SET table_scale = $1 WHERE id = $2`, [tableScale, session.id]);
  return NextResponse.json({ tableScale });
}
