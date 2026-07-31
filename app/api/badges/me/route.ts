import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { buildShelf } from '@/features/badges/engine/shelf';

// Полка трофеев текущего менеджера (ЛК /manager/me, задача 2655).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ shelf: [] });

  const shelf = await buildShelf(systemDb(), Number(session.bitrixUserId));
  return NextResponse.json({ shelf });
}
