import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { canSeeManager, getSessionScope } from '@/lib/org/sessionScope';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Аудит 09.09 («Главные дыры» п.1, п.4): ростер для планов отдавал всех
  // сотрудников компании любой сессии. Режем по менеджерам среза (админ — все).
  const scope = await getSessionScope(session);

  // Оргструктура переехала в sa (задача Серёги 13.07): читаем из analyticsDb.
  const db = analyticsDb();
  const res = await db.query<{
    short_login: string;
    manager_name: string;
    manager_id: string | null;
    department_bitrix_id: string | null;
    team_id: string | null;
    team_name: string | null;
  }>(`
    SELECT
      orh.short_login,
      orh.manager_name,
      orh.manager_bitrix_user_id::text AS manager_id,
      d.bitrix_department_id AS department_bitrix_id,
      d.id::text AS team_id,
      d.name AS team_name
    FROM sa.org_resolved_hierarchy orh
    LEFT JOIN sa.departments d ON d.id::text = orh.department_id::text AND d.is_active = true
    WHERE orh.is_active = true
    ORDER BY orh.manager_name
  `);

  return NextResponse.json(res.rows
    .filter(r => canSeeManager(scope, r.manager_id))
    .map(r => ({
      short_login: r.short_login,
      full_name: r.manager_name,
      department_bitrix_id: r.department_bitrix_id,
      team_id: r.team_id,
      team_name: r.team_name,
    })));
}
