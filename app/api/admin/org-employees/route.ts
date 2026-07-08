import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'action.users.manage');
  if (denied) return denied;

  const db = systemDb();
  const res = await db.query<{
    bitrix_user_id: string;
    manager_name: string;
    department_name: string | null;
    short_login: string | null;
  }>(`
    SELECT
      orh.manager_bitrix_user_id::text AS bitrix_user_id,
      orh.manager_name,
      orh.department_name,
      orh.short_login
    FROM org_resolved_hierarchy orh
    WHERE orh.is_active = true
    ORDER BY orh.manager_name
  `);

  return NextResponse.json({ employees: res.rows });
}
