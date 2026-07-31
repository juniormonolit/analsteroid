// Оргмасштабы для топ-бейджей (задача 2655): отдел → департамент → филиал → страна.
// Источник — sa.org_resolved_hierarchy + sa.departments (parent_bitrix_department_id).
// «Департамент» = родительский битрикс-отдел отдела менеджера (если родителя нет —
// сам отдел, победа в отделе тогда автоматически покрывает и этот уровень).

import { analyticsDb } from '@/lib/db/clients';

export interface ManagerScope {
  bitrixId: number;
  deptKey: string | null;     // uuid отдела
  parentKey: string | null;   // битрикс-id родительского отдела (департамент)
  branchKey: string | null;   // код/имя филиала
}

let _cache: { map: Map<number, ManagerScope>; at: number } | null = null;
const TTL_MS = 60 * 60 * 1000;

export async function getManagerScopes(): Promise<Map<number, ManagerScope>> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.map;
  const res = await analyticsDb().query<{
    manager_bitrix_user_id: string; department_id: string | null; branch: string | null;
    dept_bitrix_id: string | null; parent_bitrix_department_id: string | null;
  }>(
    `SELECT orh.manager_bitrix_user_id, orh.department_id, coalesce(orh.branch_code, orh.branch) AS branch,
            dep.bitrix_department_id AS dept_bitrix_id, dep.parent_bitrix_department_id
       FROM sa.org_resolved_hierarchy orh
       LEFT JOIN sa.departments dep ON dep.id = orh.department_id`,
  );
  const map = new Map<number, ManagerScope>();
  for (const r of res.rows) {
    const id = Number(r.manager_bitrix_user_id);
    if (!Number.isInteger(id)) continue;
    map.set(id, {
      bitrixId: id,
      deptKey: r.department_id,
      parentKey: r.parent_bitrix_department_id ?? r.dept_bitrix_id, // без родителя — сам отдел
      branchKey: r.branch,
    });
  }
  _cache = { map, at: Date.now() };
  return map;
}
