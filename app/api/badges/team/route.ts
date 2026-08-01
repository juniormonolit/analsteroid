import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { buildShelf } from '@/features/badges/engine/shelf';
import { getBalances, getCurrencyName } from '@/features/badges/engine/coins';
import { fetchXpBriefs, type XpBrief } from '@/features/xp/engine/xp';

// «Моя команда» в ЛК РОПа (дополнение Серёги к 2655): подчинённые по той же
// механике managed-depts, что и ЛК-агрегат отделов; у каждого — его полка.
// РОП видит ТОЛЬКО своих (директор — всех своих по структуре) by construction:
// список строится из managed-отделов сессии, чужие сюда не попадают.
// + Баланс валюты каждого подчинённого и название валюты (задача 2657).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = systemDb();
  const currencyName = await getCurrencyName(db);
  if (!session.bitrixUserId) return NextResponse.json({ team: [], currencyName });

  const managed = await getCallControlManagedDepts(session.bitrixUserId);
  if (managed.length === 0) return NextResponse.json({ team: [], currencyName });

  const managers = await resolveManagersForDepartments(managed.map(d => d.deptId));
  const team: { bitrixId: number; name: string; departmentName: string | null; balance: number; xp: XpBrief | null; shelf: Awaited<ReturnType<typeof buildShelf>> }[] = [];
  const deptNames = new Map(managed.map(d => [d.deptId, d.deptName ?? null]));
  const ids = [...new Set(managers.map(m => Number(m.managerId)).filter(id => Number.isInteger(id) && String(id) !== session.bitrixUserId))];
  // + XP-уровни/топ-классы подчинённых (миграция 124) — карта специализаций РОПа.
  const [balances, xpBriefs] = await Promise.all([
    getBalances(db, ids),
    fetchXpBriefs(db, ids).catch(() => new Map<number, XpBrief>()),
  ]);
  for (const m of managers) {
    const id = Number(m.managerId);
    if (!Number.isInteger(id) || String(id) === session.bitrixUserId) continue;
    const shelf = await buildShelf(db, id);
    team.push({
      bitrixId: id,
      name: m.name || m.login || String(id),
      departmentName: deptNames.get(m.deptUuid) ?? null,
      balance: balances.get(id) ?? 0,
      xp: xpBriefs.get(id) ?? null,
      shelf,
    });
  }
  // менеджеры с наградами сверху, по числу наград
  team.sort((a, b) => b.shelf.reduce((s, i) => s + i.count, 0) - a.shelf.reduce((s, i) => s + i.count, 0));
  return NextResponse.json({ team, currencyName });
}
