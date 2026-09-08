import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { buildDashboard, type TvDashNode } from '@/features/tv/engine/dashboard';
import { tvScope } from '@/features/tv/engine/access';

// Дашборд «Сегодня по компании». Руководство видит всё; остальные с section.tv — только
// свои узлы (подконтрольные отделы + потомки): дерево режется до разрешённых uuid-узлов.
export const dynamic = 'force-dynamic';

function prune(node: TvDashNode, allowed: Set<string>): TvDashNode[] {
  if (allowed.has(node.id)) return [node];
  return node.children.flatMap(c => prune(c, allowed));
}

export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return denied;
  const [dash, scope] = await Promise.all([buildDashboard(), tvScope(session!)]);
  if (scope.full) return NextResponse.json(dash, { headers: { 'Cache-Control': 'no-store' } });
  const roots = prune(dash.root, scope.allowedDeptIds ?? new Set());
  if (roots.length === 0) return NextResponse.json({ error: 'Нет отделов в вашей зоне ответственности' }, { status: 403 });
  const keep = new Set<string>();
  for (const r of roots) for (const id of r.allManagerIds) keep.add(id);
  const managers = Object.fromEntries(Object.entries(dash.managers).filter(([id]) => keep.has(id)));
  const root: TvDashNode = roots.length === 1 ? roots[0] : {
    ...roots[0], id: 'scope', name: 'Мои отделы', kind: 'root', children: roots,
    planDay: roots.reduce((a, r) => a + r.planDay, 0), factDay: roots.reduce((a, r) => a + r.factDay, 0),
    salesCount: roots.reduce((a, r) => a + r.salesCount, 0), bookSum: roots.reduce((a, r) => a + r.bookSum, 0),
    bookCount: roots.reduce((a, r) => a + r.bookCount, 0), activeManagers: roots.reduce((a, r) => a + r.activeManagers, 0),
    pb: roots.reduce((a, r) => a + r.pb, 0), target: roots.reduce((a, r) => a + r.target, 0),
    managerCount: roots.reduce((a, r) => a + r.managerCount, 0), directManagerIds: [], allManagerIds: [...keep],
  };
  return NextResponse.json({ ...dash, root, managers }, { headers: { 'Cache-Control': 'no-store' } });
}
