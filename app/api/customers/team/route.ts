import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { fetchTeamCustomerStats } from '@/features/customers/engine/customers';

// Агрегат «Заказчики команды» для РОПа (фича Серёги 01.08, п.3): у кого из
// подчинённых сколько «пора позвонить»/заброшенных. Та же механика managed-depts,
// что «Моя команда» (/api/badges/team): список строится ТОЛЬКО из managed-отделов
// сессии — чужие менеджеры сюда не попадают by construction; провал в список
// заказчиков конкретного менеджера идёт через /api/customers?bitrixId= (второй
// рубеж canViewManager там).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ team: [] });

  const managed = await getCallControlManagedDepts(session.bitrixUserId);
  if (managed.length === 0) return NextResponse.json({ team: [] });

  const managers = await resolveManagersForDepartments(managed.map(d => d.deptId));
  const deptNames = new Map(managed.map(d => [d.deptId, d.deptName ?? null]));
  const seen = new Set<number>();
  const roster: { id: number; name: string; departmentName: string | null }[] = [];
  for (const m of managers) {
    const id = Number(m.managerId);
    if (!Number.isInteger(id) || String(id) === session.bitrixUserId || seen.has(id)) continue;
    seen.add(id);
    roster.push({ id, name: m.name || m.login || String(id), departmentName: deptNames.get(m.deptUuid) ?? null });
  }

  const stats = await fetchTeamCustomerStats(roster.map(r => r.id));
  const byId = new Map(stats.map(s => [s.bitrixId, s]));
  const team = roster.map(r => ({ ...r, ...byId.get(r.id)! }))
    // Самые горящие сверху: сначала «ключевые под угрозой» (самый дорогой сигнал,
    // дополнение Серёги 01.08), затем «пора позвонить».
    .sort((a, b) => (b.keyAtRisk - a.keyAtRisk) || (b.callNow - a.callNow));

  return NextResponse.json({ team });
}
