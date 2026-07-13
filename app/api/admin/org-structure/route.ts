import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { analyticsDb, systemDb } from '@/lib/db/clients';

// Данные раздела «Оргструктура» в настройках (задача Серёги 13.07): кто в каком
// отделе (дерево sa.departments + сотрудники из sa.org_resolved_hierarchy) и кто
// чем руководит (sa.user_departments). Только админ (action.users.manage).
//
// user_departments.user_id ссылается на system.users(id) — имена руководителей
// берём из system (кросс-БД джойн невозможен, мержим по user_id в коде).

interface Employee { id: string; name: string; login: string | null; branch: string | null }
interface DeptNode {
  id: string;
  bitrixId: string;
  name: string;
  parentBitrixId: string | null;
  employees: Employee[];
  children: DeptNode[];
}
interface Supervisor { userId: string; userName: string; departments: { id: string; name: string }[] }

export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'action.users.manage');
  if (denied) return denied;

  const sa = analyticsDb();
  const [deptRes, empRes, udRes, branchRes] = await Promise.all([
    sa.query<{ id: string; bitrix_department_id: string; name: string; parent_bitrix_department_id: string | null }>(
      `SELECT id::text AS id, bitrix_department_id, name, parent_bitrix_department_id
         FROM sa.departments WHERE is_active = true ORDER BY name`,
    ),
    sa.query<{ id: string; name: string; department_id: string | null; short_login: string | null; branch: string | null }>(
      `SELECT manager_bitrix_user_id::text AS id, manager_name AS name,
              department_id::text AS department_id, short_login, branch
         FROM sa.org_resolved_hierarchy WHERE is_active = true ORDER BY manager_name`,
    ),
    sa.query<{ user_id: string; department_id: string; department_name: string }>(
      `SELECT ud.user_id::text AS user_id, d.id::text AS department_id, d.name AS department_name
         FROM sa.user_departments ud JOIN sa.departments d ON d.id = ud.department_id
        ORDER BY d.name`,
    ),
    sa.query<{ code: string; short_name: string; full_name: string; sort_order: number }>(
      `SELECT code, short_name, full_name, sort_order FROM sa.branches ORDER BY sort_order`,
    ),
  ]);

  // Имена руководителей — из system.users (user_departments.user_id → users.id).
  const userIds = [...new Set(udRes.rows.map(r => r.user_id))];
  const userNames = new Map<string, string>();
  if (userIds.length) {
    const usersRes = await systemDb().query<{ id: string; display_name: string }>(
      `SELECT id::text AS id, display_name FROM users WHERE id = ANY($1::uuid[])`,
      [userIds],
    );
    for (const u of usersRes.rows) userNames.set(u.id, u.display_name);
  }

  // Дерево отделов + сотрудники в узлах.
  const nodes = new Map<string, DeptNode>(); // keyed by bitrix_department_id
  const byUuid = new Map<string, DeptNode>();
  for (const r of deptRes.rows) {
    const node: DeptNode = {
      id: r.id, bitrixId: r.bitrix_department_id, name: r.name,
      parentBitrixId: r.parent_bitrix_department_id, employees: [], children: [],
    };
    nodes.set(r.bitrix_department_id, node);
    byUuid.set(r.id, node);
  }

  const noDept: Employee[] = [];
  for (const e of empRes.rows) {
    const emp: Employee = { id: e.id, name: e.name, login: e.short_login, branch: e.branch };
    const node = e.department_id ? byUuid.get(e.department_id) : undefined;
    if (node) node.employees.push(emp);
    else noDept.push(emp);
  }

  const roots: DeptNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentBitrixId && nodes.has(node.parentBitrixId)) {
      nodes.get(node.parentBitrixId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Кто чем руководит.
  const supByUser = new Map<string, Supervisor>();
  for (const r of udRes.rows) {
    let sup = supByUser.get(r.user_id);
    if (!sup) {
      sup = { userId: r.user_id, userName: userNames.get(r.user_id) ?? '(неизвестный пользователь)', departments: [] };
      supByUser.set(r.user_id, sup);
    }
    sup.departments.push({ id: r.department_id, name: r.department_name });
  }
  const supervisors = [...supByUser.values()].sort((a, b) => a.userName.localeCompare(b.userName, 'ru'));

  const totalEmployees = empRes.rows.length;

  return NextResponse.json({
    branches: branchRes.rows,
    tree: roots,
    noDept,
    supervisors,
    stats: { departments: deptRes.rows.length, employees: totalEmployees, supervisors: supervisors.length },
  });
}
