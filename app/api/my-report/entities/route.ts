// GET /api/my-report/entities — что человек вправе выбрать в конструкторе.
//
// Пикер не должен показывать то, чего API всё равно не отдаст: список приходит
// уже отфильтрованным по правам (lib/reports-builder/entities), а не фильтруется
// на клиенте.

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { availableEntities } from '@/lib/reports-builder/entities';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json(await availableEntities(session));
}
