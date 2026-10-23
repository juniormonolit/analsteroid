import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';

// Сотрудники для «Участники задачи» (соисполнители / наблюдатели, владелец 23.10): менеджеры, РОПы и директора из
// оргструктуры (sa.org_resolved_hierarchy — имена людей, а не должности, как бывает в sa.employees), с отделом. Кэш 10 мин.
export const dynamic = 'force-dynamic';

interface Person { id: string; name: string; dept: string | null }
interface Payload { people: Person[]; ropOf: Record<string, string> }

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const payload = await cached<Payload>('repeat-kanban:people:v2', 600, async () => {
      const r = await analyticsDb().query<{ id: string; name: string; dept: string | null }>(
        `SELECT DISTINCT ON (id) id, name, dept FROM (
           SELECT manager_bitrix_user_id::text AS id, manager_name AS name, department_name AS dept, 0 AS pr FROM sa.org_resolved_hierarchy WHERE is_active AND manager_name IS NOT NULL
           UNION ALL SELECT rop_bitrix_user_id::text, rop_name, department_name, 1 FROM sa.org_resolved_hierarchy WHERE is_active AND rop_name IS NOT NULL
           UNION ALL SELECT department_director_bitrix_user_id::text, department_director_name, NULL, 2 FROM sa.org_resolved_hierarchy WHERE is_active AND department_director_name IS NOT NULL
         ) x WHERE id ~ '^[0-9]+$' ORDER BY id, pr`,
      );
      // Менеджер → его РОП: подпись «РОП менеджера — Имя» в окне задачи (сам разворот — на сервере при постановке).
      const rops = await analyticsDb().query<{ m: string; rop: string }>(
        `SELECT DISTINCT ON (manager_bitrix_user_id) manager_bitrix_user_id::text AS m, rop_bitrix_user_id::text AS rop
           FROM sa.org_resolved_hierarchy WHERE is_active AND rop_bitrix_user_id IS NOT NULL ORDER BY manager_bitrix_user_id`,
      );
      return {
        people: r.rows.map(x => ({ id: x.id, name: x.name, dept: x.dept })).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
        ropOf: Object.fromEntries(rops.rows.map(x => [x.m, x.rop])),
      };
    });
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[repeat-kanban/people]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось загрузить сотрудников' }, { status: 500 });
  }
}
