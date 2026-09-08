import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { buildTvTree, toTreeNode } from '@/features/tv/engine/orgTree';

// Дерево узлов для пикера «Отделы на экране»: Монолит → филиалы → отделы → команды.
export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.tv');
  if (denied) return denied;
  const tree = await buildTvTree();
  return NextResponse.json({ tree: [toTreeNode(tree.root)] });
}
