import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { mskToday, type QuestTier } from '@/features/quests/engine/quests';

// Сводка квестов команды для РОПа (миграция 125): текущие квесты подчинённых +
// счётчики выполнено/провалено по тирам за 8 недель. Тот же managed-depts
// скоуп, что и остальные командные блоки.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ team: [] });

  const managed = await getCallControlManagedDepts(session.bitrixUserId);
  if (managed.length === 0) return NextResponse.json({ team: [] });
  const managers = await resolveManagersForDepartments(managed.map(d => d.deptId));
  const roster: { id: number; name: string }[] = [];
  const seen = new Set<number>();
  for (const m of managers) {
    const id = Number(m.managerId);
    if (!Number.isInteger(id) || String(id) === session.bitrixUserId || seen.has(id)) continue;
    seen.add(id);
    roster.push({ id, name: m.name || m.login || String(id) });
  }
  if (roster.length === 0) return NextResponse.json({ team: [] });

  const db = systemDb();
  const today = mskToday();
  const ids = roster.map(r => r.id);
  const [current, hist] = await Promise.all([
    db.query(
      `SELECT bitrix_id::int AS b, slot, title, tier, status, progress::float, target::float, reward_eballs
         FROM quests WHERE bitrix_id = ANY($1::bigint[]) AND status <> 'rerolled' AND period_end >= $2
        ORDER BY CASE slot WHEN 'day' THEN 0 WHEN 'week1' THEN 1 WHEN 'week2' THEN 2 WHEN 'month' THEN 3 ELSE 4 END`,
      [ids, today],
    ),
    db.query<{ b: number; tier: QuestTier; status: string; c: string }>(
      `SELECT bitrix_id::int AS b, tier, status, count(*)::text AS c
         FROM quests WHERE bitrix_id = ANY($1::bigint[]) AND status IN ('done','failed')
          AND period_end >= $2::date - 56
        GROUP BY 1, 2, 3`,
      [ids, today],
    ),
  ]);
  const curBy = new Map<number, unknown[]>();
  for (const r of current.rows as { b: number }[]) {
    (curBy.get(r.b) ?? curBy.set(r.b, []).get(r.b)!).push(r);
  }
  const statBy = new Map<number, { done: Partial<Record<QuestTier, number>>; failed: number }>();
  for (const r of hist.rows) {
    const s = statBy.get(r.b) ?? statBy.set(r.b, { done: {}, failed: 0 }).get(r.b)!;
    if (r.status === 'done') s.done[r.tier] = (s.done[r.tier] ?? 0) + Number(r.c);
    else s.failed += Number(r.c);
  }
  return NextResponse.json({
    team: roster.map(r => ({
      bitrixId: r.id, name: r.name,
      current: curBy.get(r.id) ?? [],
      stats: statBy.get(r.id) ?? { done: {}, failed: 0 },
    })),
  });
}
