// Декомпозиция и диагноз (ТЗ №1 §8, §9), уровень «менеджер».
//
// Правки 10.09 после первого живого прогона (владелец: «99% рычагов — идти к РОПу; сделка без
// единого звонка → О БОЖЕ НАДО ЗВОНИТЬ?! что за хуета»):
//  1. ПРАКТИЧЕСКАЯ значимость обязательна вместе со статистической. У узла есть norm_good
//     (внутри нормы диагноза нет вообще — 7% сделок без звонка при норме 10% не проблема, даже
//     если в прошлом окне было 0%) и min_delta (минимальное значимое отклонение от базы).
//  2. СПУСК ПО ДЕРЕВУ: просевший результатный узел (CR сделка→продажа) больше не даёт
//     «рычаг не найден» — идём вниз по mult/add-рёбрам к ребёнку с наибольшим вкладом и ищем
//     рычаг там (цена → бронь → продажа → листья поведения).
//  3. ЛИСТ САМ СЕБЕ РЫЧАГ: если просел лист поведения (скорость первого касания), рычаг = он
//     сам («ускорь касание»), а не «иди к РОПу».
//  4. Диагноз без рычага — это НАБЛЮДЕНИЕ для РОПа (recipient_role='rop'), фокус не занимает
//     и в основном списке менеджерских диагнозов не показывается.
import { systemDb } from '@/lib/db/clients';
import { loadDiagSettings } from './settings';
import type { Progress } from './runs';
import type { ActiveManager } from './daily';

interface SeriesRow { node_id: string; value: string | null; n: number | null; ci_low: string | null; ci_high: string | null; base_own: string | null; base_peers: string | null; sigma: string | null; status: string; trace: Record<string, unknown> | null }
interface Node { id: string; name: string; controllable: string; higher_is_better: boolean; node_kind: string; recipient_role: string | null; norm_good: string | null; min_delta: string | null; unit: string | null }
interface Edge { id: number; parent_id: string; child_id: string; edge_type: string; weight: number; status: string }

const num = (v: string | null) => (v === null ? null : Number(v));
const CONF: Record<string, number> = { confirmed: 1, expert: 0.7, testing: 0.5, rejected: 0 };
const MIN_SIGMA_DEV = 1.5;

interface NodeEval {
  id: string; name: string; value: number; base: number; sigma: number;
  /** Насколько хуже базы в единицах узла (>0 — хуже). */
  worse: number;
  devSigma: number; status: string; n: number; outsideCI: boolean;
  insideNorm: boolean; normGood: number | null; minDelta: number; unit: string | null;
  /** Статистически + практически значимая просадка. */
  problem: boolean;
}

function evalNode(row: SeriesRow, node: Node): NodeEval | null {
  const value = num(row.value), base = num(row.base_own) ?? num(row.base_peers), sigma = num(row.sigma);
  if (value === null || row.status === 'insufficient_data') return null;
  const normGood = num(node.norm_good), minDelta = num(node.min_delta) ?? 0;
  const insideNorm = normGood !== null && (node.higher_is_better ? value >= normGood : value <= normGood);
  if (base === null || sigma === null || sigma <= 0) {
    // Без базы судим только по норме: хуже нормы — проблема, иначе нет.
    if (normGood === null || insideNorm) return null;
    const worseVsNorm = node.higher_is_better ? normGood - value : value - normGood;
    return { id: node.id, name: node.name, value, base: normGood, sigma: Math.max(1, minDelta), worse: worseVsNorm,
      devSigma: Math.min(5, worseVsNorm / Math.max(1, minDelta)), status: row.status, n: row.n ?? 0, outsideCI: true,
      insideNorm, normGood, minDelta, unit: node.unit, problem: worseVsNorm >= minDelta };
  }
  const worse = node.higher_is_better ? base - value : value - base;
  const lo = num(row.ci_low), hi = num(row.ci_high);
  const outsideCI = lo !== null && hi !== null ? (node.higher_is_better ? base > hi : base < lo) : Math.abs(worse) > MIN_SIGMA_DEV * sigma;
  const devSigma = Math.min(5, Math.max(0, worse / sigma));
  const statSignificant = row.status === 'drift_down' || (outsideCI && devSigma >= MIN_SIGMA_DEV);
  const practical = worse >= minDelta && !insideNorm;
  return { id: node.id, name: node.name, value, base, sigma, worse, devSigma, status: row.status, n: row.n ?? 0, outsideCI,
    insideNorm, normGood, minDelta, unit: node.unit, problem: statSignificant && practical };
}

export interface DiagnoseSummary { managers: number; opened: number; queued: number; observations: number; closed: number; skipped: number; candidates: number }

export async function runDiagnose(managers: ActiveManager[], today: string, progress?: Progress): Promise<DiagnoseSummary> {
  const s = await loadDiagSettings();
  const sys = systemDb();
  const [nodesRes, edgesRes, seriesRes, openRes, recentRes] = await Promise.all([
    sys.query<Node>(`SELECT id, name, controllable, higher_is_better, node_kind, recipient_role, norm_good::text, min_delta::text, unit FROM diag_nodes WHERE enabled`),
    sys.query<Edge>(`SELECT id, parent_id, child_id, edge_type, weight::float AS weight, status FROM diag_edges`),
    sys.query<SeriesRow & { subject_key: string }>(`SELECT subject_key, node_id, value, n, ci_low, ci_high, base_own, base_peers, sigma, status, trace FROM diag_series WHERE subject_type = 'manager' AND head_group_name IS NULL AND as_of = $1::date`, [today]),
    sys.query<{ id: string; subject_key: string; node_id: string; lever_id: string | null; status: string; opened_at: Date; arm: string }>(
      `SELECT id::text, subject_key, node_id, lever_id, status, opened_at, arm FROM diag_diagnoses WHERE subject_type = 'manager' AND status IN ('open', 'queued', 'in_scenario', 'disputed')`),
    sys.query<{ subject_key: string; lever_id: string; arm: string }>(
      `SELECT DISTINCT ON (subject_key, lever_id) subject_key, lever_id, arm FROM diag_diagnoses WHERE subject_type = 'manager' AND lever_id IS NOT NULL AND opened_at > now() - interval '60 days' ORDER BY subject_key, lever_id, opened_at DESC`),
  ]);
  const nodes = new Map(nodesRes.rows.map(n => [n.id, n]));
  const structByParent = new Map<string, Edge[]>();  // mult/add — арифметика
  const hypByParent = new Map<string, Edge[]>();     // гипотезы — рычаги
  const hypByChild = new Map<string, Edge>();        // входящее hyp-ребро: узел сам себе рычаг
  for (const e of edgesRes.rows) {
    if (e.edge_type === 'hyp') { (hypByParent.get(e.parent_id) ?? hypByParent.set(e.parent_id, []).get(e.parent_id)!).push(e); hypByChild.set(e.child_id, e); }
    else (structByParent.get(e.parent_id) ?? structByParent.set(e.parent_id, []).get(e.parent_id)!).push(e);
  }
  const seriesBy = new Map<string, Map<string, SeriesRow>>();
  for (const r of seriesRes.rows) (seriesBy.get(r.subject_key) ?? seriesBy.set(r.subject_key, new Map()).get(r.subject_key)!).set(r.node_id, r);
  const openBy = new Map<string, typeof openRes.rows>();
  for (const d of openRes.rows) (openBy.get(d.subject_key) ?? openBy.set(d.subject_key, []).get(d.subject_key)!).push(d);
  const recentArm = new Map(recentRes.rows.map(r => [`${r.subject_key}|${r.lever_id}`, r.arm]));

  let opened = 0, queued = 0, observations = 0, closed = 0, skipped = 0, candidates = 0, idx = 0;
  for (const m of managers) {
    idx++;
    if (progress && idx % 10 === 0) await progress(`диагнозы: ${idx} из ${managers.length}`, idx, managers.length);
    const key = String(m.bitrixId);
    const series = seriesBy.get(key);
    if (!series) continue;
    const evals = new Map<string, NodeEval>();
    for (const [nodeId, row] of series) { const n = nodes.get(nodeId); if (!n) continue; const ev = evalNode(row, n); if (ev) evals.set(nodeId, ev); }

    const root = series.get('plan_forecast_pct_month');
    const rt = (root?.trace ?? {}) as { gapRub?: number; plan?: number; silent?: boolean; tooLate?: boolean };
    const gapRub = rt.silent ? 0 : Math.max(0, rt.gapRub ?? 0);
    const gapShare = rt.plan ? gapRub / rt.plan : 0;
    const tenureDays = m.firstDealAt ? (Date.now() - m.firstDealAt.getTime()) / 86400000 : 9999;
    const mode: 'normal' | 'onboarding' = tenureDays < s.noviceDays ? 'onboarding' : 'normal';

    // ── Закрытие открытых ────────────────────────────────────────────────────
    const open = openBy.get(key) ?? [];
    for (const d of open) {
      if (d.status === 'in_scenario') continue;
      const ageDays = (Date.now() - new Date(d.opened_at).getTime()) / 86400000;
      const nodeEv = evals.get(d.node_id), leverEv = d.lever_id ? evals.get(d.lever_id) : null;
      const recovered = (!nodeEv || !nodeEv.problem) && (!leverEv || !leverEv.problem);
      if (recovered || ageDays > 45) {
        await sys.query(`UPDATE diag_diagnoses SET status = 'closed', outcome = $2, closed_at = now() WHERE id = $1`, [d.id, recovered ? 'recovered' : 'expired']);
        closed++;
      }
    }
    const stillOpen = open.filter(d => d.status !== 'closed');
    const hasFocus = stillOpen.some(d => d.lever_id);

    // ── Спуск по арифметике: от узла к ребёнку с наибольшим вкладом в просадку ──
    const descend = (startId: string, path: string[] = []): { nodeId: string; path: string[] } => {
      const kids = (structByParent.get(startId) ?? []).map(e => ({ e, ev: evals.get(e.child_id) })).filter(x => x.ev && x.ev.worse > 0);
      if (!kids.length) return { nodeId: startId, path };
      // Вклад: mult — относительная просадка, add — абсолютная (в единицах родителя).
      const scored = kids.map(x => ({ ...x, contrib: x.e.edge_type === 'mult' ? x.ev!.worse / Math.max(1e-9, Math.abs(x.ev!.base)) : x.ev!.worse }));
      scored.sort((a, b) => b.contrib - a.contrib);
      const best = scored[0];
      if (!best.ev!.problem && path.length >= 3) return { nodeId: startId, path };
      return descend(best.e.child_id, [...path, best.e.child_id]);
    };

    // ── Кандидаты ────────────────────────────────────────────────────────────
    type Cand = { nodeId: string; leverId: string | null; score: number; nodeEv: NodeEval; leverEv: NodeEval | null; edge: Edge | null; path: string[] };
    const cands: Cand[] = [];
    for (const [nodeId, ev] of evals) {
      const node = nodes.get(nodeId)!;
      if (!ev.problem || node.node_kind === 'forecast' || node.controllable === 'no') continue;
      // Спуск: где именно ломается.
      const bottom = descend(nodeId);
      const bottomEv = evals.get(bottom.nodeId) ?? ev;
      const bottomNode = nodes.get(bottom.nodeId)!;
      // Рычаги: hyp-листья под найденным узлом (и под исходным, если спуск ничего не дал).
      const leafEdges = [...(hypByParent.get(bottom.nodeId) ?? []), ...(bottom.nodeId === nodeId ? [] : hypByParent.get(nodeId) ?? [])];
      let added = false;
      for (const e of leafEdges) {
        const lev = evals.get(e.child_id);
        if (!lev || !lev.problem || CONF[e.status] === 0 || nodes.get(e.child_id)?.controllable === 'no') continue;
        cands.push({ nodeId: bottom.nodeId, leverId: e.child_id, score: Math.max(1, bottomEv.devSigma) * e.weight * CONF[e.status] * Math.max(1, lev.devSigma) * (1 + gapShare), nodeEv: bottomEv, leverEv: lev, edge: e, path: bottom.path });
        added = true;
      }
      // Узел сам себе рычаг (лист поведения просел — действие очевидно).
      if (!added && bottomNode.controllable === 'yes' && hypByChild.has(bottom.nodeId)) {
        const e = hypByChild.get(bottom.nodeId)!;
        cands.push({ nodeId: bottom.nodeId, leverId: bottom.nodeId, score: Math.max(1, bottomEv.devSigma) * Math.max(0.5, e.weight) * CONF[e.status] * (1 + gapShare), nodeEv: bottomEv, leverEv: bottomEv, edge: e, path: bottom.path });
        added = true;
      }
      // Ни рычага, ни листа — наблюдение для РОПа.
      if (!added) cands.push({ nodeId: bottom.nodeId, leverId: null, score: bottomEv.devSigma * 0.3 * (1 + gapShare), nodeEv: bottomEv, leverEv: null, edge: null, path: bottom.path });
    }
    candidates += cands.length;
    if (!cands.length) continue;

    // Лучший диагноз с рычагом + лучшее наблюдение (они не конкурируют).
    const withLever = cands.filter(c => c.leverId).sort((a, b) => b.score - a.score);
    const withoutLever = cands.filter(c => !c.leverId).sort((a, b) => b.score - a.score);
    const picks: Cand[] = [];
    if (withLever[0]) picks.push(withLever[0]);
    if (withoutLever[0] && !withLever.length) picks.push(withoutLever[0]);

    for (const best of picks) {
      if (stillOpen.some(d => d.node_id === best.nodeId && (d.lever_id ?? null) === best.leverId)) { skipped++; continue; }
      let arm: 'treatment' | 'control' = 'treatment';
      let armReason = 'наблюдение без рычага — всегда treatment';
      if (best.leverId) {
        const prev = recentArm.get(`${key}|${best.leverId}`);
        if (mode === 'onboarding') armReason = 'новичок — всегда воздействие';
        else if (gapShare > s.criticalGapShare) armReason = `разрыв ${(gapShare * 100).toFixed(0)}% плана больше критического — воздействие`;
        else if (prev) { arm = prev as 'treatment' | 'control'; armReason = 'та же рука, что у прошлого диагноза по этому рычагу (60 дн)'; }
        else { const share = best.edge?.status === 'confirmed' ? s.controlShareConfirmed : s.controlShareTesting; arm = Math.random() < share ? 'control' : 'treatment'; armReason = `рандомизация, доля контроля ${share}`; }
      }
      const status = best.leverId ? (hasFocus ? 'queued' : 'open') : 'open';
      const node = nodes.get(best.nodeId)!;
      const trace = {
        root: { pct: num(root?.value ?? null), gapRub, gapShare: Math.round(gapShare * 1000) / 1000, silent: !!rt.silent, tooLate: !!rt.tooLate },
        node: { id: best.nodeId, name: node.name, value: best.nodeEv.value, base: best.nodeEv.base, worse: Math.round(best.nodeEv.worse * 100) / 100,
                devSigma: Math.round(best.nodeEv.devSigma * 100) / 100, n: best.nodeEv.n, normGood: best.nodeEv.normGood, minDelta: best.nodeEv.minDelta, unit: best.nodeEv.unit },
        lever: best.leverId && best.leverEv ? { id: best.leverId, name: nodes.get(best.leverId)?.name, value: best.leverEv.value, base: best.leverEv.base,
                worse: Math.round(best.leverEv.worse * 100) / 100, devSigma: Math.round(best.leverEv.devSigma * 100) / 100, n: best.leverEv.n,
                normGood: best.leverEv.normGood, unit: best.leverEv.unit, selfLever: best.leverId === best.nodeId, edgeWeight: best.edge?.weight, edgeStatus: best.edge?.status } : null,
        descendPath: best.path,
        candidates: cands.slice(0, 8).map(c => ({ node: c.nodeId, lever: c.leverId, score: Math.round(c.score * 100) / 100 })),
        arm: { arm, reason: armReason }, mode, tenureDays: Math.round(tenureDays),
      };
      await sys.query(
        `INSERT INTO diag_diagnoses (subject_type, subject_key, node_id, lever_id, gap_value, gap_share, score, confidence, mode, arm, too_late_for_month, recipient_role, status, trace)
         VALUES ('manager', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [key, best.nodeId, best.leverId, best.nodeEv.worse, gapShare, best.score, best.edge ? CONF[best.edge.status] : null,
         mode, arm, !!rt.tooLate, best.leverId ? null : 'rop', status, JSON.stringify(trace)]);
      if (!best.leverId) observations++;
      else if (status === 'open') opened++; else queued++;
    }
  }
  return { managers: managers.length, opened, queued, observations, closed, skipped, candidates };
}
