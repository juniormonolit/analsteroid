import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Лог закрытий «Разгрузки отделов» (таблица offload_close_log, миграция 109) —
// последние 300 записей. Права те же, что раздел (section.offload).
export async function GET() {
  const session = await getSession();
  const err = permError(session, 'section.offload');
  if (err) return err;

  const res = await systemDb().query(
    `SELECT id, closed_at, closed_by_login, deal_id, deal_name, amount, kc_group,
            head_group, manager_name, department_name, work_days,
            priced_stagnant_days, probability, was_recommended, status, detail
       FROM offload_close_log
      ORDER BY closed_at DESC, id DESC
      LIMIT 300`,
  );
  return NextResponse.json({ rows: res.rows });
}
