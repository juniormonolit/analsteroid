import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { fetchTeamRoster } from '@/features/customers/engine/team';

// Лёгкий ростер команды для переключателя «Мои / Отдел» в «Моих заказчиках»
// (18.09): есть ли у этого менеджера подконтрольные отделы и кто в них. Без
// подсчёта заказчиков — только имена.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const requested = new URL(req.url).searchParams.get('bitrixId');
  const anchor = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (!anchor) return NextResponse.json({ managers: [] });
  if (anchor !== session.bitrixUserId && !(await canViewManager(session, anchor))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return NextResponse.json({ managers: await fetchTeamRoster(session, anchor) });
}
