import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { analyticsDb, systemDb } from '@/lib/db/clients';

// Дерево оргструктуры ДО менеджеров для аудитории сценария (владелец 09.09: «пикер
// такой же, как в отчётах, но чтобы раскрывался вплоть до менеджеров»). Отделы —
// sa.departments (как /api/catalog/org-structure), менеджеры — sa.org_resolved_hierarchy
// по department_id, только менеджерские аккаунты (bitrix_login manager*, то же правило,
// что accountType='managers' в отчёте «По менеджерам» и в движке сценариев). Отделы без
// менеджеров в поддереве вырезаются — здесь выбирают людей, а не структуру.
export interface OrgTreeNode {
  id: string; bitrixId: string; name: string; children: OrgTreeNode[];
  managers: { bitrixId: number; name: string }[];
}

export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const [depts, people, logins] = await Promise.all([
    analyticsDb().query<{ id: string; bitrix_department_id: string; name: string; parent_bitrix_department_id: string | null }>(
      `SELECT id, bitrix_department_id, name, parent_bitrix_department_id FROM sa.departments WHERE is_active = true ORDER BY name`),
    analyticsDb().query<{ manager_bitrix_user_id: string; manager_name: string; department_id: string | null }>(
      `SELECT manager_bitrix_user_id, manager_name, department_id::text AS department_id FROM sa.org_resolved_hierarchy WHERE is_active = true`),
    systemDb().query<{ bitrix_user_id: string; bitrix_login: string | null }>(
      `SELECT bitrix_user_id::text AS bitrix_user_id, bitrix_login FROM employees WHERE is_active = true`),
  ]);
  const isManager = new Map(logins.rows.map(r => [r.bitrix_user_id, (r.bitrix_login ?? '').toLowerCase().startsWith('manager')]));

  const nodes = new Map<string, OrgTreeNode>();
  const byUuid = new Map<string, OrgTreeNode>();
  for (const d of depts.rows) {
    const n: OrgTreeNode = { id: d.id, bitrixId: d.bitrix_department_id, name: d.name, children: [], managers: [] };
    nodes.set(d.bitrix_department_id, n); byUuid.set(d.id, n);
  }
  const roots: OrgTreeNode[] = [];
  for (const d of depts.rows) {
    const n = nodes.get(d.bitrix_department_id)!;
    const parent = d.parent_bitrix_department_id ? nodes.get(d.parent_bitrix_department_id) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  let unassigned: OrgTreeNode | null = null;
  for (const p of people.rows) {
    if (!isManager.get(p.manager_bitrix_user_id)) continue;
    const m = { bitrixId: Number(p.manager_bitrix_user_id), name: p.manager_name };
    const dept = p.department_id ? byUuid.get(p.department_id) : undefined;
    if (dept) dept.managers.push(m);
    else (unassigned ??= { id: 'unassigned', bitrixId: 'unassigned', name: 'Без отдела', children: [], managers: [] }).managers.push(m);
  }
  const prune = (list: OrgTreeNode[]): OrgTreeNode[] => list
    .map(n => ({ ...n, children: prune(n.children), managers: n.managers.sort((a, b) => a.name.localeCompare(b.name, 'ru')) }))
    .filter(n => n.children.length > 0 || n.managers.length > 0);
  const tree = prune(roots);
  if (unassigned) tree.push(unassigned);
  return NextResponse.json({ tree });
}
