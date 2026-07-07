import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

interface ImportItem {
  login: string;
  amount: number;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json() as { month: string; items: ImportItem[]; plan_n: number };
  const { month, items, plan_n } = body;

  if (!month || !items?.length) {
    return NextResponse.json({ saved: 0 });
  }

  const monthDate = `${month}-01`;
  const db = systemDb();

  // Дедуп на случай дублей логина в одном файле: один batched UPSERT не может
  // затронуть одну и ту же строку (manager_login, month) дважды — Postgres кинет
  // "ON CONFLICT DO UPDATE command cannot affect row a second time". Сохраняем
  // семантику исходного последовательного цикла (await в цикле, было N round-trip'ов
  // к БД подряд) — при дубле логина побеждает последняя по порядку строка.
  const dedup = new Map<string, ImportItem>();
  for (const item of items) dedup.set(item.login, item);
  const deduped = [...dedup.values()];

  // Один batched UPSERT вместо N последовательных запросов. UNNEST разворачивает
  // два параллельных массива (login, amount) в набор строк за один round-trip.
  await db.query(
    `INSERT INTO manager_plans (manager_login, month, plan_shipments, plan_n, updated_at)
     SELECT login, $3::date, amount, $4, NOW()
     FROM UNNEST($1::text[], $2::numeric[]) AS t(login, amount)
     ON CONFLICT (manager_login, month)
     DO UPDATE SET plan_shipments = EXCLUDED.plan_shipments, plan_n = EXCLUDED.plan_n, updated_at = NOW()`,
    [deduped.map(i => i.login), deduped.map(i => i.amount), monthDate, plan_n],
  );

  return NextResponse.json({ saved: deduped.length });
}
