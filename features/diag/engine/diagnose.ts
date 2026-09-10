// Декомпозиция и диагноз (ТЗ №1 §8, §9), уровень «менеджер». Работает по СЕГОДНЯШНИМ рядам
// diag_series и дереву diag_nodes/diag_edges:
//  1. Проблемные узлы — управляемые (controllable=yes) узлы со статусом «просадка» или с
//     базой вне интервала; тяжесть = |значение − база| / σ (cap 5). Разрыв корня (₽) — множитель
//     приоритета: чем больше недостача к плану, тем важнее диагноз.
//  2. Рычаги — листья по рёбрам hyp под проблемным узлом; отклонение листа в σ в «плохую»
//     сторону (0, если внутри интервала). score = тяжесть узла × вес ребра × уверенность ребра
//     (confirmed 1 / expert 0.7 / testing 0.5 / rejected 0) × отклонение листа × (1 + доля разрыва).
//     Лист без просевшего родителя тоже допустим (тяжесть 0.5) — «поведение ушло, результат ещё нет».
//  3. Один фокус: у менеджера не больше одного открытого диагноза с рычагом; новый по другому
//     рычагу — queued; по тому же — не дублируется. Рука: control с вероятностью
//     control_share_{testing|confirmed} по статусу ребра; всегда treatment для новичков
//     (mode=onboarding) и при разрыве > critical_gap_share плана; повтор по тому же рычагу за 60
//     дней наследует руку. Отправок здесь нет — только запись в diag_diagnoses.
//  4. Закрытие открытых (не в сценарии): узел и лист вернулись в норму → outcome 'recovered';
//     старше 45 дней → 'expired'.
import { systemDb } from '@/lib/db/clients';
import { loadDiagSettings } from './settings';
import type { Progress } from './runs';
import type { ActiveManager } from './daily';

interface SeriesRow { node_id: string; value: string | null; n: number | null; ci_low: string | null; ci_high: string | null; base_own: string | null; base_peers: string | null; sigma: string | null; status: string; trace: Record<string, unknown> | null }
interface Node { id: string; name: string; controllable: string; higher_is_better: boolean; node_kind: string; recipient_role: string | null }
interface Edge { id: number; parent_id: string; child_id: string; edge_type: string; weight: number; status: string }

const num = (v: string | null) => (v === null ? null : Number(v));
const CONF: Record<string, number> = { confirmed: 1, expert: 0.7, testing: 0.5, rejected: 0 };

interface NodeEval { value: number; base: number; sigma: number; devSigma: number; status: string; n: number; outsideCI: boolean }

/** Отклонение узла в «плохую» сторону, в σ (≥0). */
function evalNode(row: SeriesRow, node: Node): NodeEval | null {
  const value = num(row.value), base = num(row.base_own) ?? num(row.base_peers), sigma = num(row.sigma);
  if (value === null || base === null || sigma === null || sigma <= 0 || row.status === 'insufficient_data') return null;
  const worse = node.higher_is_better ? base - value : value - base;
  const lo = num(row.ci_low), hi = num(row.ci_high);
  const outsideCI = lo !== null && hi !== null ? (node.higher_is_better ? base > hi : base < lo) : Math.abs(worse) > 1.5 * sigma;
  return { value, base, sigma, devSigma: Math.min(5, Math.max(0, worse / sigma)), status: row.status, n: row.n ?? 0, outsideCI };
}

export interface DiagnoseSummary { managers: number; opened: number; queued: number; closed: number; skipped: number; candidates: number }

export async function runDiagnose(managers: ActiveManager[], today: string, progress?: Progress): Promise<DiagnoseSummary> {
  const s = await loadDiagSettings();
  const sys = systemDb();
  const [nodesRes, edgesRes, seriesRes, openRes, recentRes] = await Promise.all([
    sys.query<Node>(`SELECT id, name, controllable, higher_is_better, node_kind, recipient_role FROM diag_nodes WHERE enabled`),
    sys.query<Edge>(`SELECT id, parent_id, child_id, edge_type, weight::float AS weight, status FROM diag_edges`),
    sys.query<SeriesRow & { subject_key: string }>(`SELECT subject_key, node_id, value, n, ci_low, ci_high, base_own, base_peers, sigma, status, trace FROM diag_series WHERE subject_type = 'manager' AND head_group_name IS NULL AND as_of = $1::date`, [today]),
    sys.query<{ id: string; subject_key: string; node_id: string; lever_id: string | null; status: string; opened_at: Date; arm: string }>(
      `SELECT id::text, subject_key, node_id, lever_id, status, opened_at, arm FROM diag_diagnoses WHERE subject_type = 'manager' AND status IN ('open', 'queued', 'in_scenario', 'disputed')`),
    sys.query<{ subject_key: string; lever_id: string; arm: string }>(
      `SELECT DISTINCT ON (subject_key, lever_id) subject_key, lever_id, arm FROM diag_diagnoses WHERE subject_type = 'manager' AND lever_id IS NOT NULL AND opened_at > now() - interval '60 days' ORDER BY subject_key, lever_id, opened_at DESC`),
  ]);
  const nodes = new Map(nodesRes.rows.map(n => [n.id, n]));
  const hypByParent = new Map<string, Edge[]>();
  for (const e of edgesRes.rows) if (e.edge_type === 'hyp') (hypByParent.get(e.parent_id) ?? hypByParent.set(e.parent_id, []).get(e.parent_id)!).push(e);
  const seriesBy = new Map<string, Map<string, SeriesRow>>();
  for (const r of seriesRes.rows) (seriesBy.get(r.subject_key) ?? seriesBy.set(r.subject_key, new Map()).get(r.subject_key)!).set(r.node_id, r);
  const openBy = new Map<string, typeof openRes.rows>();
  for (const d of openRes.rows) (openBy.get(d.subject_key) ?? openBy.set(d.subject_key, []).get(d.subject_key)!).push(d);
  const recentArm = new Map(recentRes.rows.map(r => [`${r.subject_key}|${r.lever_id}`, r.arm]));

  let opened = 0, queued = 0, closed = 0, skipped = 0, candidates = 0, idx = 0;
  for (const m of managers) {
    idx++;
    if (progress && idx % 10 === 0) await progress(`диагнозы: ${idx} из ${managers.length}`, idx, managers.length);
    const key = String(m.bitrixId);
    const series = seriesBy.get(key);
    if (!series) continue;
    const evals = new Map<string, NodeEval>();
    for (const [nodeId, row] of series) { const n = nodes.get(nodeId); if (!n) continue; const ev = evalNode(row, n); if (ev) evals.set(nodeId, ev); }

    // Корень: разрыв к плану.
    const root = series.get('plan_forecast_pct_month');
    const rt = (root?.trace ?? {}) as { gapRub?: number; plan?: number; silent?: boolean; tooLate?: boolean };
    const gapRub = rt.silent ? 0 : Math.max(0, rt.gapRub ?? 0);
    const gapShare = rt.plan ? gapRub / rt.plan : 0;
    const tenureDays = m.firstDealAt ? (Date.now() - m.firstDealAt.getTime()) / 86400000 : 9999;
    const mode: 'normal' | 'onboarding' = tenureDays < s.noviceDays ? 'onboarding' : 'normal';

    // Закрытие открытых: узел и лист в норме.
    const open = openBy.get(key) ?? [];
    for (const d of open) {
      if (d.status === 'in_scenario') continue;
      const ageDays = (Date.now() - new Date(d.opened_at).getTime()) / 86400000;
      const nodeEv = evals.get(d.node_id), leverEv = d.lever_id ? evals.get(d.lever_id) : null;
      const recovered = nodeEv ? nodeEv.devSigma === 0 && (!leverEv || leverEv.devSigma === 0) : false;
      if (recovered || ageDays > 45) {
        await sys.query(`UPDATE diag_diagnoses SET status = 'closed', outcome = $2, closed_at = now() WHERE id = $1`, [d.id, recovered ? 'recovered' : 'expired']);
        closed++;
      }
    }
    const stillOpen = open.filter(d => d.status !== 'closed');
    const hasFocus = stillOpen.some(d => d.lever_id && (d.status === 'open' || d.status === 'in_scenario' || d.status === 'disputed'));

    // Кандидаты: проблемный узел × рычаг.
    type Cand = { nodeId: string; leverId: string | null; score: number; nodeEv: NodeEval | null; leverEv: NodeEval | null; edge: Edge | null };
    const cands: Cand[] = [];
    for (const [nodeId, ev] of evals) {
      const node = nodes.get(nodeId)!;
      if (node.controllable !== 'yes' || node.node_kind === 'forecast') continue;
      const leaves = hypByParent.get(nodeId) ?? [];
      const nodeBad = ev.status === 'drift_down' || (ev.outsideCI && ev.devSigma >= 1);
      const severity = nodeBad ? Math.max(1, ev.devSigma) : 0;
      for (const e of leaves) {
        const lev = evals.get(e.child_id);
        if (!lev || CONF[e.status] === 0) continue;
        const leafDev = lev.outsideCI ? lev.devSigma : 0;
        if (leafDev <= 0) continue;
        const sev = severity > 0 ? severity : 0.5; // лист просел, родитель ещё нет
        cands.push({ nodeId, leverId: e.child_id, score: sev * e.weight * CONF[e.status] * leafDev * (1 + gapShare), nodeEv: ev, leverEv: lev, edge: e });
      }
      if (nodeBad && !leaves.some(e => evals.get(e.child_id)?.outsideCI)) {
        // Узел просел, ни один рычаг не отклонился — диагноз без рычага, РОПу.
        cands.push({ nodeId, leverId: null, score: severity * 0.3 * (1 + gapShare), nodeEv: ev, leverEv: null, edge: null });
      }
    }
    candidates += cands.length;
    if (!cands.length) continue;
    cands.sort((a, b) => b.score - a.score);
    const best = cands[0];
    // Дубль по тому же узлу/рычагу — не открываем.
    if (stillOpen.some(d => d.node_id === best.nodeId && (d.lever_id ?? null) === best.leverId)) { skipped++; continue; }

    // Рука.
    let arm: 'treatment' | 'control' = 'treatment';
    let armReason = 'нет рычага';
    if (best.leverId) {
      const prev = recentArm.get(`${key}|${best.leverId}`);
      if (mode === 'onboarding') armReason = 'новичок — всегда treatment';
      else if (gapShare > s.criticalGapShare) armReason = `разрыв ${(gapShare * 100).toFixed(0)}% плана > критического — treatment`;
      else if (prev) { arm = prev as 'treatment' | 'control'; armReason = 'та же рука, что у прошлого диагноза по этому рычагу (60 дн)'; }
      else { const share = best.edge?.status === 'confirmed' ? s.controlShareConfirmed : s.controlShareTesting; arm = Math.random() < share ? 'control' : 'treatment'; armReason = `рандомизация, доля контроля ${share}`; }
    }
    const status = best.leverId && hasFocus ? 'queued' : 'open';
    const node = nodes.get(best.nodeId)!;
    const trace = {
      root: { pct: num(root?.value ?? null), gapRub, gapShare: Math.round(gapShare * 1000) / 1000, silent: !!rt.silent, tooLate: !!rt.tooLate },
      node: { id: best.nodeId, name: node.name, ...best.nodeEv },
      lever: best.leverId ? { id: best.leverId, name: nodes.get(best.leverId)?.name, ...best.leverEv, edgeWeight: best.edge?.weight, edgeStatus: best.edge?.status } : null,
      candidates: cands.slice(0, 6).map(c => ({ node: c.nodeId, lever: c.leverId, score: Math.round(c.score * 100) / 100 })),
      arm: { arm, reason: armReason }, mode, tenureDays: Math.round(tenureDays),
    };
    await sys.query(
      `INSERT INTO diag_diagnoses (subject_type, subject_key, node_id, lever_id, gap_value, gap_share, score, confidence, mode, arm, too_late_for_month, recipient_role, status, trace)
       VALUES ('manager', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [key, best.nodeId, best.leverId, best.nodeEv ? best.nodeEv.base - best.nodeEv.value : null, gapShare, best.score, best.edge ? CONF[best.edge.status] : null,
       mode, arm, !!rt.tooLate, best.leverId ? null : 'rop', status, JSON.stringify(trace)]);
    if (status === 'open') opened++; else queued++;
  }
  return { managers: managers.length, opened, queued, closed, skipped, candidates };
}
