import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { buildTeamPlanyorka, type PlanyorkaUnit } from '@/features/planyorka/engine/planyorka';
import { isFeatureEnabled } from '@/lib/featureFlags';

// «Планёрка команды» (РОП, задача владельца 01.08) — та же managed-depts механика,
// что «Заказчики команды» / «Моя команда»: список строится ТОЛЬКО из отделов сессии.
//
// СКРЫТО ФЛАГОМ (01.08, см. app/api/planyorka/route.ts) — feature_flags.planyorka_enabled.
const UNITS: PlanyorkaUnit[] = ['day', 'week', 'month'];

export async function GET(req: NextRequest) {
  if (!(await isFeatureEnabled('planyorka_enabled'))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ team: [] });

  const managed = await getCallControlManagedDepts(session.bitrixUserId);
  if (managed.length === 0) return NextResponse.json({ team: [] });

  const managersRaw = await resolveManagersForDepartments(managed.map(d => d.deptId));
  const seen = new Set<number>();
  const roster: { id: number; name: string }[] = [];
  for (const m of managersRaw) {
    const id = Number(m.managerId);
    if (!Number.isInteger(id) || String(id) === session.bitrixUserId || seen.has(id)) continue;
    seen.add(id);
    roster.push({ id, name: m.name || m.login || String(id) });
  }

  const sp = req.nextUrl.searchParams;
  const unit = UNITS.find(u => u === sp.get('unit')) ?? 'month';
  const offset = Math.max(-11, Math.min(0, Number(sp.get('offset')) || 0));

  try {
    const team = await buildTeamPlanyorka(roster, unit, offset);
    team.sort((a, b) => b.missedTotal - a.missedTotal);
    return NextResponse.json({ team });
  } catch (e) {
    console.error('[planyorka/team]', e);
    return NextResponse.json({ error: 'Не удалось построить планёрку команды' }, { status: 500 });
  }
}
