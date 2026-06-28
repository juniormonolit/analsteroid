import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import * as XLSX from 'xlsx';

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const deptIdsParam = searchParams.get('deptIds');
  const deptIds = deptIdsParam ? deptIdsParam.split(',').map(s => s.trim()).filter(Boolean) : [];

  const db = systemDb();

  let rows: { short_login: string; manager_name: string }[];
  if (deptIds.length > 0) {
    const res = await db.query<{ short_login: string; manager_name: string }>(
      `SELECT orh.short_login, orh.manager_name
       FROM org_resolved_hierarchy orh
       LEFT JOIN departments d ON d.id::text = orh.department_id::text
       WHERE orh.is_active = true AND d.bitrix_department_id = ANY($1)
       ORDER BY orh.manager_name`,
      [deptIds],
    );
    rows = res.rows;
  } else {
    const res = await db.query<{ short_login: string; manager_name: string }>(
      `SELECT short_login, manager_name FROM org_resolved_hierarchy WHERE is_active = true ORDER BY manager_name`,
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
