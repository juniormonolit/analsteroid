import { systemDb } from '@/lib/db/clients';

export interface OrgHierarchyRow {
  bitrixUserId: string;
  managerName: string;
  departmentId: string | null;
  departmentName: string | null;
  ropBitrixUserId: string | null;
  shortLogin: string | null;
  branch: string | null;
}

let _rows: OrgHierarchyRow[] | null = null;
let _at = 0;
const TTL = 10 * 60 * 1000; // тот же TTL, что у loadSourceMap/loadManagerInfoMap (lib/marketing/sources.ts)

/**
 * Кэшированное чтение активных строк org_resolved_hierarchy (менеджеры + привязка
 * к отделу). До этого несколько мест (features/reports/engine/byManagers.ts,
 * app/api/admin/org-employees, app/api/plans/employees и др.) независимо друг от
 * друга выполняли идентичный `SELECT ... FROM org_resolved_hierarchy WHERE
 * is_active = true` на каждый запрос без какого-либо кэша — при том, что справочник
 * меняется редко (синк оргструктуры, не чаще пары раз в день). Один кэш на процесс
 * с TTL 10 минут закрывает нужды всех читателей одним round-trip'ом вместо N.
 *
 * Подключено пока только в byManagers.ts (самый горячий путь — вызывается на
 * каждый /api/reports/run). Остальные точки чтения org_resolved_hierarchy оставлены
 * как есть — см. обоснование в owners-inbox/analsteroid-night-db-20260708.md.
 */
export async function loadOrgHierarchy(): Promise<OrgHierarchyRow[]> {
  if (_rows && Date.now() - _at < TTL) return _rows;

  const res = await systemDb().query<{
    bitrix_user_id: string; manager_name: string;
    department_id: string | null; department_name: string | null;
    rop_bitrix_user_id: string | null; short_login: string | null;
    branch: string | null;
  }>(`SELECT manager_bitrix_user_id AS bitrix_user_id,
             manager_name, department_id, department_name, rop_bitrix_user_id,
             short_login, branch
        FROM org_resolved_hierarchy WHERE is_active = true`);

  _rows = res.rows.map(r => ({
    bitrixUserId: r.bitrix_user_id,
    managerName: r.manager_name,
    departmentId: r.department_id,
    departmentName: r.department_name,
    ropBitrixUserId: r.rop_bitrix_user_id,
    shortLogin: r.short_login,
    branch: r.branch,
  }));
  _at = Date.now();
  return _rows;
}

export function invalidateOrgHierarchy(): void {
  _rows = null;
  _at = 0;
}
