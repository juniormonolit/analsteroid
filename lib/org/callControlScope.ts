// Отделы, которыми пользователь руководит ПО ОРГСТРУКТУРЕ РОБОТА «КОНТРОЛЬ ЗВОНКОВ»
// (решение владельца 29.07 для ЛК РОПа/директора): эффективный руководитель отдела =
// ручное назначение из call_control_recipient_overrides (миграция 100, приоритет),
// иначе — rop/department_director из sa.org_resolved_hierarchy. Кросс-БД (org — sa,
// overrides — system) — мёрдж в JS, как в settings/bots/call-control/departments.

import { analyticsDb, systemDb } from '@/lib/db/clients';

export type OverrideRole = 'rop' | 'department_director';
/** Ключ `${department_id}:${role}` → ручные получатели (миграция 273: их может быть несколько). */
export type RecipientOverrides = Map<string, string[]>;

export async function loadRecipientOverrides(): Promise<RecipientOverrides> {
  const r = await systemDb().query<{ department_id: string; role: OverrideRole; bitrix_user_id: string }>(
    `SELECT department_id::text AS department_id, role, bitrix_user_id
       FROM call_control_recipient_overrides ORDER BY updated_at, bitrix_user_id`,
  );
  const map: RecipientOverrides = new Map();
  for (const row of r.rows) {
    const key = `${row.department_id}:${row.role}`;
    const list = map.get(key) ?? [];
    list.push(String(row.bitrix_user_id));
    map.set(key, list);
  }
  return map;
}

/** Ручные назначения (все) приоритетнее оргструктуры; нет ручных — человек из оргструктуры (если есть). */
export function effectiveRecipients(
  overrides: RecipientOverrides, departmentId: string | null | undefined, role: OverrideRole, orgUserId: string | null | undefined,
): string[] {
  const manual = departmentId ? overrides.get(`${departmentId}:${role}`) : undefined;
  if (manual && manual.length) return manual;
  return orgUserId ? [String(orgUserId)] : [];
}

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
    loadRecipientOverrides(),
  ]);

  const overrideByDeptRole = ovrRes;

  const managed: ManagedDept[] = [];
  const seen = new Set<string>();
  for (const d of orgRes.rows) {
    if (seen.has(d.department_id)) continue;
    seen.add(d.department_id);
    const effRop = effectiveRecipients(overrideByDeptRole, d.department_id, 'rop', d.rop_bitrix_user_id);
    const effDir = effectiveRecipients(overrideByDeptRole, d.department_id, 'department_director', d.department_director_bitrix_user_id);
    // Правило высшей позиции (решение владельца 05.08): если человек в
    // оргструктуре и РОП и директор — система везде считает его ДИРЕКТОРОМ.
    // Раньше проверка РОПа шла первой и при двойной роли в одном отделе
    // выигрывал РОП — перевёрнуто сознательно.
    if (effDir.includes(bitrixUserId)) managed.push({ deptId: d.department_id, deptName: d.department_name, role: 'department_director' });
    else if (effRop.includes(bitrixUserId)) managed.push({ deptId: d.department_id, deptName: d.department_name, role: 'rop' });
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
    loadRecipientOverrides(),
  ]);

  const overrideByDeptRole = ovrRes;
  const ropIds = new Set<string>();
  const directorIds = new Set<string>();
  const seen = new Set<string>();
  for (const d of orgRes.rows) {
    if (seen.has(d.department_id)) continue;
    seen.add(d.department_id);
    for (const id of effectiveRecipients(overrideByDeptRole, d.department_id, 'rop', d.rop_bitrix_user_id)) ropIds.add(id);
    for (const id of effectiveRecipients(overrideByDeptRole, d.department_id, 'department_director', d.department_director_bitrix_user_id)) directorIds.add(id);
  }
  return { ropIds, directorIds };
}
