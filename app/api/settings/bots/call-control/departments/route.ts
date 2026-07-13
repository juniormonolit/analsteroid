import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Получатели эскалации по отделам: оргструктура (РОП/директор департамента) +
// ручные переопределения (call_control_recipient_overrides, миграция 100).
// GET — таблица для админки; PUT — назначить/сбросить переопределение.

export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const db = systemDb();
  const res = await db.query(
    `WITH depts AS (
       SELECT DISTINCT ON (department_id)
         department_id, department_name,
         rop_bitrix_user_id, rop_name,
         department_director_bitrix_user_id, department_director_name
       FROM org_resolved_hierarchy
       WHERE is_active AND department_id IS NOT NULL
       ORDER BY department_id, rop_bitrix_user_id NULLS LAST, department_director_bitrix_user_id NULLS LAST
     ),
     names AS (
       SELECT DISTINCT ON (manager_bitrix_user_id) manager_bitrix_user_id, manager_name
       FROM org_resolved_hierarchy
       ORDER BY manager_bitrix_user_id, is_active DESC
     )
     SELECT d.department_id, d.department_name,
            d.rop_bitrix_user_id, d.rop_name,
            d.department_director_bitrix_user_id, d.department_director_name,
            o_rop.bitrix_user_id  AS rop_override_id,
            n_rop.manager_name    AS rop_override_name,
            o_dir.bitrix_user_id  AS director_override_id,
            n_dir.manager_name    AS director_override_name
     FROM depts d
     LEFT JOIN call_control_recipient_overrides o_rop
       ON o_rop.department_id = d.department_id AND o_rop.role = 'rop'
     LEFT JOIN names n_rop ON n_rop.manager_bitrix_user_id = o_rop.bitrix_user_id
     LEFT JOIN call_control_recipient_overrides o_dir
       ON o_dir.department_id = d.department_id AND o_dir.role = 'department_director'
     LEFT JOIN names n_dir ON n_dir.manager_bitrix_user_id = o_dir.bitrix_user_id
     ORDER BY d.department_name`
  );
  return NextResponse.json({ departments: res.rows });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const body = await req.json().catch(() => null) as
    { departmentId?: string; role?: string; bitrixUserId?: string | null } | null;
  if (!body?.departmentId || !/^[0-9a-f-]{36}$/i.test(body.departmentId)) {
    return NextResponse.json({ error: 'departmentId: uuid' }, { status: 400 });
  }
  if (body.role !== 'rop' && body.role !== 'department_director') {
    return NextResponse.json({ error: 'role: rop|department_director' }, { status: 400 });
  }
  const userId = (body.bitrixUserId ?? '').trim();
  if (userId && !/^\d+$/.test(userId)) {
    return NextResponse.json({ error: 'bitrixUserId: число или null (сброс на авто)' }, { status: 400 });
  }

  const db = systemDb();
  if (!userId) {
    await db.query(
      `DELETE FROM call_control_recipient_overrides WHERE department_id = $1 AND role = $2`,
      [body.departmentId, body.role]
    );
  } else {
    await db.query(
      `INSERT INTO call_control_recipient_overrides (department_id, role, bitrix_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (department_id, role) DO UPDATE SET bitrix_user_id = EXCLUDED.bitrix_user_id, updated_at = now()`,
      [body.departmentId, body.role, userId]
    );
  }
  return NextResponse.json({ ok: true });
}
