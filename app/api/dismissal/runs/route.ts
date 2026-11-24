import { NextRequest, NextResponse } from 'next/server';
import { dismissalFail, dismissalGuard } from '@/features/dismissal/engine/http';
import { activeRunFor, createRun, listRuns } from '@/features/dismissal/engine/store';
import { findDismissalUser } from '@/features/dismissal/engine/users';
import { kickDismissalWorker } from '@/features/dismissal/engine/worker';

export const dynamic = 'force-dynamic';

export async function GET() {
  const g = await dismissalGuard();
  if (g.error) return g.error;
  try {
    return NextResponse.json({ runs: await listRuns() });
  } catch (e) {
    return dismissalFail(e, 'runs list');
  }
}

/** Новый прогон (status=scanning; сбор — воркер). Незавершённый прогон по этому сотруднику уже есть — отдаём его id. */
export async function POST(req: NextRequest) {
  const g = await dismissalGuard();
  if (g.error) return g.error;
  const body = await req.json().catch(() => ({})) as { sourceBitrixId?: unknown };
  const sourceId = Number(body.sourceBitrixId);
  if (!Number.isInteger(sourceId) || sourceId <= 0) return NextResponse.json({ error: 'Не выбран сотрудник' }, { status: 400 });
  try {
    const existing = await activeRunFor(sourceId);
    if (existing) return NextResponse.json({ id: existing, existing: true });
    const source = await findDismissalUser(sourceId);
    if (!source) return NextResponse.json({ error: `Пользователь Битрикса #${sourceId} не найден` }, { status: 400 });
    const s = g.session;
    const id = await createRun(source, { login: s.login, name: s.displayName || s.login, bitrixId: Number(s.bitrixUserId) || null });
    kickDismissalWorker();
    return NextResponse.json({ id });
  } catch (e) {
    return dismissalFail(e, 'runs create');
  }
}
