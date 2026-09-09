// Движок сценариев авто-коучинга бота «Аналитик» (задача владельца 09.09.2026).
// Формат сценария — lib/jobs/scenarioFlow.ts (триггер + дерево блоков). Здесь:
//  1. Показатель на менеджера — fetchByManagers → computeCalculated (тот же счёт, что
//     отчёт «По менеджерам») за окно trigger.windowDays до вчера; база own_avg — то
//     же за baselineDays до окна. Порог = база − dropThreshold.
//  2. Цепочка (bot_scenario_runs) — одна открытая на пару сценарий+менеджер: ветка,
//     блок, с которого продолжать, дата возобновления, vars {startValue,…}.
//     Нет цепочки: значение < порога → стартуем ветку below, ≥ базы → ветку norm
//     (если ветка не пустая и не идёт пауза после прошлой цепочки этой ветки).
//     Есть цепочка с resume_at ≤ сегодня — продолжаем с node_id.
//  3. Исполнение блоков за один день: message → отправить и идти дальше (но не больше
//     ОДНОГО сообщения сценариев менеджеру в день по всем сценариям — второе
//     откладывается на завтра); wait → resume_at = сегодня+N, стоп; check → свежее
//     значение против условия, дальше по ветке да/нет (пустая ветка = дальше по
//     основной); end / конец списка → цепочка закрыта, пауза cooldown.
//  4. Неактивные аккаунты (fetchWorkingManagers) и отказавшиеся от бота
//     (manager_bot_prefs.enabled) не трогаем. Отправка — только sendManagerBotMessage
//     (лог, ID, кнопки), msgType scenario_message → функция бота 'scenarios' (OFF по
//     умолчанию).
// evaluateScenario() — чистый расчёт без записи (превью в редакторе, работает и для
// несохранённого черновика), runScenario() — расчёт + отправка + запись состояния.

import { systemDb } from '@/lib/db/clients';
import { loadMetrics, withDependencies } from '@/lib/metrics/catalog';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { computeCalculated } from '@/features/reports/engine/calculated';
import { sendManagerBotMessage } from '@/features/badges/engine/notifications';
import { channelEnabled } from '@/lib/bitrix/notify';
import { formatValue } from '@/lib/format';
import { fetchWorkingManagers, fetchManagerBotPrefs, mskDateStr, addDaysStr, mskIsoWeekday } from './managerDigest';
import {
  indexFlow, nextAfter, renderTemplate, validateFlow,
  type FlowBranch, type FlowNode, type ScenarioFlow, type CheckCondition, type NodeRef,
} from './scenarioFlow';
import type { Metric } from '@/lib/metrics/types';

export interface Scenario {
  id: string;
  name: string;
  enabled: boolean;
  flow: ScenarioFlow;
  checkHour: number;
  weekdaysOnly: boolean;
  lastRunAt: string | null;
  lastRunSummary: RunSummary | { date: string; error: string } | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunSummary {
  date: string;
  managers: number;
  noData: number;
  below: number;
  norm: number;
  started: number;      // новых цепочек
  continued: number;    // продолженных
  messages: number;     // сообщений
  closed: number;       // закрытых цепочек
  deferred: number;     // отложено антиспамом
  dryPreview?: boolean;
}

/** Один шаг исполнения за сегодня — для превью и журнала. */
export interface ExecStep {
  nodeId: string | null;
  type: 'start' | 'message' | 'wait' | 'check' | 'end' | 'deferred';
  label: string;
  text?: string;
  result?: boolean;
}

export type RunResult = 'recovered' | 'improved' | 'same' | 'worse' | 'praise';

/** Итог цепочки: для ветки «просадка» — где значение относительно порога/старта. */
export function runResult(branch: FlowBranch, value: number | null, startValue: number | null, threshold: number | null): RunResult {
  if (branch === 'norm') return 'praise';
  if (value === null) return 'same';
  if (threshold !== null && value >= threshold) return 'recovered';
  if (startValue === null) return 'same';
  const eps = Math.abs(startValue) * 0.005;
  if (value > startValue + eps) return 'improved';
  if (value < startValue - eps) return 'worse';
  return 'same';
}

export interface ManagerEval {
  bitrixId: number;
  name: string;
  value: number | null;
  base: number | null;
  threshold: number | null;
  delta: number | null;
  status: 'no_data' | 'below' | 'between' | 'norm';
  /** Открытая цепочка до сегодняшнего шага. */
  run: { id: number; branch: FlowBranch; nodeId: string | null; resumeAt: string | null; startValue: number | null; messagesSent: number } | null;
  /** Что происходит сегодня. */
  steps: ExecStep[];
  messages: { nodeId: string; text: string }[];
  /** Итог дня человеческим языком. */
  outcome: string;
  /** Новое состояние цепочки после сегодняшних шагов (null — без изменений). */
  next: { status: 'open'; branch: FlowBranch; nodeId: string; resumeAt: string; startValue: number | null }
      | { status: 'closed'; reason: string; restartable: boolean; cooldownDays: number }
      | null;
  /** Итог цепочки при закрытии — для оценки эффективности. */
  result: RunResult | null;
  /** Стартовать ли новую цепочку (ветка) — для записи. */
  startBranch: FlowBranch | null;
}

interface ScenarioRow {
  id: string; name: string; enabled: boolean; flow: unknown; check_hour: number; weekdays_only: boolean;
  last_run_at: string | Date | null; last_run_summary: Scenario['lastRunSummary']; created_by: string | null;
  created_at: string | Date; updated_at: string | Date;
}

const iso = (d: string | Date | null): string | null => (d ? new Date(d).toISOString() : null);

function rowToScenario(r: ScenarioRow): Scenario {
  return {
    id: r.id, name: r.name, enabled: r.enabled, flow: validateFlow(r.flow).flow,
    checkHour: r.check_hour, weekdaysOnly: r.weekdays_only,
    lastRunAt: iso(r.last_run_at), lastRunSummary: r.last_run_summary,
    createdBy: r.created_by, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}

const COLS = `id::text, name, enabled, flow, check_hour, weekdays_only, last_run_at, last_run_summary, created_by, created_at, updated_at`;

export async function loadScenarios(): Promise<Scenario[]> {
  const r = await systemDb().query<ScenarioRow>(`SELECT ${COLS} FROM bot_scenarios ORDER BY created_at`);
  return r.rows.map(rowToScenario);
}
export async function loadScenario(id: string): Promise<Scenario | null> {
  const r = await systemDb().query<ScenarioRow>(`SELECT ${COLS} FROM bot_scenarios WHERE id = $1`, [id]);
  return r.rows[0] ? rowToScenario(r.rows[0]) : null;
}

// ── Значения показателя по менеджерам ────────────────────────────────────────

function localDate(dateStr: string): Date {
  // Конвенция lib/period: Date = МСК-календарь в СЕРВЕРНОМ локальном времени
  // (todayMsk() = toZonedTime, дальше startOfDay/endOfDay без TZ). fetchByManagers
  // делает addDays(startOfDay(to), 1) — поэтому локальная полночь, не +03:00.
  return new Date(`${dateStr}T00:00:00`);
}

async function metricByManager(metric: Metric, all: Metric[], fromStr: string, toStr: string): Promise<Map<number, number | null>> {
  const rows = await fetchByManagers({ period: { from: localDate(fromStr), to: localDate(toStr) }, accountType: 'managers' });
  const calc = withDependencies([metric], all).filter(m => m.metricType === 'calculated');
  const out = new Map<number, number | null>();
  for (const row of rows) {
    const full = calc.length ? computeCalculated(row.metrics, calc) : row.metrics;
    const v = full[metric.id];
    const id = Number(row.dimensionId);
    if (!Number.isFinite(id)) continue;
    out.set(id, typeof v === 'number' && Number.isFinite(v) ? v : null);
  }
  return out;
}

// ── Форматирование для шаблонов ──────────────────────────────────────────────

const fmt = (v: number | null, m: Metric) => formatValue(v, m.dataType, m.decimalPlaces);
function fmtDelta(d: number | null, m: Metric): string {
  if (d === null) return '—';
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  const abs = Math.abs(d);
  if (m.dataType === 'percent') return `${sign}${abs.toLocaleString('ru-RU', { maximumFractionDigits: Math.max(1, m.decimalPlaces) })} п.п.`;
  return `${sign}${fmt(abs, m)}`;
}
function firstName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length >= 3 ? parts[1] : (parts[0] ?? full);
}
function buildCtx(flow: ScenarioFlow, metric: Metric, e: { name: string; value: number | null; base: number | null; threshold: number | null; delta: number | null }, startValue: number | null): Record<string, string> {
  return {
    'имя': firstName(e.name), 'показатель': metric.nameRu, 'значение': fmt(e.value, metric), 'цель': fmt(e.base, metric),
    'порог': fmt(e.threshold, metric), 'дельта': fmtDelta(e.delta, metric), 'было': fmt(startValue ?? e.value, metric),
    'окно': String(flow.trigger.windowDays),
    'name': firstName(e.name), 'metric': metric.nameRu, 'value': fmt(e.value, metric), 'target': fmt(e.base, metric),
    'threshold': fmt(e.threshold, metric), 'delta': fmtDelta(e.delta, metric),
  };
}

// ── Состояние из БД ──────────────────────────────────────────────────────────

interface RunRow { id: string; manager_bitrix_id: number; branch: FlowBranch; node_id: string | null; resume_at: string | null; start_value: string | null; vars: { messagesSent?: number } | null }

async function loadState(scenarioId: string | null, todayStr: string) {
  const db = systemDb();
  const empty = { rows: [] as never[] };
  const [open, closed, sentToday] = await Promise.all([
    scenarioId ? db.query<RunRow>(
      `SELECT id::text, manager_bitrix_id, branch, node_id, to_char(resume_at, 'YYYY-MM-DD') AS resume_at, start_value, vars
         FROM bot_scenario_runs WHERE scenario_id = $1 AND status = 'open'`, [scenarioId]) : Promise.resolve(empty),
    scenarioId ? db.query<{ manager_bitrix_id: number; branch: FlowBranch; closed_at: string | Date; restartable: boolean; closed_reason: string | null }>(
      `SELECT DISTINCT ON (manager_bitrix_id, branch) manager_bitrix_id, branch, closed_at, restartable, closed_reason,
              (vars->>'cooldownDays')::int AS cooldown_days
         FROM bot_scenario_runs WHERE scenario_id = $1 AND status = 'closed'
        ORDER BY manager_bitrix_id, branch, closed_at DESC`, [scenarioId]) : Promise.resolve(empty),
    // Дневной лимит — по ВСЕМ сценариям.
    db.query<{ manager_bitrix_id: number }>(
      `SELECT DISTINCT manager_bitrix_id FROM bot_scenario_events
        WHERE kind = 'message' AND (created_at AT TIME ZONE 'Europe/Moscow')::date = $1::date`, [todayStr]),
  ]);
  const openBy = new Map<number, ManagerEval['run']>();
  for (const r of open.rows as RunRow[]) {
    openBy.set(Number(r.manager_bitrix_id), {
      id: Number(r.id), branch: r.branch, nodeId: r.node_id, resumeAt: r.resume_at,
      startValue: r.start_value === null ? null : Number(r.start_value), messagesSent: r.vars?.messagesSent ?? 0,
    });
  }
  // `${mgr}:${branch}` → последняя закрытая цепочка: дата и можно ли стартовать снова.
  // Выключение сценария (closed_reason='disabled') возвратом не считается — после
  // включения менеджер снова под триггером.
  const closedBy = new Map<string, { at: string; restartable: boolean; cooldownDays: number | null }>();
  for (const r of closed.rows as { manager_bitrix_id: number; branch: FlowBranch; closed_at: string | Date; restartable: boolean; closed_reason: string | null; cooldown_days: number | null }[]) {
    closedBy.set(`${r.manager_bitrix_id}:${r.branch}`, {
      at: mskDateStr(new Date(r.closed_at)), restartable: r.restartable || r.closed_reason === 'disabled' || r.closed_reason === 'manual',
      cooldownDays: r.cooldown_days,
    });
  }
  return { openBy, closedBy, sentToday: new Set(sentToday.rows.map(r => Number(r.manager_bitrix_id))) };
}

// ── Исполнение блоков за один день (чистая функция) ─────────────────────────

interface ExecCtx {
  flow: ScenarioFlow; idx: Map<string, NodeRef>; metric: Metric; todayStr: string;
  e: { name: string; value: number | null; base: number | null; threshold: number | null; delta: number | null };
  startValue: number | null; capped: boolean; branch: FlowBranch;
}

function checkCondition(cond: CheckCondition, ctx: ExecCtx): boolean {
  const v = ctx.e.value ?? -Infinity;
  switch (cond) {
    case 'recovered': return ctx.e.threshold !== null && v >= ctx.e.threshold;
    case 'at_base':   return ctx.e.base !== null && v >= ctx.e.base;
    case 'improved':  return ctx.startValue !== null && v > ctx.startValue;
    case 'worse':     return ctx.startValue !== null && v < ctx.startValue;
  }
}

// Пауза прошлой цепочки: у «Завершить» может быть своя (vars.cooldownDays), иначе из триггера.
function prevCooldown(prev: { cooldownDays?: number | null }, fromTrigger: number): number {
  return typeof prev.cooldownDays === 'number' ? prev.cooldownDays : fromTrigger;
}

function nodeLabel(n: FlowNode): string {
  switch (n.type) {
    case 'message': return 'Сообщение';
    case 'wait': return `Ждать ${n.days} дн.`;
    case 'check': return 'Проверка';
    case 'end': return 'Завершить';
    case 'restart': return 'В начало';
  }
}

function execute(start: FlowNode | null, ctx: ExecCtx): Pick<ManagerEval, 'steps' | 'messages' | 'next' | 'outcome'> {
  const steps: ExecStep[] = [];
  const messages: { nodeId: string; text: string }[] = [];
  let cur: FlowNode | null = start;
  let capped = ctx.capped;
  const cooldown = (n: number | null) => n ?? (ctx.branch === 'norm' ? ctx.flow.trigger.praiseCooldownDays : ctx.flow.trigger.cooldownDays);
  const close = (reason: string, why: string, cd: number = cooldown(null), restartable = true) => ({
    steps, messages,
    next: { status: 'closed' as const, reason, restartable, cooldownDays: cd },
    outcome: restartable ? `${why}; пауза ${cd} дн., затем снова под триггером` : `${why}; окончательно — сценарий для менеджера больше не запустится`,
  });
  const tplCtx = buildCtx(ctx.flow, ctx.metric, ctx.e, ctx.startValue);

  for (let guard = 0; guard < 100; guard++) {
    if (!cur) {
      steps.push({ nodeId: null, type: 'end', label: 'Конец ветки' });
      return close('finished', 'цепочка дошла до конца');
    }
    switch (cur.type) {
      case 'message': {
        if (capped) {
          steps.push({ nodeId: cur.id, type: 'deferred', label: 'Отложено: сегодня менеджер уже получал сообщение сценариев' });
          const resumeAt = addDaysStr(ctx.todayStr, 1);
          return { steps, messages, next: { status: 'open', branch: ctx.branch, nodeId: cur.id, resumeAt, startValue: ctx.startValue }, outcome: `сообщение отложено на ${resumeAt} (антиспам: 1 в день)` };
        }
        const text = renderTemplate(cur.text, tplCtx);
        steps.push({ nodeId: cur.id, type: 'message', label: 'Сообщение', text });
        messages.push({ nodeId: cur.id, text });
        capped = true;
        cur = nextAfter(ctx.flow, ctx.idx, cur.id);
        break;
      }
      case 'wait': {
        const resumeAt = addDaysStr(ctx.todayStr, cur.days);
        const after = nextAfter(ctx.flow, ctx.idx, cur.id);
        steps.push({ nodeId: cur.id, type: 'wait', label: `Ждать ${cur.days} дн. — до ${resumeAt}` });
        if (!after) return close('finished', 'после паузы блоков нет — цепочка завершена');
        return { steps, messages, next: { status: 'open', branch: ctx.branch, nodeId: after.id, resumeAt, startValue: ctx.startValue }, outcome: `ждём до ${resumeAt}, дальше — «${nodeLabel(after)}»` };
      }
      case 'check': {
        const ok = checkCondition(cur.condition, ctx);
        steps.push({ nodeId: cur.id, type: 'check', label: `Проверка: ${ok ? 'да' : 'нет'}`, result: ok });
        const list = ok ? cur.yes : cur.no;
        cur = list.length ? list[0] : nextAfter(ctx.flow, ctx.idx, cur.id);
        break;
      }
      case 'end': {
        const after = nextAfter(ctx.flow, ctx.idx, cur.id);
        const restart = after?.type === 'restart';
        steps.push({ nodeId: cur.id, type: 'end', label: restart ? `Завершить (пауза ${cooldown(cur.cooldownDays)} дн.) → В начало` : 'Завершить — окончательно' });
        return close(restart ? 'restart' : 'end', 'цепочка завершена', cooldown(cur.cooldownDays), restart);
      }
      case 'restart': {
        steps.push({ nodeId: cur.id, type: 'end', label: `В начало (пауза ${cooldown(null)} дн.)` });
        return close('restart', 'цепочка завершена');
      }
    }
  }
  return close('guard', 'слишком длинная цепочка за день — остановлено');
}

// ── Оценка сценария по всем менеджерам ───────────────────────────────────────

export interface EvaluateResult {
  metric: Metric;
  window: { from: string; to: string };
  baselineWindow: { from: string; to: string } | null;
  evals: ManagerEval[];
  summary: RunSummary;
}

/** scenarioId=null — черновик из редактора: состояние цепочек не читается (все «новые»). */
export async function evaluateFlow(flow: ScenarioFlow, scenarioId: string | null, opts: { todayStr?: string } = {}): Promise<EvaluateResult> {
  const todayStr = opts.todayStr ?? mskDateStr();
  const all = await loadMetrics();
  const metric = all.find(m => m.id === flow.trigger.metricId);
  if (!metric) throw new Error(`Метрика «${flow.trigger.metricId}» не найдена в каталоге`);
  const t = flow.trigger;
  const idx = indexFlow(flow);

  const winTo = addDaysStr(todayStr, -1);
  const winFrom = addDaysStr(todayStr, -t.windowDays);
  const baseTo = addDaysStr(winFrom, -1);
  const baseFrom = addDaysStr(winFrom, -t.baselineDays);

  const [{ managers: allManagers }, values, baseValues, state] = await Promise.all([
    fetchWorkingManagers(),
    metricByManager(metric, all, winFrom, winTo),
    t.baseline === 'own_avg' ? metricByManager(metric, all, baseFrom, baseTo) : Promise.resolve(null),
    loadState(scenarioId, todayStr),
  ]);

  const managers = flow.audience.mode === 'selected'
    ? allManagers.filter(m => flow.audience.managerIds.includes(m.bitrixId))
    : allManagers;
  const summary: RunSummary = { date: todayStr, managers: managers.length, noData: 0, below: 0, norm: 0, started: 0, continued: 0, messages: 0, closed: 0, deferred: 0 };
  const evals: ManagerEval[] = [];

  for (const m of managers) {
    const value = values.get(m.bitrixId) ?? null;
    const base = t.baseline === 'target' ? t.targetValue : (baseValues?.get(m.bitrixId) ?? null);
    const run = state.openBy.get(m.bitrixId) ?? null;
    const e: ManagerEval = {
      bitrixId: m.bitrixId, name: m.name, value, base, threshold: null, delta: null, status: 'no_data',
      run, steps: [], messages: [], outcome: '', next: null, startBranch: null, result: null,
    };
    evals.push(e);
    if (value === null) { e.outcome = 'нет данных за окно'; summary.noData++; continue; }
    if (base === null) { e.outcome = t.baseline === 'own_avg' ? 'нет собственной базы (мало истории)' : 'цель не задана'; summary.noData++; continue; }
    e.threshold = base - t.dropThreshold;
    e.delta = value - base;
    e.status = value < e.threshold ? 'below' : value >= base ? 'norm' : 'between';
    if (e.status === 'below') summary.below++;
    if (e.status === 'norm') summary.norm++;

    const capped = state.sentToday.has(m.bitrixId);
    const ctxBase = { flow, idx, metric, todayStr, e: { name: m.name, value, base, threshold: e.threshold, delta: e.delta }, capped };

    if (run) {
      if (run.resumeAt && run.resumeAt > todayStr) {
        const at = run.nodeId ? idx.get(run.nodeId)?.node : null;
        e.outcome = `цепочка «${run.branch === 'below' ? 'просадка' : 'в норме'}» идёт, продолжение ${run.resumeAt}${at ? ` — «${nodeLabel(at)}»` : ''}`;
        continue;
      }
      const node = run.nodeId ? idx.get(run.nodeId)?.node ?? null : null;
      if (!node) {
        // Блок удалили в редакторе — честно закрываем.
        e.steps.push({ nodeId: null, type: 'end', label: 'Блок цепочки удалён из сценария' });
        e.next = { status: 'closed', reason: 'node_missing', restartable: true, cooldownDays: run.branch === 'norm' ? t.praiseCooldownDays : t.cooldownDays };
        e.outcome = 'цепочка закрыта: её блок удалён из сценария';
        summary.closed++; continue;
      }
      e.steps.push({ nodeId: null, type: 'start', label: `Продолжаем цепочку (${run.branch === 'below' ? 'просадка' : 'в норме'})` });
      const r = execute(node, { ...ctxBase, startValue: run.startValue, branch: run.branch });
      e.steps.push(...r.steps); e.messages = r.messages; e.next = r.next; e.outcome = r.outcome;
      summary.continued++;
    } else {
      const branch: FlowBranch | null = e.status === 'below' ? 'below' : e.status === 'norm' ? 'norm' : null;
      if (!branch) { e.outcome = `в коридоре: ниже цели, но не ниже порога ${fmt(e.threshold, metric)} — тишина`; continue; }
      const list = flow[branch];
      if (!list.length) { e.outcome = branch === 'below' ? 'ниже порога, но ветка «просадка» пустая' : 'в норме, ветка «в норме» пустая'; continue; }
      const prev = state.closedBy.get(`${m.bitrixId}:${branch}`);
      if (prev && !prev.restartable) {
        e.outcome = `${branch === 'below' ? 'ниже порога' : 'в норме'}, но прошлая цепочка завершена окончательно (без «В начало») — сценарий для менеджера больше не стартует`;
        continue;
      }
      const cd = branch === 'below' ? t.cooldownDays : t.praiseCooldownDays;
      if (prev && addDaysStr(prev.at, prevCooldown(prev, cd)) > todayStr) {
        e.outcome = `${branch === 'below' ? 'ниже порога' : 'в норме'}, но пауза после прошлой цепочки до ${addDaysStr(prev.at, prevCooldown(prev, cd))}`;
        continue;
      }
      e.startBranch = branch;
      e.steps.push({ nodeId: null, type: 'start', label: branch === 'below' ? `Ниже порога на ${fmtDelta(value - e.threshold, metric)} — старт ветки «просадка»` : 'В норме — старт ветки «в норме»' });
      const r = execute(list[0], { ...ctxBase, startValue: value, branch });
      e.steps.push(...r.steps); e.messages = r.messages; e.next = r.next; e.outcome = r.outcome;
      summary.started++;
    }
    summary.messages += e.messages.length;
    if (e.next?.status === 'closed') {
      summary.closed++;
      const br = e.run?.branch ?? e.startBranch ?? 'below';
      e.result = runResult(br, value, e.run?.startValue ?? value, e.threshold);
    }
    if (e.steps.some(s => s.type === 'deferred')) summary.deferred++;
  }

  const order = (x: ManagerEval) => (x.messages.length ? 0 : x.steps.length ? 1 : x.run ? 2 : x.status === 'below' ? 3 : x.status === 'norm' ? 4 : 5);
  evals.sort((a, b) => order(a) - order(b) || (a.delta ?? 0) - (b.delta ?? 0) || a.name.localeCompare(b.name, 'ru'));

  return { metric, window: { from: winFrom, to: winTo }, baselineWindow: t.baseline === 'own_avg' ? { from: baseFrom, to: baseTo } : null, evals, summary };
}

export function evaluateScenario(s: Scenario, opts: { todayStr?: string } = {}): Promise<EvaluateResult> {
  return evaluateFlow(s.flow, s.id, opts);
}

// ── Прогон с отправкой и записью состояния ───────────────────────────────────

export async function runScenario(s: Scenario, opts: { todayStr?: string; managerIds?: number[] } = {}): Promise<EvaluateResult> {
  const res = await evaluateScenario(s, opts);
  const todayStr = res.summary.date;
  const db = systemDb();
  const only = opts.managerIds ? new Set(opts.managerIds) : null;
  const branchName = (b: FlowBranch) => (b === 'below' ? 'просадка' : 'в норме');

  for (const e of res.evals) {
    if (!e.next && !e.messages.length) continue;
    if (only && !only.has(e.bitrixId)) continue;
    try {
      const prefs = await fetchManagerBotPrefs(e.bitrixId);
      const suppressReason = prefs.enabled ? null : 'manager_opted_out_all';
      const branch = e.run?.branch ?? e.startBranch ?? 'below';

      let runId: number | null = e.run?.id ?? null;
      if (!runId && e.startBranch) {
        const ins = await db.query<{ id: string }>(
          `INSERT INTO bot_scenario_runs (scenario_id, manager_bitrix_id, branch, start_value, last_value, threshold, base_value, node_id, vars)
           VALUES ($1, $2, $3, $4, $4, $5, $6, NULL, '{}')
           ON CONFLICT (scenario_id, manager_bitrix_id) WHERE status = 'open' DO NOTHING
           RETURNING id::text`,
          [s.id, e.bitrixId, branch, e.value, e.threshold, e.base],
        );
        runId = Number(ins.rows[0]?.id ?? 0) || null;
        if (!runId) continue; // параллельный прогон уже открыл — не дублируем
      }

      for (const msg of e.messages) {
        const trace = {
          scenario: { id: s.id, name: s.name, metric: res.metric.id }, branch, nodeId: msg.nodeId,
          window: res.window, value: e.value, base: e.base, threshold: e.threshold, delta: e.delta, status: e.status,
          steps: e.steps.map(x => x.label),
        };
        await sendManagerBotMessage(e.bitrixId, msg.text, 'scenario_message',
          `Сценарий «${s.name}» · ${branchName(branch)} (${e.name})`, { suppressReason, decisionTrace: trace });
        await db.query(
          `INSERT INTO bot_scenario_events (scenario_id, run_id, manager_bitrix_id, kind, value, threshold, text, node_id, branch)
           VALUES ($1, $2, $3, 'message', $4, $5, $6, $7, $8)`,
          [s.id, runId, e.bitrixId, e.value, e.threshold, msg.text, msg.nodeId, branch],
        );
      }

      if (runId && e.next?.status === 'open') {
        await db.query(
          `UPDATE bot_scenario_runs SET node_id = $2, resume_at = $3::date, last_value = $4, step = step + $5,
                  last_sent_at = CASE WHEN $5 > 0 THEN now() ELSE last_sent_at END,
                  vars = vars || jsonb_build_object('messagesSent', COALESCE((vars->>'messagesSent')::int, 0) + $5)
            WHERE id = $1`,
          [runId, e.next.nodeId, e.next.resumeAt, e.value, e.messages.length],
        );
      } else if (runId && e.next?.status === 'closed') {
        await db.query(
          `UPDATE bot_scenario_runs SET status = 'closed', closed_at = now(), closed_reason = $2, last_value = $3, step = step + $4,
                  result = $5, track_until = $6::date, restartable = $7,
                  vars = vars || jsonb_build_object('messagesSent', COALESCE((vars->>'messagesSent')::int, 0) + $4, 'cooldownDays', $8::int),
                  last_sent_at = CASE WHEN $4 > 0 THEN now() ELSE last_sent_at END
            WHERE id = $1`,
          [runId, e.next.reason, e.value, e.messages.length, e.result, addDaysStr(todayStr, s.flow.trigger.trackDays), e.next.restartable, e.next.cooldownDays],
        );
        await db.query(
          `INSERT INTO bot_scenario_events (scenario_id, run_id, manager_bitrix_id, kind, value, threshold, text, branch)
           VALUES ($1, $2, $3, 'closed', $4, $5, $6, $7)`,
          [s.id, runId, e.bitrixId, e.value, e.threshold, e.outcome, branch],
        );
      }
    } catch (err) {
      console.warn(`[scenarios] «${s.name}» → менеджер ${e.bitrixId} не обработан:`, err instanceof Error ? err.message : err);
    }
  }

  try { await trackRuns(s, res, todayStr); }
  catch (err) { console.warn(`[scenarios] «${s.name}»: трекинг цели не записан:`, err instanceof Error ? err.message : err); }

  await db.query(`UPDATE bot_scenarios SET last_run_at = now(), last_run_summary = $2 WHERE id = $1`, [s.id, JSON.stringify(res.summary)]);
  return res;
}

// ── Трекинг цели (оценка эффективности) ──────────────────────────────────────
// Владелец 09.09: «при старте фиксировать стартовый показатель, текущий, достигнут ли
// целевой и удержан ли; только при удержании целевого в течение заданного периода
// считать сценарий максимально успешным». Раз в день (в прогоне сценария) по каждой
// цепочке — открытой или закрытой не раньше trackDays назад — снимок показателя и
// пересчёт: reached_at (впервые ≥ порога), at_base_at (впервые ≥ базы), streak_since
// (начало текущей серии дней ≥ порога), held (серия ≥ holdDays календарных дней),
// outcome. Порог и база — зафиксированные на старте цепочки, не текущие настройки.

export type RunOutcome = 'held' | 'holding' | 'reached_lost' | 'improved' | 'same' | 'worse';

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  held: 'удержал цель', holding: 'достиг, удерживает', reached_lost: 'достиг, но не удержал',
  improved: 'подрос, порог не взят', same: 'без изменений', worse: 'стало хуже',
};

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);
}

export function computeOutcome(x: {
  value: number | null; startValue: number | null; threshold: number | null; reachedAt: string | null;
  streakSince: string | null; held: boolean; trackingDone: boolean;
}): RunOutcome {
  if (x.held) return 'held';
  const above = x.value !== null && x.threshold !== null && x.value >= x.threshold;
  if (x.reachedAt) return above && !x.trackingDone ? 'holding' : above ? 'holding' : 'reached_lost';
  if (x.value === null || x.startValue === null) return 'same';
  const eps = Math.abs(x.startValue) * 0.005;
  if (x.value > x.startValue + eps) return 'improved';
  if (x.value < x.startValue - eps) return 'worse';
  return 'same';
}

interface TrackRow {
  id: string; manager_bitrix_id: number; status: string; start_value: string | null; threshold: string | null; base_value: string | null;
  reached_at: string | null; at_base_at: string | null; streak_since: string | null; held: boolean; track_until: string | null; last_day: string | null;
}

async function trackRuns(s: Scenario, res: EvaluateResult, todayStr: string): Promise<void> {
  const db = systemDb();
  const rows = await db.query<TrackRow>(
    `SELECT r.id::text, r.manager_bitrix_id, r.status, r.start_value, r.threshold, r.base_value,
            to_char(r.reached_at, 'YYYY-MM-DD') AS reached_at, to_char(r.at_base_at, 'YYYY-MM-DD') AS at_base_at,
            to_char(r.streak_since, 'YYYY-MM-DD') AS streak_since, r.held, to_char(r.track_until, 'YYYY-MM-DD') AS track_until,
            (SELECT to_char(max(day), 'YYYY-MM-DD') FROM bot_scenario_run_track t WHERE t.run_id = r.id) AS last_day
       FROM bot_scenario_runs r
      WHERE r.scenario_id = $1 AND r.tracking = 'active'`,
    [s.id],
  );
  const valueBy = new Map(res.evals.map(e => [e.bitrixId, e.value]));
  const holdDays = s.flow.trigger.holdDays;
  for (const r of rows.rows) {
    if (r.last_day === todayStr) continue; // сегодня уже снимали (ручной запуск после планового)
    const value = valueBy.get(Number(r.manager_bitrix_id)) ?? null;
    const threshold = r.threshold === null ? null : Number(r.threshold);
    const base = r.base_value === null ? null : Number(r.base_value);
    const startValue = r.start_value === null ? null : Number(r.start_value);
    const above = value !== null && threshold !== null && value >= threshold;
    const reachedAt = r.reached_at ?? (above ? todayStr : null);
    const atBaseAt = r.at_base_at ?? (value !== null && base !== null && value >= base ? todayStr : null);
    const streakSince = above ? (r.streak_since ?? todayStr) : null;
    const heldNow = !!streakSince && daysBetween(streakSince, todayStr) + 1 >= holdDays;
    const held = r.held || heldNow;
    const heldAt = held && !r.held ? todayStr : null;
    const trackingDone = held || (r.status === 'closed' && !!r.track_until && r.track_until <= todayStr);
    const outcome = computeOutcome({ value, startValue, threshold, reachedAt, streakSince, held, trackingDone });
    await db.query(`INSERT INTO bot_scenario_run_track (run_id, day, value) VALUES ($1, $2::date, $3) ON CONFLICT (run_id, day) DO UPDATE SET value = EXCLUDED.value`,
      [r.id, todayStr, value]);
    await db.query(
      `UPDATE bot_scenario_runs SET current_value = $2, reached_at = $3::date, at_base_at = $4::date, streak_since = $5::date,
              held = $6, held_at = COALESCE(held_at, $7::date), tracking = $8, outcome = $9
        WHERE id = $1`,
      [r.id, value, reachedAt, atBaseAt, streakSince, held, heldAt, trackingDone ? 'done' : 'active', outcome],
    );
  }
}

/** Тик из instrumentation.ts (раз в минуту): чьи час и день пришли — прогнать.
 *  Защита от дублей/нескольких инстансов — атомарный claim по МСК-дате в last_run_at. */
export async function runDueScenarios(now: Date = new Date()): Promise<void> {
  if (!(await channelEnabled('scenarios'))) return; // выключено или бот вырублен — даже не считаем
  const todayStr = mskDateStr(now);
  const hour = Number(now.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false }).slice(0, 2));
  const weekday = mskIsoWeekday(now);
  const db = systemDb();
  const due = await db.query<{ id: string }>(
    `SELECT id::text FROM bot_scenarios
      WHERE enabled AND check_hour = $1 AND (NOT weekdays_only OR $2 <= 5)
        AND (last_run_at IS NULL OR (last_run_at AT TIME ZONE 'Europe/Moscow')::date < $3::date)`,
    [hour, weekday, todayStr],
  );
  for (const { id } of due.rows) {
    const claimed = await db.query(
      `UPDATE bot_scenarios SET last_run_at = now()
        WHERE id = $1 AND (last_run_at IS NULL OR (last_run_at AT TIME ZONE 'Europe/Moscow')::date < $2::date)`,
      [id, todayStr],
    );
    if (!claimed.rowCount) continue;
    const s = await loadScenario(id);
    if (!s) continue;
    try {
      const res = await runScenario(s, { todayStr });
      const x = res.summary;
      console.log(`[scenarios] «${s.name}»: менеджеров ${x.managers}, ниже порога ${x.below}, новых цепочек ${x.started}, продолжено ${x.continued}, сообщений ${x.messages}, закрыто ${x.closed}`);
    } catch (err) {
      console.error(`[scenarios] «${s.name}» упал:`, err instanceof Error ? err.message : err);
      await db.query(`UPDATE bot_scenarios SET last_run_summary = $2 WHERE id = $1`,
        [id, JSON.stringify({ date: todayStr, error: err instanceof Error ? err.message : String(err) })]).catch(() => {});
    }
  }
}

/** Закрыть открытые цепочки сценария (выключение/удаление) — чтобы после включения
 *  обратно не посыпались продолжения месячной давности. */
export async function closeOpenRuns(scenarioId: string, reason: 'disabled' | 'manual'): Promise<number> {
  const r = await systemDb().query(
    `UPDATE bot_scenario_runs SET status = 'closed', closed_at = now(), closed_reason = $2 WHERE scenario_id = $1 AND status = 'open'`,
    [scenarioId, reason],
  );
  return r.rowCount ?? 0;
}
