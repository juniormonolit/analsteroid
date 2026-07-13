// Маппинг «менеджер → филиал + категория отдела» (ОС / НЦ / ЖБИ / …) по реальной
// иерархии Bitrix-отделов. Вынесен из lib/jobs/planSummary.ts, чтобы ежедневный
// отчёт бота и «Сводная» считали принадлежность менеджеров одинаково.

// Оргструктура переехала в схему sa (Мишина БД, задача Серёги 13.07): читаем
// departments/org_resolved_hierarchy через analyticsDb() (пул sa), а не systemDb().
import { analyticsDb } from '@/lib/db/clients';
import { loadManagerBranchMap } from '@/lib/marketing/sources';

// org_resolved_hierarchy.branch → метки филиалов из decomposition/plan_targets_year.
// Филиалы без записи в этой мапе (например «Екатеринбург») остаются собственной строкой
// без плана — plan_percent_* уйдёт в null, а не 0/NaN.
export const BRANCH_LABELS: Record<string, string> = {
  'СПб': 'СПБ',
  'Москва/МО': 'МСК',
  'Краснодар': 'КРД',
};

// ── Категории продаж внутри филиала ───────────────────────────────────────────────
// Резолвятся по РЕАЛЬНОЙ иерархии Bitrix-отделов (departments.parent_bitrix_department_id),
// а не по department_name самого сотрудника — например, «Команда Осипов» попадает в «ОС»
// только через цепочку предков (Команда Осипов < Департамент ОС < Отдел продаж).
// Порядок важен: более специфичные узлы (ЖБИ/Металл) проверяются раньше их родителя (НЦ),
// иначе все сотрудники «Отдел ЖБИ» попали бы в «НЦ» по совпадению с родительским узлом.
// Соответствие подтверждено владельцем 2026-07-07 (см. migrations/047_plan_targets_department.sql).
export interface DeptAnchor { branch: string; category: string; name: string }

export const ANCESTOR_ANCHORS: DeptAnchor[] = [
  { branch: 'СПБ', category: 'НЦ ЖБИ',    name: 'Отдел ЖБИ' },
  { branch: 'СПБ', category: 'НЦ Металл', name: 'Отдел Металлопроката' },
  { branch: 'СПБ', category: 'НЦ',        name: 'Департамент НЦ' },
  { branch: 'СПБ', category: 'ОС',        name: 'Департамент ОС' },
  { branch: 'СПБ', category: 'ОС',        name: 'Департамент ЮЛ' }, // «Звезды Монолита» + сам узел
  { branch: 'МСК', category: 'ОС',        name: 'МСК ОС' },
  { branch: 'МСК', category: 'НЦ',        name: 'МСК НЦ' },
  { branch: 'МСК', category: 'ЖБИ',       name: 'МСК ЖБИ' },
  { branch: 'КРД', category: 'ОС',        name: 'КРД ОС' },
  { branch: 'КРД', category: 'НЦ',        name: 'КРД НЦ' },
];

// Голый «Отдел продаж» без своего подотдела (2 чел. по СПб) — матчится ТОЛЬКО по
// собственному имени узла сотрудника, не по потомкам: это корень дерева продаж для
// ВСЕХ филиалов, ancestor-match захватил бы МСК и КРД тоже.
export const EXACT_ANCHORS: DeptAnchor[] = [
  { branch: 'СПБ', category: 'ОС', name: 'Отдел продаж' },
];

// Порядок отображения категорий внутри карточки филиала.
export const CATEGORY_ORDER = ['ОС', 'НЦ', 'НЦ ЖБИ', 'НЦ Металл', 'ЖБИ'];

export interface DeptRow { bitrixId: string; name: string; parentBitrixId: string | null }

let _depts: Map<string, DeptRow> | null = null; // keyed by departments.id (uuid, org_resolved_hierarchy.department_id)
let _deptsByBitrixId: Map<string, DeptRow> | null = null;
let _deptsAt = 0;

export async function loadDepartments(): Promise<{ byId: Map<string, DeptRow>; byBitrixId: Map<string, DeptRow> }> {
  if (_depts && Date.now() - _deptsAt < 30 * 60 * 1000) return { byId: _depts, byBitrixId: _deptsByBitrixId! };
  const res = await analyticsDb().query<{ id: string; bitrix_department_id: string; name: string; parent_bitrix_department_id: string | null }>(
    'SELECT id::text AS id, bitrix_department_id, name, parent_bitrix_department_id FROM sa.departments',
  );
  const byId = new Map<string, DeptRow>();
  const byBitrixId = new Map<string, DeptRow>();
  for (const r of res.rows) {
    const row: DeptRow = { bitrixId: r.bitrix_department_id, name: r.name, parentBitrixId: r.parent_bitrix_department_id };
    byId.set(r.id, row);
    byBitrixId.set(r.bitrix_department_id, row);
  }
  _depts = byId;
  _deptsByBitrixId = byBitrixId;
  _deptsAt = Date.now();
  return { byId, byBitrixId };
}

export async function getManagerDeptIds(): Promise<Map<string, string | null>> {
  const res = await analyticsDb().query<{ manager_bitrix_user_id: string; department_id: string | null }>(
    `SELECT manager_bitrix_user_id::text AS manager_bitrix_user_id, department_id::text AS department_id
       FROM sa.org_resolved_hierarchy WHERE is_active = true`,
  );
  return new Map(res.rows.map(r => [r.manager_bitrix_user_id, r.department_id]));
}

export function resolveDeptCategory(
  branchLabel: string,
  departmentId: string | null,
  byId: Map<string, DeptRow>,
  byBitrixId: Map<string, DeptRow>,
): string | null {
  if (!departmentId) return null;
  const own = byId.get(departmentId);
  if (!own) return null;

  for (const a of EXACT_ANCHORS) {
    if (a.branch === branchLabel && own.name === a.name) return a.category;
  }

  let cur: DeptRow | undefined = own;
  for (let guard = 0; cur && guard < 15; guard++) {
    for (const a of ANCESTOR_ANCHORS) {
      if (a.branch === branchLabel && cur.name === a.name) return a.category;
    }
    cur = cur.parentBitrixId ? byBitrixId.get(cur.parentBitrixId) : undefined;
  }
  return null;
}

export interface ManagerOrgInfo { branch: string; category: string | null }

/** Полная карта «bitrix user id менеджера → {филиал (метка), категория отдела}». */
export async function getManagerOrgMap(): Promise<Map<string, ManagerOrgInfo>> {
  const [branchByManager, managerDeptIds, { byId, byBitrixId }] = await Promise.all([
    loadManagerBranchMap(),
    getManagerDeptIds(),
    loadDepartments(),
  ]);
  const out = new Map<string, ManagerOrgInfo>();
  const managerIds = new Set([...branchByManager.keys(), ...managerDeptIds.keys()]);
  for (const id of managerIds) {
    const rawBranch = branchByManager.get(id);
    const label = rawBranch ? (BRANCH_LABELS[rawBranch] ?? rawBranch) : 'СПБ';
    const category = resolveDeptCategory(label, managerDeptIds.get(id) ?? null, byId, byBitrixId);
    out.set(id, { branch: label, category });
  }
  return out;
}
