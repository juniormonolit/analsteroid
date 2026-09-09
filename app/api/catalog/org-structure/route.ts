import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { getSessionScope, type SessionScope } from '@/lib/org/sessionScope';

interface DeptNode {
  id: string;
  bitrixId: string;
  name: string;
  parentBitrixId: string | null;
  children: DeptNode[];
}

// Аудит 09.09 («Главные дыры» п.4): пикер отделов отдавал всё поддерево продаж
// любой сессии. Требование владельца — неподконтрольных отделов в пикере быть не
// должно вовсе. Узлы дерева несут uuid (id) — режем набором scope.deptIds (корни
// среза + потомки); узел вне среза, у которого потомки в срезе (корень среза
// глубже), заменяется своими допустимыми детьми, чтобы форма {tree} осталась.
function pruneToScope(nodes: DeptNode[], scope: SessionScope): DeptNode[] {
  if (scope.kind === 'all') return nodes;
  if (scope.kind === 'self') return [];
  const out: DeptNode[] = [];
  for (const n of nodes) {
    const kids = pruneToScope(n.children, scope);
    if (scope.deptIds.has(n.id)) out.push({ ...n, children: kids });
    else out.push(...kids);
  }
  return out;
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const scope = await getSessionScope(session);

  // Оргструктура переехала в sa (задача Серёги 13.07): читаем из analyticsDb.
  const db = analyticsDb();
  const res = await db.query<{
    id: string; bitrix_department_id: string; name: string; parent_bitrix_department_id: string | null;
  }>(`SELECT id, bitrix_department_id, name, parent_bitrix_department_id
      FROM sa.departments WHERE is_active = true ORDER BY name`);

  const nodes = new Map<string, DeptNode>();
  for (const r of res.rows) {
    nodes.set(r.bitrix_department_id, {
      id: r.id, bitrixId: r.bitrix_department_id, name: r.name,
      parentBitrixId: r.parent_bitrix_department_id, children: [],
    });
  }

  const roots: DeptNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentBitrixId && nodes.has(node.parentBitrixId)) {
      nodes.get(node.parentBitrixId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Only expose the "Отдел продаж" subtree — exclude HR, marketing, logistics, etc.
  const salesRoot = roots.flatMap(r => r.children).find(n => n.name === 'Отдел продаж')
    ?? roots.find(n => n.name === 'Отдел продаж');
  const salesTree = salesRoot ? salesRoot.children : roots;

  return NextResponse.json({ tree: pruneToScope(salesTree, scope) });
}
