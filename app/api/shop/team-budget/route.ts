import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb, analyticsDb } from '@/lib/db/clients';
import { fetchTeamScope } from '@/features/shop/engine/teamScope';
import { fetchTeamBudget, fetchBudgetShare } from '@/features/shop/engine/teamBudget';

// Движения командного бюджета отдела (задача 11.08). Смотреть может только
// руководитель этого отдела: бюджет общий, но распоряжается им он, и это его
// инструмент планирования, а не публичная витрина.
//
// Имена тех, кто пополнил бюджет, живут в аналитической БД — тянем отдельно и
// мёржим в JS (кросс-БД, join невозможен).

export async function GET() {
  const session = await getSession();
  if (!session?.bitrixUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const team = await fetchTeamScope(session.bitrixUserId);
  if (!team.deptKey) {
    return NextResponse.json({ deptKey: null, deptName: null, size: 0, balance: 0, sharePct: 0, rows: [] });
  }

  const db = systemDb();
  const [balance, share, moves] = await Promise.all([
    fetchTeamBudget(db, team.deptKey),
    fetchBudgetShare(db),
    db.query<{ amount: string; source: string; bitrix_id: string | null; comment: string | null; created_at: string }>(
      `SELECT amount::text, source, bitrix_id::text, comment, created_at
         FROM team_budget_ledger WHERE dept_key = $1 ORDER BY created_at DESC LIMIT 60`,
      [team.deptKey],
    ).catch(() => ({ rows: [] as never[] })),
  ]);

  const ids = [...new Set(moves.rows.map(r => r.bitrix_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const nr = await analyticsDb().query<{ id: string; name: string }>(
      `SELECT DISTINCT manager_bitrix_user_id::text AS id, manager_name AS name
         FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id::text = ANY($1::text[])`,
      [ids],
    ).catch(() => ({ rows: [] as { id: string; name: string }[] }));
    for (const x of nr.rows) if (x.name) names.set(x.id, x.name);
  }

  return NextResponse.json({
    deptKey: team.deptKey, deptName: team.deptName, size: team.size,
    balance, sharePct: Math.round(share * 100),
    rows: moves.rows.map(r => ({
      amount: Number(r.amount), source: r.source,
      who: r.bitrix_id ? (names.get(r.bitrix_id) ?? r.bitrix_id) : null,
      comment: r.comment,
      at: new Date(r.created_at).toISOString(),
    })),
  });
}
