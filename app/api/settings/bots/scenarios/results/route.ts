import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Оценка эффективности сценариев (владелец 09.09: «по каждому сценарию видеть его
// эффективность в целом и для кого из менеджеров как он отработал; при старте фиксировать
// стартовый показатель, текущий, достигнут ли целевой и удержан ли»). Единица — цепочка
// (bot_scenario_runs) с трекингом цели после закрытия (см. trackRuns в lib/jobs/scenarios.ts).
// Итог (outcome): held — удержал ≥ holdDays подряд (максимальный успех), holding — достиг и
// пока держит, reached_lost — достиг, но потерял, improved / same / worse — порог не взят.
export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const q = req.nextUrl.searchParams;
  const scenarioId = q.get('scenarioId');
  const managerId = q.get('managerId');
  const where: string[] = [];
  const params: unknown[] = [];
  if (scenarioId && /^[0-9a-f-]{36}$/.test(scenarioId)) { params.push(scenarioId); where.push(`r.scenario_id = $${params.length}`); }
  if (managerId && /^\d+$/.test(managerId)) { params.push(Number(managerId)); where.push(`r.manager_bitrix_id = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = systemDb();
  const [runs, agg, track] = await Promise.all([
    db.query<{
      id: string; scenario_id: string; scenario_name: string; manager_bitrix_id: string; manager_name: string | null; branch: string;
      status: string; start_value: string | null; last_value: string | null; current_value: string | null; threshold: string | null; base_value: string | null;
      outcome: string | null; closed_reason: string | null; messages: string; resume_at: string | null; reached_at: string | null; at_base_at: string | null;
      streak_since: string | null; held: boolean; held_at: string | null; track_until: string | null; tracking: string;
      created_at: string | Date; closed_at: string | Date | null;
    }>(
      `SELECT r.id::text, r.scenario_id::text, s.name AS scenario_name, r.manager_bitrix_id::text, u.display_name AS manager_name,
              r.branch, r.status, r.start_value, r.last_value, r.current_value, r.threshold, r.base_value, r.outcome, r.closed_reason,
              COALESCE((r.vars->>'messagesSent')::int, 0)::text AS messages, to_char(r.resume_at, 'YYYY-MM-DD') AS resume_at,
              to_char(r.reached_at, 'YYYY-MM-DD') AS reached_at, to_char(r.at_base_at, 'YYYY-MM-DD') AS at_base_at,
              to_char(r.streak_since, 'YYYY-MM-DD') AS streak_since, r.held, to_char(r.held_at, 'YYYY-MM-DD') AS held_at,
              to_char(r.track_until, 'YYYY-MM-DD') AS track_until, r.tracking, r.created_at, r.closed_at
         FROM bot_scenario_runs r
         JOIN bot_scenarios s ON s.id = r.scenario_id
         LEFT JOIN users u ON u.bitrix_user_id = r.manager_bitrix_id::text
         ${w}
        ORDER BY r.created_at DESC LIMIT 500`, params),
    db.query<{
      scenario_id: string; scenario_name: string; total: string; open: string; tracking: string; below_total: string; held: string; holding: string;
      reached_lost: string; improved: string; same: string; worse: string; praise: string; avg_delta: string | null; messages: string;
      hold_days: string | null;
    }>(
      `SELECT r.scenario_id::text, s.name AS scenario_name, (s.flow->'trigger'->>'holdDays') AS hold_days,
              count(*)::text AS total,
              count(*) FILTER (WHERE r.status = 'open')::text AS open,
              count(*) FILTER (WHERE r.tracking = 'active')::text AS tracking,
              count(*) FILTER (WHERE r.branch = 'below')::text AS below_total,
              count(*) FILTER (WHERE r.branch = 'below' AND r.outcome = 'held')::text AS held,
              count(*) FILTER (WHERE r.branch = 'below' AND r.outcome = 'holding')::text AS holding,
              count(*) FILTER (WHERE r.branch = 'below' AND r.outcome = 'reached_lost')::text AS reached_lost,
              count(*) FILTER (WHERE r.branch = 'below' AND r.outcome = 'improved')::text AS improved,
              count(*) FILTER (WHERE r.branch = 'below' AND r.outcome = 'same')::text AS same,
              count(*) FILTER (WHERE r.branch = 'below' AND r.outcome = 'worse')::text AS worse,
              count(*) FILTER (WHERE r.branch = 'norm')::text AS praise,
              avg(COALESCE(r.current_value, r.last_value) - r.start_value) FILTER (WHERE r.branch = 'below')::text AS avg_delta,
              COALESCE(sum((r.vars->>'messagesSent')::int), 0)::text AS messages
         FROM bot_scenario_runs r JOIN bot_scenarios s ON s.id = r.scenario_id
         ${w}
        GROUP BY 1, 2, 3 ORDER BY 2`, params),
    // Снимки — только когда смотрим одного менеджера или один сценарий (для графика-линии).
    where.length
      ? db.query<{ run_id: string; day: string; value: string | null }>(
          `SELECT t.run_id::text, to_char(t.day, 'YYYY-MM-DD') AS day, t.value FROM bot_scenario_run_track t
             JOIN bot_scenario_runs r ON r.id = t.run_id ${w} ORDER BY t.day`, params)
      : Promise.resolve({ rows: [] as { run_id: string; day: string; value: string | null }[] }),
  ]);
  const n = (v: string | null) => (v === null ? null : Number(v));
  const d = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);
  const trackBy = new Map<string, { day: string; value: number | null }[]>();
  for (const t of track.rows) (trackBy.get(t.run_id) ?? trackBy.set(t.run_id, []).get(t.run_id)!).push({ day: t.day, value: n(t.value) });
  return NextResponse.json({
    runs: runs.rows.map(r => ({
      id: r.id, scenarioId: r.scenario_id, scenarioName: r.scenario_name, bitrixId: Number(r.manager_bitrix_id),
      managerName: r.manager_name ?? `#${r.manager_bitrix_id}`, branch: r.branch, status: r.status,
      startValue: n(r.start_value), lastValue: n(r.last_value), currentValue: n(r.current_value) ?? n(r.last_value),
      threshold: n(r.threshold), baseValue: n(r.base_value), outcome: r.outcome, closedReason: r.closed_reason, messages: Number(r.messages),
      resumeAt: r.resume_at, reachedAt: r.reached_at, atBaseAt: r.at_base_at, streakSince: r.streak_since, held: r.held, heldAt: r.held_at,
      trackUntil: r.track_until, tracking: r.tracking, createdAt: d(r.created_at)!, closedAt: d(r.closed_at),
      track: trackBy.get(r.id) ?? [],
    })),
    byScenario: agg.rows.map(a => ({
      scenarioId: a.scenario_id, scenarioName: a.scenario_name, holdDays: n(a.hold_days), total: Number(a.total), open: Number(a.open),
      tracking: Number(a.tracking), belowTotal: Number(a.below_total), held: Number(a.held), holding: Number(a.holding),
      reachedLost: Number(a.reached_lost), improved: Number(a.improved), same: Number(a.same), worse: Number(a.worse),
      praise: Number(a.praise), avgDelta: n(a.avg_delta), messages: Number(a.messages),
    })),
  });
}
