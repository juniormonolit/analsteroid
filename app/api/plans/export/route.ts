import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { getSessionScope, scopeDeptIdsBitrix, scopeManagerIds } from '@/lib/org/sessionScope';
import * as XLSX from 'xlsx';

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const deptIdsParam = searchParams.get('deptIds');
  const requestedDeptIds = deptIdsParam ? deptIdsParam.split(',').map(s => s.trim()).filter(Boolean) : [];

  // Аудит 09.09 («Главные дыры» п.1): шаблон xlsx с полным ростером компании
  // скачивал любой залогиненный, а deptIds принимались на веру. deptIds здесь —
  // bitrix_department_id → пересекаем со срезом через scopeDeptIdsBitrix; без
  // deptIds — весь срез сессии (не вся компания); плюс всегда режем по менеджерам
  // среза (null = админ, без ограничения).
  const scope = await getSessionScope(session);
  const managerIds = scopeManagerIds(scope);
  const deptIds = requestedDeptIds.length > 0 ? await scopeDeptIdsBitrix(scope, requestedDeptIds) : null;

  // Оргструктура переехала в sa (задача Серёги 13.07): читаем из analyticsDb.
  const db = analyticsDb();

  let rows: { short_login: string; manager_name: string }[] = [];
  const nothingToShow = (requestedDeptIds.length > 0 && deptIds !== null && deptIds.length === 0)
    || (managerIds !== null && managerIds.length === 0);
  if (nothingToShow) {
    rows = [];
  } else if (deptIds !== null && deptIds.length > 0) {
    const res = await db.query<{ short_login: string; manager_name: string }>(
      `SELECT orh.short_login, orh.manager_name
       FROM sa.org_resolved_hierarchy orh
       LEFT JOIN sa.departments d ON d.id::text = orh.department_id::text
       WHERE orh.is_active = true AND d.bitrix_department_id = ANY($1)
         AND ($2::boolean OR orh.manager_bitrix_user_id::text = ANY($3::text[]))
       ORDER BY orh.manager_name`,
      [deptIds, managerIds === null, managerIds ?? []],
    );
    rows = res.rows;
  } else {
    const res = await db.query<{ short_login: string; manager_name: string }>(
      `SELECT short_login, manager_name FROM sa.org_resolved_hierarchy
        WHERE is_active = true
          AND ($1::boolean OR manager_bitrix_user_id::text = ANY($2::text[]))
        ORDER BY manager_name`,
      [managerIds === null, managerIds ?? []],
    );
    rows = res.rows;
  }

  const wb = XLSX.utils.book_new();
  const wsData = [
    ['Логин', 'Имя', 'Сумма'],
    ...rows.map(r => [r.short_login, r.manager_name, '']),
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, 'Планы');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  return new NextResponse(Buffer.from(buf), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="plans_template.xlsx"',
    },
  });
}
