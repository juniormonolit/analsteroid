import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { getEmployeeDirectory } from '@/lib/org/employeeDirectory';

// Сотрудники для «Участники задачи» (соисполнители / наблюдатели, владелец 23.10): менеджеры, РОПы и директора из
// оргструктуры (sa.org_resolved_hierarchy — имена людей, а не должности, как бывает в sa.employees), с отделом. Кэш 10 мин.
export const dynamic = 'force-dynamic';

interface Person { id: string; name: string; dept: string | null; /** manager — есть в оргструктуре как менеджер (для «И сменить менеджера на…»). */ manager?: boolean }
interface Payload { people: Person[]; ropOf: Record<string, string> }

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const payload = await cached<Payload>('repeat-kanban:people:v4', 600, async () => {
      const r = await analyticsDb().query<{ id: string; name: string; dept: string | null; pr: number }>(
        `SELECT DISTINCT ON (id) id, name, dept, pr FROM (
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
      // Руководители и директора ВСЕХ активных подразделений (10.11, тестировщики: «поиск „Осипов“ находит только менеджеров
      // „Команда Осипов“, самого Осипова нет»): руководитель отдела не всегда записан у менеджеров как РОП. Имя — из
      // справочника сотрудников (как везде в оргструктуре).
      const heads = await analyticsDb().query<{ id: string; dept: string }>(
        `SELECT DISTINCT ON (id) id, dept FROM (
           SELECT head_bitrix_user_id AS id, name AS dept FROM sa.departments WHERE is_active AND head_bitrix_user_id ~ '^[0-9]+$'
           UNION ALL SELECT director_bitrix_user_id, name FROM sa.departments WHERE is_active AND director_bitrix_user_id ~ '^[0-9]+$'
         ) h ORDER BY id`,
      ).catch(() => ({ rows: [] as { id: string; dept: string }[] }));
      const dir = heads.rows.length ? await getEmployeeDirectory().catch(() => null) : null;
      const byId = new Map<string, Person>(r.rows.map(x => [x.id, { id: x.id, name: x.name, dept: x.dept, manager: Number(x.pr) === 0 }]));
      for (const h of heads.rows) {
        const name = dir?.get(Number(h.id))?.name;
        if (!byId.has(h.id) && name && !/^User \d+$/.test(name)) byId.set(h.id, { id: h.id, name, dept: `руководитель · ${h.dept}` });
      }
      return {
        people: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
        ropOf: Object.fromEntries(rops.rows.map(x => [x.m, x.rop])),
      };
    });
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[repeat-kanban/people]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось загрузить сотрудников' }, { status: 500 });
  }
}
