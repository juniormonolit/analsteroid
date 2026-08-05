// Отделы, которыми пользователь руководит ПО ОРГСТРУКТУРЕ РОБОТА «КОНТРОЛЬ ЗВОНКОВ»
// (решение владельца 29.07 для ЛК РОПа/директора): эффективный руководитель отдела =
// ручное назначение из call_control_recipient_overrides (миграция 100, приоритет),
// иначе — rop/department_director из sa.org_resolved_hierarchy. Кросс-БД (org — sa,
// overrides — system) — мёрдж в JS, как в settings/bots/call-control/departments.

import { analyticsDb, systemDb } from '@/lib/db/clients';

export interface ManagedDept {
  deptId: string;
  deptName: string | null;
  role: 'rop' | 'department_director';
}

export async function getCallControlManagedDepts(bitrixUserId: string): Promise<ManagedDept[]> {
  if (!bitrixUserId) return [];

  const [orgRes, ovrRes] = await Promise.all([
    analyticsDb().query<{
      department_id: string; department_name: string | null;
      rop_bitrix_user_id: string | null; department_director_bitrix_user_id: string | null;
    }>(
      `SELECT DISTINCT department_id::text AS department_id, department_name,
              rop_bitrix_user_id::text AS rop_bitrix_user_id,
              department_director_bitrix_user_id::text AS department_director_bitrix_user_id
         FROM sa.org_resolved_hierarchy
        WHERE is_active AND department_id IS NOT NULL`,
    ),
    systemDb().query<{ department_id: string; role: 'rop' | 'department_director'; bitrix_user_id: string }>(
      'SELECT department_id::text AS department_id, role, bitrix_user_id FROM call_control_recipient_overrides',
    ),
  ]);

  const overrideByDeptRole = new Map(ovrRes.rows.map(r => [`${r.department_id}:${r.role}`, r.bitrix_user_id]));

  const managed: ManagedDept[] = [];
  const seen = new Set<string>();
  for (const d of orgRes.rows) {
    if (seen.has(d.department_id)) continue;
    seen.add(d.department_id);
    const effRop = overrideByDeptRole.get(`${d.department_id}:rop`) ?? d.rop_bitrix_user_id;
    const effDir = overrideByDeptRole.get(`${d.department_id}:department_director`) ?? d.department_director_bitrix_user_id;
    // Правило высшей позиции (решение владельца 05.08): если человек в
    // оргструктуре и РОП и директор — система везде считает его ДИРЕКТОРОМ.
    // Раньше проверка РОПа шла первой и при двойной роли в одном отделе
    // выигрывал РОП — перевёрнуто сознательно.
    if (effDir === bitrixUserId) managed.push({ deptId: d.department_id, deptName: d.department_name, role: 'department_director' });
    else if (effRop === bitrixUserId) managed.push({ deptId: d.department_id, deptName: d.department_name, role: 'rop' });
  }
  return managed;
}

/**
 * Тот же источник (org_resolved_hierarchy + call_control_recipient_overrides),
 * но КОМПАНИЯ ЦЕЛИКОМ, не один пользователь — для реестра сотрудников (задача
 * 2771, «список всех менеджеров и РОПов для админа»): нужна колонка «роль» по
 * каждой строке, без N+1 вызовов getCallControlManagedDepts на сотрудника.
 */
export interface OrgRoleSets { ropIds: Set<string>; directorIds: Set<string> }

export async function getAllRopAndDirectorIds(): Promise<OrgRoleSets> {
  const [orgRes, ovrRes] = await Promise.all([
    analyticsDb().query<{
      department_id: string;
      rop_bitrix_user_id: string | null; department_director_bitrix_user_id: string | null;
    }>(
      `SELECT DISTINCT department_id::text AS department_id,
              rop_bitrix_user_id::text AS rop_bitrix_user_id,
              department_director_bitrix_user_id::text AS department_director_bitrix_user_id
         FROM sa.org_resolved_hierarchy
        WHERE is_active AND department_id IS NOT NULL`,
    ),
    systemDb().query<{ department_id: string; role: 'rop' | 'department_director'; bitrix_user_id: string }>(
      'SELECT department_id::text AS department_id, role, bitrix_user_id FROM call_control_recipient_overrides',
    ),
  ]);

  const overrideByDeptRole = new Map(ovrRes.rows.map(r => [`${r.department_id}:${r.role}`, r.bitrix_user_id]));
  const ropIds = new Set<string>();
  const directorIds = new Set<string>();
  const seen = new Set<string>();
  for (const d of orgRes.rows) {
    if (seen.has(d.department_id)) continue;
    seen.add(d.department_id);
    const effRop = overrideByDeptRole.get(`${d.department_id}:rop`) ?? d.rop_bitrix_user_id;
    const effDir = overrideByDeptRole.get(`${d.department_id}:department_director`) ?? d.department_director_bitrix_user_id;
    if (effRop) ropIds.add(effRop);
    if (effDir) directorIds.add(effDir);
  }
  return { ropIds, directorIds };
}
