// Отделы DepartmentPicker (bitrix id или uuid) → bitrix id менеджеров (как у доски, app/api/logist-kanban/board).
import { analyticsDb } from '@/lib/db/clients';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import type { LogistFilters } from './contract';

export async function expandManagerDepts(filters: LogistFilters): Promise<void> {
  if (!filters.managerDepts?.length) return;
  const numeric = filters.managerDepts.filter(x => /^\d+$/.test(x));
  const uuids = filters.managerDepts.filter(x => !/^\d+$/.test(x));
  if (numeric.length) {
    const r = await analyticsDb().query<{ id: string }>(`SELECT id::text AS id FROM sa.departments WHERE bitrix_department_id::text = ANY($1::text[])`, [numeric]);
    uuids.push(...r.rows.map(x => x.id));
  }
  const inDepts = [...new Set((await resolveManagersForDepartments(uuids)).map(m => String(m.managerId)).filter(id => /^\d+$/.test(id)))];
  filters.managers = filters.managers?.length ? filters.managers.filter(m => inDepts.includes(m)) : inDepts;
  if (!filters.managers.length) filters.managers = ['0']; // отделы без менеджеров → пусто, а не «все»
}
