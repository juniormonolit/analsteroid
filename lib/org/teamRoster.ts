// Роспись менеджеров по «подконтрольным отделам» — переиспользует ту же логику
// прохода по дереву, что и lib/profile/deptSummary.ts::resolveAssignedDept (там
// считается план/факт по отделам, здесь — просто список менеджеров, для ФИФА-сетки
// «Мой отдел» и карточки отдела, features/manager-card).
//
// Семантика «Руководит» (user_departments, Права v2): назначенный отдел покрывает
// ВСЕХ менеджеров, чей отдел — сам назначенный узел ИЛИ любой потомок по дереву
// departments (Bitrix-иерархия). Менеджер приписывается к БЛИЖАЙШЕМУ назначенному
// предку (как и в deptSummary), поэтому пересекающиеся назначения (родитель +
// потомок оба назначены разным людям) не дублируют менеджера — приоритет у более
// специфичного (ближайшего) узла.

// Оргструктура в схеме sa (Мишина БД, задача Серёги 13.07): все org-таблицы
// (org_resolved_hierarchy, user_departments, departments) читаем через analyticsDb().
import { analyticsDb } from '@/lib/db/clients';
import { loadDepartments, type DeptRow } from '@/lib/org/deptCategories';

export interface RosterManager {
  managerId: string;
  name: string;
  login: string | null;
  deptUuid: string; // ближайший назначенный отдел (uuid), к которому приписан менеджер
}

export interface DeptOption {
  id: string;
  name: string;
  /** Глубина в дереве отделов — для отступов в пикере. Есть только у
   *  getAllDepartmentOptions (остальные списки плоские). */
  depth?: number;
  /** Путь «Дирекция / Отдел продаж / Департамент НЦ / Отдел ЖБИ» — для поиска
   *  и подсказки, чей это отдел, когда имён-тёзок несколько. */
  path?: string;
}

/** Тот же алгоритм, что resolveAssignedDept в lib/profile/deptSummary.ts. */
function resolveAssignedDept(
  ownDeptUuid: string | null,
  byId: Map<string, DeptRow>,
  byBitrixId: Map<string, DeptRow>,
  assignedByBitrixId: Map<string, string>,
): string | null {
  if (!ownDeptUuid) return null;
  let cur: DeptRow | undefined = byId.get(ownDeptUuid);
  for (let guard = 0; cur && guard < 15; guard++) {
    const hit = assignedByBitrixId.get(cur.bitrixId);
    if (hit) return hit;
    cur = cur.parentBitrixId ? byBitrixId.get(cur.parentBitrixId) : undefined;
  }
  return null;
}

/** Все активные менеджеры, чей ближайший назначенный (из deptUuids) отдел — среди
 *  переданных uuid. Один SQL-запрос по org_resolved_hierarchy (без N+1). */
export async function resolveManagersForDepartments(deptUuids: string[]): Promise<RosterManager[]> {
  if (deptUuids.length === 0) return [];
  const db = analyticsDb();
  const [managersRes, { byId, byBitrixId }] = await Promise.all([
    db.query<{ manager_id: string; manager_name: string; department_id: string | null; short_login: string | null }>(
      `SELECT manager_bitrix_user_id::text AS manager_id, manager_name, department_id::text AS department_id, short_login
         FROM sa.org_resolved_hierarchy WHERE is_active = true`,
    ),
    loadDepartments(),
  ]);

  const assignedSet = new Set(deptUuids);
  const assignedByBitrixId = new Map<string, string>();
  for (const uuid of deptUuids) {
    const row = byId.get(uuid);
    if (row) assignedByBitrixId.set(row.bitrixId, uuid);
  }

  const out: RosterManager[] = [];
  for (const row of managersRes.rows) {
    const dept = resolveAssignedDept(row.department_id, byId, byBitrixId, assignedByBitrixId);
    if (dept && assignedSet.has(dept)) {
      out.push({ managerId: row.manager_id, name: row.manager_name, login: row.short_login, deptUuid: dept });
    }
  }
  return out;
}

/** Раскладывает ВСЕХ активных менеджеров по ближайшему назначенному отделу из
 *  переданного набора peer-отделов — ОДИН проход/ОДИН запрос вместо N вызовов
 *  resolveManagersForDepartments (нужно для нормировки карточки отдела относительно
 *  ДРУГИХ отделов — «пиров» может быть десяток, N+1 недопустим). */
export async function bucketManagersByDepartments(deptUuids: string[]): Promise<Map<string, RosterManager[]>> {
  const out = new Map<string, RosterManager[]>(deptUuids.map(id => [id, []]));
  if (deptUuids.length === 0) return out;
  const db = analyticsDb();
  const [managersRes, { byId, byBitrixId }] = await Promise.all([
    db.query<{ manager_id: string; manager_name: string; department_id: string | null; short_login: string | null }>(
      `SELECT manager_bitrix_user_id::text AS manager_id, manager_name, department_id::text AS department_id, short_login
         FROM sa.org_resolved_hierarchy WHERE is_active = true`,
    ),
    loadDepartments(),
  ]);

  const assignedByBitrixId = new Map<string, string>();
  for (const uuid of deptUuids) {
    const row = byId.get(uuid);
    if (row) assignedByBitrixId.set(row.bitrixId, uuid);
  }

  for (const row of managersRes.rows) {
    const dept = resolveAssignedDept(row.department_id, byId, byBitrixId, assignedByBitrixId);
    if (dept && out.has(dept)) {
      out.get(dept)!.push({ managerId: row.manager_id, name: row.manager_name, login: row.short_login, deptUuid: dept });
    }
  }
  return out;
}

/** Все отделы, которые кем-либо назначены как «Руководит» (глобально, не только
 *  текущему пользователю) — peer-набор для нормировки рейтинга отдела. Плюс
 *  корневые узлы (фолбэк, если назначений в user_departments вообще ещё нет). */
export async function getAllManagedDepartmentIds(): Promise<DeptOption[]> {
  const res = await analyticsDb().query<{ id: string; name: string }>(
    `SELECT DISTINCT d.id::text AS id, d.name
       FROM sa.user_departments ud JOIN sa.departments d ON d.id = ud.department_id
      UNION
     SELECT id::text AS id, name FROM sa.departments WHERE parent_bitrix_department_id IS NULL`,
  );
  return res.rows;
}

/**
 * ВСЕ отделы оргструктуры деревом (порядок = обход структуры, depth = уровень).
 *
 * Задача владельца 07.08 по конструктору «Мой отчёт»: «в „Кто в отчёте“ должно
 * быть можно выбрать любую команду по структуре. Например, „Отдел
 * металлопроката“ отсутствует в списке». Причина отсутствия —
 * getAllManagedDepartmentIds выше отдаёт только отделы, у которых КТО-ТО назначен
 * руководителем в user_departments, плюс корневые узлы: 16 из 80. Для выбора
 * сущности отчёта это неверный критерий — человека интересует структура, а не то,
 * заведён ли у отдела руководитель в приложении.
 *
 * Рекурсивный обход по parent_bitrix_department_id + UNION-хвост для «сирот»
 * (родитель которых не найден): иначе отдел с битой ссылкой на родителя тихо
 * исчезал бы из списка — тот же класс проблемы, что чиним.
 */
export async function getAllDepartmentOptions(): Promise<DeptOption[]> {
  const res = await analyticsDb().query<{ id: string; name: string; depth: number; path: string }>(
    `WITH RECURSIVE tree AS (
       SELECT d.id, d.name, d.bitrix_department_id, 0 AS depth, d.name::text AS path
         FROM sa.departments d
        WHERE d.parent_bitrix_department_id IS NULL AND d.is_active = true
       UNION ALL
       SELECT d.id, d.name, d.bitrix_department_id, t.depth + 1, t.path || ' / ' || d.name
         FROM sa.departments d
         JOIN tree t ON d.parent_bitrix_department_id = t.bitrix_department_id
        WHERE d.is_active = true
     )
     SELECT id::text AS id, name, depth, path FROM tree
     UNION ALL
     SELECT d.id::text, d.name, 0 AS depth, d.name::text AS path
       FROM sa.departments d
      WHERE d.is_active = true AND d.id NOT IN (SELECT id FROM tree)
     ORDER BY path`,
  );
  return res.rows;
}

/** Отделы, назначенные пользователю («Руководит», user_departments). */
export async function getUserDepartmentOptions(userId: string): Promise<DeptOption[]> {
  const res = await analyticsDb().query<{ id: string; name: string }>(
    `SELECT d.id::text AS id, d.name
       FROM sa.user_departments ud JOIN sa.departments d ON d.id = ud.department_id
      WHERE ud.user_id = $1
      ORDER BY d.name`,
    [userId],
  );
  return res.rows;
}

/** Фолбэк для супер-админа/Директора без явных назначений в user_departments —
 *  корневые узлы дерева отделов (без родителя), чтобы селектор не был пустым. */
export async function getRootDepartmentOptions(): Promise<DeptOption[]> {
  const res = await analyticsDb().query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM sa.departments WHERE parent_bitrix_department_id IS NULL ORDER BY name`,
  );
  return res.rows;
}
