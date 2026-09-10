// Ежедневный расчёт диагностики (ТЗ №1 §5–7), уровень «менеджер»:
//  1. работающие менеджеры = у кого есть план на текущий месяц (решение владельца 10.09);
//  2. окна закрытых сделок → значения тиковых узлов (текущее окно + own-база из предыдущего);
//  3. базы: own, peers (медиана по филиал×направление), интервал Уилсона для долей;
//  4. детекторы: EWMA и CUSUM по дням (состояние — предыдущая строка diag_series);
//  5. корень: прогноз выполнения плана отгрузок и разрыв в рублях.
// Результат — diag_series (одна строка на менеджер×узел×день). Диагнозы (декомпозиция и
// выбор рычага) — следующий модуль, читает эти ряды.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { getMonthWorkingDays } from '@/lib/plans/dailyPlan';
import { getManagerOrgMap } from '@/lib/org/deptCategories';
import { loadDiagSettings, type DiagSettings } from './settings';
import { loadLags } from './refs';
import { loadManagerWindows, computeTickNodes, type NodeValue } from './windows';

export interface ActiveManager { bitrixId: number; name: string; shortLogin: string; branch: string; category: string; plan: number; firstDealAt: Date | null }

const mskToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

/** Менеджеры с планом на месяц (план = признак работающего аккаунта). */
export async function loadActiveManagers(monthFirst: string): Promise<ActiveManager[]> {
  const plans = await systemDb().query<{ manager_login: string; plan_shipments: string }>(
    `SELECT manager_login, plan_shipments FROM manager_plans WHERE month = $1::date AND plan_shipments > 0`, [monthFirst]);
  if (!plans.rows.length) return [];
  const planBy = new Map(plans.rows.map(p => [p.manager_login, Number(p.plan_shipments)]));
  // category в org_resolved_hierarchy нет — направление резолвится по предкам отдела
  // (lib/org/deptCategories.getManagerOrgMap), там же нормализованная метка филиала.
  const [h, org] = await Promise.all([
    analyticsDb().query<{ manager_bitrix_user_id: string; manager_name: string; short_login: string | null; branch: string | null; first_deal_at: Date | null }>(
      `SELECT h.manager_bitrix_user_id, h.manager_name, h.short_login, h.branch,
              (SELECT min(created_at) FROM sa.deals d WHERE d.current_manager_id = h.manager_bitrix_user_id::bigint) AS first_deal_at
         FROM sa.org_resolved_hierarchy h WHERE h.is_active = true AND h.short_login = ANY($1::text[])`, [[...planBy.keys()]]),
    getManagerOrgMap(),
  ]);
  return h.rows.map(r => {
    const o = org.get(r.manager_bitrix_user_id);
    return {
      bitrixId: Number(r.manager_bitrix_user_id), name: r.manager_name, shortLogin: r.short_login ?? '', branch: o?.branch ?? r.branch ?? '∅', category: o?.category ?? '∅',
      plan: planBy.get(r.short_login ?? '') ?? 0, firstDealAt: r.first_deal_at ? new Date(r.first_deal_at) : null,
    };
  });
}

// ── Статистика ───────────────────────────────────────────────────────────────
const Z: Record<string, number> = { '0.8': 1.2816, '0.9': 1.6449, '0.95': 1.96 };
export function wilson(pPct: number, n: number, conf: number): { low: number; high: number } {
  const z = Z[String(conf)] ?? 1.6449, p = pPct / 100;
  const denom = 1 + z * z / n, centre = p + z * z / (2 * n), adj = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return { low: Math.max(0, (centre - adj) / denom) * 100, high: Math.min(1, (centre + adj) / denom) * 100 };
}
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mad = (xs: number[]) => { const m = median(xs); if (m === null) return null; return median(xs.map(x => Math.abs(x - m))); };

interface NodeMeta { id: string; higherIsBetter: boolean; windowKind: string }

interface PrevState { ewma: number | null; cusumPos: number | null; cusumNeg: number | null }

// ── Корень: прогноз плана ────────────────────────────────────────────────────
interface RootForecast { plan: number; fact: number; pending: number; pendingExpected: number; paceDaily: number; remainingDays: number; crSaleToShip: number; forecast: number; pct: number; gap: number; silent: boolean; tooLate: boolean }

async function computeRoot(managers: ActiveManager[], s: DiagSettings, today: string): Promise<Map<number, RootForecast>> {
  const monthFirst = `${today.slice(0, 7)}-01`;
  const wd = await getMonthWorkingDays(monthFirst, today);
  const remaining = Math.max(0, wd.total - wd.passed);
  const lags = await loadLags();
  const ids = managers.map(m => m.bitrixId);
  const sa = analyticsDb();
  const [fact, pending, pace, crShip] = await Promise.all([
    sa.query<{ m: string; amount: string }>(`SELECT current_manager_id AS m, coalesce(sum(amount), 0)::text AS amount FROM sa.deals WHERE current_manager_id = ANY($1::bigint[]) AND funnel_id IN (0,1,2,3) AND delivered_at >= $2::date GROUP BY 1`, [ids, monthFirst]),
    sa.query<{ m: string; head_group_name: string | null; amount: string; age_h: string }>(
      `SELECT current_manager_id AS m, head_group_name, amount::text, (EXTRACT(epoch FROM (now() - sold_at)) / 3600)::text AS age_h
         FROM sa.deals WHERE current_manager_id = ANY($1::bigint[]) AND funnel_id IN (0,1,2,3) AND sold_at IS NOT NULL AND delivered_at IS NULL AND lost_at IS NULL AND sold_at >= now() - interval '90 days'`, [ids]),
    sa.query<{ m: string; amount: string }>(`SELECT current_manager_id AS m, coalesce(sum(amount), 0)::text AS amount FROM sa.deals WHERE current_manager_id = ANY($1::bigint[]) AND funnel_id IN (0,1,2,3) AND sold_at >= now() - interval '21 days' GROUP BY 1`, [ids]),
    sa.query<{ m: string; sold: string; shipped: string }>(
      `SELECT current_manager_id AS m, coalesce(sum(amount), 0)::text AS sold, coalesce(sum(amount) FILTER (WHERE delivered_at IS NOT NULL), 0)::text AS shipped
         FROM sa.deals WHERE current_manager_id = ANY($1::bigint[]) AND funnel_id IN (0,1,2,3) AND sold_at >= now() - interval '120 days' AND sold_at < now() - interval '30 days' GROUP BY 1`, [ids]),
  ]);
  const factBy = new Map(fact.rows.map(r => [Number(r.m), Number(r.amount)]));
  const paceBy = new Map(pace.rows.map(r => [Number(r.m), Number(r.amount) / 15]));
  const crBy = new Map(crShip.rows.map(r => [Number(r.m), Number(r.sold) ? Number(r.shipped) / Number(r.sold) : 0.8]));
  const hoursLeft = remaining * 24;
  // P(отгрузится до конца месяца | группа, возраст): доля перехода sold→shipped, укладывающегося в оставшееся время с учётом уже прошедшего.
  const pShip = (group: string | null, ageH: number): number => {
    const l = lags.get(`${group ?? '∅'}|sold_to_shipped`) ?? lags.get('*|sold_to_shipped');
    if (!l) return 0.8;
    const t = ageH + hoursLeft;
    if (t >= l.p90) return 0.95; if (t >= l.p75) return 0.85; if (t >= l.p50) return 0.65; if (t >= l.p25) return 0.4; return 0.2;
  };
  const pendBy = new Map<number, { sum: number; exp: number }>();
  for (const r of pending.rows) {
    const e = pendBy.get(Number(r.m)) ?? pendBy.set(Number(r.m), { sum: 0, exp: 0 }).get(Number(r.m))!;
    e.sum += Number(r.amount); e.exp += Number(r.amount) * pShip(r.head_group_name, Number(r.age_h));
  }
  const out = new Map<number, RootForecast>();
  for (const m of managers) {
    const f = factBy.get(m.bitrixId) ?? 0, p = pendBy.get(m.bitrixId) ?? { sum: 0, exp: 0 }, paceD = paceBy.get(m.bitrixId) ?? 0, cr = crBy.get(m.bitrixId) ?? 0.8;
    const forecast = f + p.exp + paceD * remaining * cr;
    out.set(m.bitrixId, {
      plan: m.plan, fact: f, pending: p.sum, pendingExpected: p.exp, paceDaily: paceD, remainingDays: remaining, crSaleToShip: cr,
      forecast, pct: m.plan ? (forecast / m.plan) * 100 : 0, gap: m.plan - forecast,
      silent: wd.passed <= s.rootSilentDays, tooLate: remaining <= s.rootLateDays,
    });
  }
  return out;
}

// ── Главный проход ───────────────────────────────────────────────────────────
export interface DailyRunSummary { date: string; managers: number; series: number; insufficient: number; drifts: number; ms: number; errors: string[] }

export async function runDaily(opts: { today?: string } = {}): Promise<DailyRunSummary> {
  const t0 = Date.now();
  const today = opts.today ?? mskToday();
  const s = await loadDiagSettings();
  const sys = systemDb();
  const errors: string[] = [];
  const managers = await loadActiveManagers(`${today.slice(0, 7)}-01`);
  const nodesRes = await sys.query<{ id: string; higher_is_better: boolean; window_kind: string }>(`SELECT id, higher_is_better, window_kind FROM diag_nodes WHERE enabled`);
  const nodeMeta = new Map<string, NodeMeta>(nodesRes.rows.map(n => [n.id, { id: n.id, higherIsBetter: n.higher_is_better, windowKind: n.window_kind }]));

  const windows = await loadManagerWindows(managers.map(m => m.bitrixId));
  const roots = await computeRoot(managers, s, today).catch(e => { errors.push(`корень: ${e instanceof Error ? e.message : e}`); return new Map<number, RootForecast>(); });

  // Значения по менеджерам
  const cur = new Map<number, Record<string, NodeValue>>(), prev = new Map<number, Record<string, NodeValue>>();
  for (const m of managers) {
    const w = windows.get(m.bitrixId);
    if (!w) continue;
    cur.set(m.bitrixId, computeTickNodes(w.current, w.openDeals));
    prev.set(m.bitrixId, computeTickNodes(w.previous, w.openDeals));
  }
  // Пиры: медиана по филиал×направление среди менеджеров с достаточным n
  const peerGroups = new Map<string, number[]>();
  for (const m of managers) (peerGroups.get(`${m.branch}|${m.category}`) ?? peerGroups.set(`${m.branch}|${m.category}`, []).get(`${m.branch}|${m.category}`)!).push(m.bitrixId);
  const peerStat = (group: string, node: string, exclude: number): { median: number | null; mad: number | null; n: number } => {
    const xs = (peerGroups.get(group) ?? []).filter(id => id !== exclude).map(id => cur.get(id)?.[node]).filter((v): v is NodeValue => !!v && v.value !== null && v.n >= s.minClosed / 2).map(v => v.value as number);
    return { median: median(xs), mad: mad(xs), n: xs.length };
  };
  // Предыдущее состояние детекторов
  const prevState = await sys.query<{ subject_key: string; node_id: string; ewma: string | null; cusum_pos: string | null; cusum_neg: string | null }>(
    `SELECT DISTINCT ON (subject_key, node_id) subject_key, node_id, ewma, cusum_pos, cusum_neg FROM diag_series
      WHERE subject_type = 'manager' AND as_of < $1::date AND head_group_name IS NULL ORDER BY subject_key, node_id, as_of DESC`, [today]);
  const prevBy = new Map<string, PrevState>(prevState.rows.map(r => [`${r.subject_key}|${r.node_id}`, { ewma: r.ewma === null ? null : Number(r.ewma), cusumPos: r.cusum_pos === null ? null : Number(r.cusum_pos), cusumNeg: r.cusum_neg === null ? null : Number(r.cusum_neg) }]));

  let series = 0, insufficient = 0, drifts = 0;
  const upsert = async (mgr: number, nodeId: string, row: Record<string, unknown>) => {
    await sys.query(
      `INSERT INTO diag_series (subject_type, subject_key, node_id, head_group_name, as_of, tick_no, value, n, ci_low, ci_high, ewma, cusum_pos, cusum_neg, base_own, base_peers, base_target, sigma, status, trace)
       VALUES ('manager', $1, $2, NULL, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (subject_type, subject_key, node_id, coalesce(head_group_name, ''), as_of) DO UPDATE SET
         tick_no = EXCLUDED.tick_no, value = EXCLUDED.value, n = EXCLUDED.n, ci_low = EXCLUDED.ci_low, ci_high = EXCLUDED.ci_high, ewma = EXCLUDED.ewma,
         cusum_pos = EXCLUDED.cusum_pos, cusum_neg = EXCLUDED.cusum_neg, base_own = EXCLUDED.base_own, base_peers = EXCLUDED.base_peers, base_target = EXCLUDED.base_target,
         sigma = EXCLUDED.sigma, status = EXCLUDED.status, trace = EXCLUDED.trace`,
      [String(mgr), nodeId, today, row.tick_no ?? null, row.value ?? null, row.n ?? null, row.ci_low ?? null, row.ci_high ?? null, row.ewma ?? null, row.cusum_pos ?? null, row.cusum_neg ?? null,
       row.base_own ?? null, row.base_peers ?? null, row.base_target ?? null, row.sigma ?? null, row.status, JSON.stringify(row.trace ?? {})]);
    series++;
  };

  for (const m of managers) {
    const w = windows.get(m.bitrixId), c = cur.get(m.bitrixId), p = prev.get(m.bitrixId);
    if (!w || !c || !p) continue;
    const group = `${m.branch}|${m.category}`;
    for (const [nodeId, v] of Object.entries(c)) {
      const meta = nodeMeta.get(nodeId);
      if (!meta) continue;
      try {
        const own = p[nodeId]?.value ?? null;
        const peers = peerStat(group, nodeId, m.bitrixId);
        const enough = v.kind === 'count' ? w.openDeals.total > 0 : v.n >= s.minClosed;
        if (v.value === null || !enough) {
          insufficient++;
          await upsert(m.bitrixId, nodeId, { tick_no: w.tickNo, value: v.value, n: v.n, base_own: own, base_peers: peers.median, status: 'insufficient_data', trace: { reason: v.value === null ? 'нет значения' : `n=${v.n} < ${s.minClosed}` } });
          continue;
        }
        const base = own ?? peers.median;
        const ci = v.kind === 'share' ? wilson(v.value, v.n, s.wilsonConf) : null;
        // σ: для долей — биномиальная в п.п.; для средних/счётчиков — 1.4826·MAD по пирам.
        const sigma = v.kind === 'share' ? Math.sqrt((v.value / 100) * (1 - v.value / 100) / v.n) * 100 : (peers.mad !== null && peers.mad > 0 ? peers.mad * 1.4826 : Math.abs(v.value) * 0.2 || 1);
        const ps = prevBy.get(`${m.bitrixId}|${nodeId}`);
        const ewma = ps?.ewma === null || ps?.ewma === undefined ? v.value : s.ewmaLambda * v.value + (1 - s.ewmaLambda) * ps.ewma;
        let cusumPos = ps?.cusumPos ?? 0, cusumNeg = ps?.cusumNeg ?? 0;
        let status: 'ok' | 'drift_down' | 'drift_up' = 'ok';
        if (base !== null && sigma > 0) {
          // «Хуже» — ниже базы для higher_is_better, выше — для lower_is_better.
          const worse = meta.higherIsBetter ? base - v.value : v.value - base;
          const k = s.cusumKSigma * sigma;
          cusumNeg = Math.max(0, cusumNeg + worse - k);
          cusumPos = Math.max(0, cusumPos - worse - k);
          const outsideCI = ci ? (meta.higherIsBetter ? base > ci.high : base < ci.low) : Math.abs(worse) > 1.5 * sigma;
          if (cusumNeg > s.cusumHSigma * sigma && outsideCI) status = 'drift_down';
          else if (cusumPos > s.cusumHSigma * sigma) status = 'drift_up';
          if (cusumNeg === 0 && cusumPos === 0) { /* вернулись к базе */ }
        }
        if (status === 'drift_down') drifts++;
        await upsert(m.bitrixId, nodeId, {
          tick_no: w.tickNo, value: v.value, n: v.n, ci_low: ci?.low ?? null, ci_high: ci?.high ?? null, ewma, cusum_pos: cusumPos, cusum_neg: cusumNeg,
          base_own: own, base_peers: peers.median, sigma, status,
          trace: { kind: v.kind, baseUsed: own !== null ? 'own' : peers.median !== null ? 'peers' : null, peersN: peers.n, window: w.current.length, prevWindow: w.previous.length },
        });
      } catch (e) { errors.push(`${m.name}/${nodeId}: ${e instanceof Error ? e.message : e}`); }
    }
    // Корень
    const r = roots.get(m.bitrixId);
    if (r) {
      try {
        await upsert(m.bitrixId, 'plan_forecast_pct_month', {
          value: r.pct, n: 1, base_target: 100, status: r.silent ? 'ok' : r.pct < 100 - s.criticalGapShare * 100 ? 'drift_down' : 'ok',
          trace: { ...r, gapRub: r.gap, silent: r.silent, tooLate: r.tooLate },
        });
        await upsert(m.bitrixId, 'shipments_forecast_month', { value: r.forecast, n: 1, base_target: r.plan, status: 'ok', trace: { fact: r.fact, pendingExpected: r.pendingExpected, pace: r.paceDaily * r.remainingDays * r.crSaleToShip } });
        await upsert(m.bitrixId, 'plan_shipments_month', { value: r.plan, n: 1, status: 'ok', trace: {} });
      } catch (e) { errors.push(`${m.name}/root: ${e instanceof Error ? e.message : e}`); }
    }
  }
  return { date: today, managers: managers.length, series, insufficient, drifts, ms: Date.now() - t0, errors: errors.slice(0, 30) };
}
