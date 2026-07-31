import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { buildShelf } from '@/features/badges/engine/shelf';

// «Моя команда» в ЛК РОПа (дополнение Серёги к 2655): подчинённые по той же
// механике managed-depts, что и ЛК-агрегат отделов; у каждого — его полка.
// РОП видит ТОЛЬКО своих (директор — всех своих по структуре) by construction:
// список строится из managed-отделов сессии, чужие сюда не попадают.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ team: [] });

  const managed = await getCallControlManagedDepts(session.bitrixUserId);
  if (managed.length === 0) return NextResponse.json({ team: [] });

  const managers = await resolveManagersForDepartments(managed.map(d => d.deptId));
  const db = systemDb();
  const team: { bitrixId: number; name: string; departmentName: string | null; shelf: Awaited<ReturnType<typeof buildShelf>> }[] = [];
  const deptNames = new Map(managed.map(d => [d.deptId, d.deptName ?? null]));
  for (const m of managers) {
    const id = Number(m.managerId);
    if (!Number.isInteger(id) || String(id) === session.bitrixUserId) continue;
    const shelf = await buildShelf(db, id);
    team.push({
      bitrixId: id,
      name: m.name || m.login || String(id),
      departmentName: deptNames.get(m.deptUuid) ?? null,
      shelf,
    });
  }
  // менеджеры с наградами сверху, по числу наград
  team.sort((a, b) => b.shelf.reduce((s, i) => s + i.count, 0) - a.shelf.reduce((s, i) => s + i.count, 0));
  return NextResponse.json({ team });
}
