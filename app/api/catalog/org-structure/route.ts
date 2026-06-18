import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

interface DeptNode {
  id: string;
  bitrixId: string;
  name: string;
  parentBitrixId: string | null;
  children: DeptNode[];
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = systemDb();
  const res = await db.query<{
    id: string; bitrix_department_id: string; name: string; parent_bitrix_department_id: string | null;
  }>(`SELECT id, bitrix_department_id, name, parent_bitrix_department_id
      FROM departments WHERE is_active = true ORDER BY name`);

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

  return NextResponse.json({ tree: roots });
}
