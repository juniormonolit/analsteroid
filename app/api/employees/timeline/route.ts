import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm, permError } from '@/lib/auth/perms';
import { analyticsDb } from '@/lib/db/clients';
import { canSeeManager, getSessionScope } from '@/lib/org/sessionScope';
import { countTenures, listTenures, reconcileTenures } from '@/lib/org/tenures';

// Таймлайн «Сотрудники» (решение владельца 18.11): слева логины Битрикса по отделам,
// справа — кто сидел на логине с–по (sa.employee_tenures). Видимость — как у списка:
// срез сессии; носитель section.employees_edit видит всех. Первый заход на пустую
// таблицу фиксирует всех действующих (reconcileTenures).
export async function GET() {
  const session = await getSession();
  const canEdit = hasPerm(session, 'section.employees_edit');
  const err = canEdit ? null : permError(session, 'section.employees');
  if (err) return err;

  const count = await countTenures();
  if (count === null) {
    return NextResponse.json({ migrated: false, logins: [], tenures: [], canEdit });
  }
  if (count === 0) {
    try { await reconcileTenures(); } catch (e) { console.error('[employees/timeline] фиксация не удалась:', e); }
  }

  const [org, tenures, scope] = await Promise.all([
    analyticsDb().query<{
      id: number; name: string; login: string | null; department: string | null; branch: string | null; is_active: boolean;
    }>(
      `SELECT manager_bitrix_user_id::int AS id, manager_name AS name, short_login AS login,
              department_name AS department, branch, is_active
         FROM sa.org_resolved_hierarchy ORDER BY department_name NULLS LAST, manager_name`,
    ),
    listTenures(),
    getSessionScope(session!),
  ]);
  const visible = (id: number) => canEdit || canSeeManager(scope, String(id));
  const logins = org.rows.filter(r => visible(r.id)).map(r => ({
    bitrixId: r.id, name: r.name, login: r.login, department: r.department, branch: r.branch, isActive: r.is_active,
  }));
  const ids = new Set(logins.map(l => l.bitrixId));
  return NextResponse.json({
    migrated: true, canEdit,
    logins,
    tenures: tenures.filter(t => ids.has(t.bitrixId)),
  });
}
