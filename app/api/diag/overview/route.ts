import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { loadActiveManagers } from '@/features/diag/engine/daily';

// Обзор диагностики: последние ряды по каждому менеджеру×узлу + состояние справочников.
export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const sys = systemDb();
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const [series, nodes, refs, managers] = await Promise.all([
    sys.query<{ subject_key: string; node_id: string; as_of: string; tick_no: number | null; value: string | null; n: number | null; ci_low: string | null; ci_high: string | null; ewma: string | null; cusum_neg: string | null; base_own: string | null; base_peers: string | null; base_target: string | null; sigma: string | null; status: string; trace: unknown }>(
      `SELECT DISTINCT ON (subject_key, node_id) subject_key, node_id, to_char(as_of, 'YYYY-MM-DD') AS as_of, tick_no, value, n, ci_low, ci_high, ewma, cusum_neg, base_own, base_peers, base_target, sigma, status, trace
         FROM diag_series WHERE subject_type = 'manager' AND head_group_name IS NULL ORDER BY subject_key, node_id, as_of DESC`),
    sys.query<{ id: string; name: string; node_kind: string; window_kind: string; controllable: string; higher_is_better: boolean; sort_order: number; description: string | null }>(
      `SELECT id, name, node_kind, window_kind, controllable, higher_is_better, sort_order, description FROM diag_nodes WHERE enabled ORDER BY sort_order`),
    sys.query<{ what: string; n: string; at: string | Date | null }>(
      `SELECT 'lags' AS what, count(*)::text AS n, max(computed_at) AS at FROM diag_lags
       UNION ALL SELECT 'zombie', count(*)::text, max(computed_at) FROM diag_zombie_thresholds
       UNION ALL SELECT 'season', count(*)::text, max(computed_at) FROM diag_season
       UNION ALL SELECT 'series_today', count(*)::text, max(as_of)::timestamptz FROM diag_series WHERE as_of = current_date`),
    loadActiveManagers(`${today.slice(0, 7)}-01`).catch(() => []),
  ]);
  const n = (v: string | null) => (v === null ? null : Number(v));
  const byMgr = new Map<string, Record<string, unknown>[]>();
  for (const r of series.rows) (byMgr.get(r.subject_key) ?? byMgr.set(r.subject_key, []).get(r.subject_key)!).push({
    nodeId: r.node_id, asOf: r.as_of, tickNo: r.tick_no, value: n(r.value), n: r.n, ciLow: n(r.ci_low), ciHigh: n(r.ci_high), ewma: n(r.ewma), cusumNeg: n(r.cusum_neg),
    baseOwn: n(r.base_own), basePeers: n(r.base_peers), baseTarget: n(r.base_target), sigma: n(r.sigma), status: r.status, trace: r.trace,
  });
  const mgrInfo = new Map(managers.map(m => [String(m.bitrixId), m]));
  const rows = [...byMgr.entries()].map(([key, nodesRows]) => {
    const m = mgrInfo.get(key);
    return { bitrixId: Number(key), name: m?.name ?? `#${key}`, branch: m?.branch ?? '—', category: m?.category ?? '—', plan: m?.plan ?? null, nodes: nodesRows };
  });
  return NextResponse.json({
    today, nodes: nodes.rows, managers: rows,
    refs: refs.rows.map(r => ({ what: r.what, n: Number(r.n), at: r.at ? new Date(r.at).toISOString() : null })),
    activeManagers: managers.length,
  });
}
