import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { getSessionScope, scopeForbidden } from '@/lib/org/sessionScope';
import { canSeeShortLogin } from '@/lib/org/shortLoginScope';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ login: string; month: string }> },
) {
  const session = await getSession();
  const denied = permError(session, 'action.plans.edit');
  if (denied) return denied;

  const { login, month } = await params;

  // Аудит 09.09 («Главные дыры» п.6): право action.plans.edit давало правку плана
  // ЛЮБОГО сотрудника компании. Право остаётся, но логин цели обязан принадлежать
  // срезу сессии (login → bitrix id через оргструктуру → canSeeManager).
  if (!(await canSeeShortLogin(await getSessionScope(session!), login))) {
    return scopeForbidden('План этого сотрудника вам недоступен');
  }

  const body = await request.json() as { plan_shipments: number; plan_n: number };

  // month is YYYY-MM, store as YYYY-MM-01
  const monthDate = `${month}-01`;

  const db = systemDb();
  await db.query(
    `INSERT INTO manager_plans (manager_login, month, plan_shipments, plan_n, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (manager_login, month)
     DO UPDATE SET plan_shipments = EXCLUDED.plan_shipments, plan_n = EXCLUDED.plan_n, updated_at = NOW()`,
    [login, monthDate, body.plan_shipments, body.plan_n],
  );

  return NextResponse.json({ ok: true });
}
