import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { getSessionScope } from '@/lib/org/sessionScope';
import { scopeShortLogins } from '@/lib/org/shortLoginScope';

interface ImportItem {
  login: string;
  amount: number;
}

export async function POST(request: Request) {
  const session = await getSession();
  const denied = permError(session, 'action.plans.edit');
  if (denied) return denied;

  const body = await request.json() as { month: string; items: ImportItem[]; plan_n: number };
  const { month, items, plan_n } = body;

  if (!month || !items?.length) {
    return NextResponse.json({ saved: 0, skipped: [] });
  }

  // Аудит 09.09 («Главные дыры» п.6): подтверждение импорта писало план любому
  // логину из тела запроса. Логины вне среза сессии отбрасываем и перечисляем в
  // skipped (первый шаг импорта их уже не предлагает, но тело — от клиента).
  const allowedLogins = await scopeShortLogins(await getSessionScope(session!));
  const skipped: string[] = [];

  const monthDate = `${month}-01`;
  const db = systemDb();

  let saved = 0;
  for (const item of items) {
    if (allowedLogins !== null && !allowedLogins.has(item.login)) {
      skipped.push(item.login);
      continue;
    }
    await db.query(
      `INSERT INTO manager_plans (manager_login, month, plan_shipments, plan_n, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (manager_login, month)
       DO UPDATE SET plan_shipments = EXCLUDED.plan_shipments, plan_n = EXCLUDED.plan_n, updated_at = NOW()`,
      [item.login, monthDate, item.amount, plan_n],
    );
    saved++;
  }

  return NextResponse.json({ saved, skipped });
}
