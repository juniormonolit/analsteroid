import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { getSessionScope } from '@/lib/org/sessionScope';
import { scopeShortLogins } from '@/lib/org/shortLoginScope';

// Планы менеджеров. Аудит 09.09 («Главные дыры» п.1): роут отдавал планы ВСЕХ
// менеджеров любому залогиненному. Теперь — только логины среза сессии
// (админ — все); логин ↔ bitrix id через оргструктуру (lib/org/shortLoginScope.ts).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const allowedLogins = await scopeShortLogins(await getSessionScope(session));

  const db = systemDb();
  const res = await db.query<{
    manager_login: string;
    month: string;
    plan_shipments: string;
    plan_n: string;
  }>(
    `SELECT manager_login, to_char(month, 'YYYY-MM') as month, plan_shipments, plan_n
       FROM manager_plans
      WHERE $1::boolean OR manager_login = ANY($2::text[])
      ORDER BY month, manager_login`,
    [allowedLogins === null, allowedLogins ? [...allowedLogins] : []],
  );

  return NextResponse.json(
    res.rows.map(r => ({
      manager_login: r.manager_login,
      month: r.month,
      plan_shipments: parseFloat(r.plan_shipments),
      plan_n: parseFloat(r.plan_n),
    })),
  );
}
