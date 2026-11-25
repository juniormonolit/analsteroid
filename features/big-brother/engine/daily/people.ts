// «Большой брат», поток D — кого мониторим: продажи (МОП, РОП, директора) + логисты (решение владельца 25.11).
//
// Источник — sa.org_resolved_hierarchy (is_active) + логины Битрикса из employees (manager* / logist*), как в
// дисциплине задач (engine/tasks/build.ts). РОП — кто-то из действующих числится у него в rop_bitrix_user_id (или роль
// «РОП» в users); директор — роль «Директор» в users (поля директоров в оргструктуре на проде пусты, сверка 25.11) или
// department_director / company_director оргструктуры, если их заполнят.
// ВНИМАНИЕ: оргструктура — только текущее состояние (истории нет). Отдел/РОП «на дату» в activity_daily — это
// состояние на момент сборки: ночная сборка вчерашнего дня фиксирует его навсегда, а досборка прошлых дат
// (backfill) берёт сегодняшнюю оргструктуру.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadLogins } from '../rop/sources';
import type { PersonRole } from './types';

export interface MonitoredPerson {
  id: string;
  name: string;
  role: PersonRole;
  departmentId: string | null;
  departmentName: string | null;
  ropId: string | null;
  ropName: string | null;
}

export async function loadMonitoredPeople(): Promise<MonitoredPerson[]> {
  const [org, logins, appRoles] = await Promise.all([
    analyticsDb().query<{
      id: string; name: string | null; dept_id: string | null; dept: string | null; rop: string | null; rop_name: string | null;
      dir: string | null; cdir: string | null;
    }>(
      `SELECT manager_bitrix_user_id AS id, manager_name AS name, department_id::text AS dept_id, department_name AS dept,
              rop_bitrix_user_id AS rop, rop_name, department_director_bitrix_user_id AS dir,
              company_director_bitrix_user_id AS cdir
         FROM sa.org_resolved_hierarchy WHERE is_active`,
    ),
    loadLogins(),
    systemDb().query<{ id: string; role: string }>(
      `SELECT u.bitrix_user_id::text AS id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.bitrix_user_id IS NOT NULL AND r.name IN ('Директор', 'РОП')`,
    ).then(r => r.rows).catch(() => [] as { id: string; role: string }[]),
  ]);
  const rops = new Set<string>(), directors = new Set<string>();
  for (const u of appRoles) (u.role === 'Директор' ? directors : rops).add(u.id);
  for (const r of org.rows) {
    if (r.rop) rops.add(String(r.rop));
    if (r.dir) directors.add(String(r.dir));
    if (r.cdir) directors.add(String(r.cdir));
  }
  const out: MonitoredPerson[] = [];
  const seen = new Set<string>();
  for (const r of org.rows) {
    const id = String(r.id ?? '');
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    const login = (logins.get(id) ?? '').toLowerCase();
    const role: PersonRole | null = directors.has(id) ? 'director'
      : rops.has(id) ? 'rop'
        : login.startsWith('logist') || /логист/i.test(r.dept ?? '') ? 'logist'
          : login.startsWith('manager') ? 'mop'
            : null;
    if (!role) continue;
    seen.add(id);
    out.push({
      id, name: r.name?.trim() || `#${id}`, role, departmentId: r.dept_id, departmentName: r.dept,
      ropId: r.rop && r.rop !== id ? String(r.rop) : null, ropName: r.rop && r.rop !== id ? r.rop_name : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
