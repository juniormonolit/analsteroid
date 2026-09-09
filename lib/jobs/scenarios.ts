// Сценарии авто-коучинга бота «Аналитик» (задача владельца 09.09.2026):
// «беру важный показатель, например конверсию в продажу; задаю целевой — 15%;
// если просаживается больше чем на N п.п. — цепочка: совет, проверка через M
// дней, проверка выполнения совета, ещё совет; если в норме или выше — похвала.
// Хочу коучить менеджеров в авторежиме».
//
// Как это работает:
//  1. Показатель — любая метрика каталога. Считается НА МЕНЕДЖЕРА тем же движком,
//     что отчёт «По менеджерам» (fetchByManagers → computeCalculated), за окно
//     window_days, заканчивающееся вчера (сегодня ещё не прожит).
//  2. База сравнения — либо фиксированная цель (target), либо собственное значение
//     менеджера за baseline_days ДО окна (own_avg: «упал относительно себя за 3 мес»).
//     Порог просадки = база − drop_threshold (для процентов — п.п.).
//  3. Состояние — цепочка (bot_scenario_runs), одна открытая на пару сценарий+менеджер:
//       ниже порога, цепочки нет → совет (step 1), проверка через followup_days;
//       день проверки: стало ≥ порога → «Молодец!», цепочка закрыта (improved);
//                      всё ещё ниже, шагов осталось → «Всё ещё падает…» + совет, step+1;
//                      шаги исчерпаны → последнее сообщение и закрытие (max_steps);
//       после закрытия — cooldown_days тишины по этой паре;
//       в норме (≥ базы), цепочки нет → похвала, не чаще praise_cooldown_days.
//  4. Антиспам сверху: не больше ОДНОГО сообщения сценариев менеджеру в день (по
//     всем сценариям), неактивные аккаунты не трогаем (fetchWorkingManagers), личный
//     отказ менеджера от бота уважаем (manager_bot_prefs.enabled).
//  5. Отправка — только через sendManagerBotMessage (лог, ID, кнопки «полезно/нет»),
//     функция бота — 'scenarios' (выключена по умолчанию, как всё).
//
// evaluateScenario() — чистый расчёт без записи (кнопка «Проверить сейчас» в
// панели), runScenario() — расчёт + отправка + запись состояния.

import { systemDb } from '@/lib/db/clients';
import { loadMetrics, withDependencies } from '@/lib/metrics/catalog';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { computeCalculated } from '@/features/reports/engine/calculated';
import { sendManagerBotMessage } from '@/features/badges/engine/notifications';
import { channelEnabled } from '@/lib/bitrix/notify';
import { formatValue } from '@/lib/format';
import {
  fetchWorkingManagers, fetchManagerBotPrefs, mskDateStr, addDaysStr, mskIsoWeekday, type ManagerRef,
} from './managerDigest';
import type { Metric } from '@/lib/metrics/types';

export type ScenarioBaseline = 'target' | 'own_avg';
export type ScenarioEventKind = 'advice' | 'followup_same' | 'followup_improved' | 'praise';

export interface Scenario {
  id: string;
  name: string;
  enabled: boolean;
  metricId: string;
  windowDays: number;
  baseline: ScenarioBaseline;
  targetValue: number | null;
  baselineDays: number;
  dropThreshold: number;
  adviceText: string;
  followupDays: number;
  followupImprovedText: string;
  followupSameText: string;
  maxSteps: number;
  cooldownDays: number;
  praiseEnabled: boolean;
  praiseText: string | null;
  praiseCooldownDays: number;
  checkHour: number;
  weekdaysOnly: boolean;
  lastRunAt: string | null;
  lastRunSummary: RunSummary | null;
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
  sent: Record<ScenarioEventKind, number>;
  skipped: number;
  dryPreview?: boolean;
}

/** Решение по одному менеджеру — и для превью, и для реального прогона. */
export interface ManagerEval {
  bitrixId: number;
  name: string;
  value: number | null;
  base: number | null;
  threshold: number | null;
  /** value − base в единицах метрики (для процентов — п.п.). */
  delta: number | null;
  status: 'no_data' | 'below' | 'between' | 'norm';
  action: ScenarioEventKind | 'none';
  /** Почему именно так — человеческим языком, показывается в превью. */
  reason: string;
  text: string | null;
  /** Открытая цепочка, если есть. */
  run: { id: number; step: number; nextCheckAt: string | null; startValue: number | null } | null;
  /** Сколько шагов станет после действия (для followup_same). */
  nextStep?: number;
  closeReason?: 'improved' | 'max_steps';
}

interface ScenarioRow {
  id: string; name: string; enabled: boolean; metric_id: string; window_days: number; baseline: ScenarioBaseline;
  target_value: string | null; baseline_days: number; drop_threshold: string; advice_text: string; followup_days: number;
  followup_improved_text: string; followup_same_text: string; max_steps: number; cooldown_days: number;
  praise_enabled: boolean; praise_text: string | null; praise_cooldown_days: number; check_hour: number;
  weekdays_only: boolean; last_run_at: string | Date | null; last_run_summary: RunSummary | null;
  created_by: string | null; created_at: string | Date; updated_at: string | Date;
}

const iso = (d: string | Date | null): string | null => (d ? new Date(d).toISOString() : null);

function rowToScenario(r: ScenarioRow): Scenario {
  return {
    id: r.id, name: r.name, enabled: r.enabled, metricId: r.metric_id, windowDays: r.window_days,
    baseline: r.baseline, targetValue: r.target_value === null ? null : Number(r.target_value),
    baselineDays: r.baseline_days, dropThreshold: Number(r.drop_threshold),
    adviceText: r.advice_text, followupDays: r.followup_days,
    followupImprovedText: r.followup_improved_text, followupSameText: r.followup_same_text,
    maxSteps: r.max_steps, cooldownDays: r.cooldown_days,
    praiseEnabled: r.praise_enabled, praiseText: r.praise_text, praiseCooldownDays: r.praise_cooldown_days,
    checkHour: r.check_hour, weekdaysOnly: r.weekdays_only,
    lastRunAt: iso(r.last_run_at), lastRunSummary: r.last_run_summary,
    createdBy: r.created_by, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}

const SCENARIO_COLS = `id::text, name, enabled, metric_id, window_days, baseline, target_value, baseline_days,
  drop_threshold, advice_text, followup_days, followup_improved_text, followup_same_text, max_steps, cooldown_days,
  praise_enabled, praise_text, praise_cooldown_days, check_hour, weekdays_only, last_run_at, last_run_summary,
  created_by, created_at, updated_at`;

export async function loadScenarios(opts: { enabledOnly?: boolean } = {}): Promise<Scenario[]> {
  const r = await systemDb().query<ScenarioRow>(
    `SELECT ${SCENARIO_COLS} FROM bot_scenarios ${opts.enabledOnly ? 'WHERE enabled' : ''} ORDER BY created_at`,
  );
  return r.rows.map(rowToScenario);
}

export async function loadScenario(id: string): Promise<Scenario | null> {
  const r = await systemDb().query<ScenarioRow>(`SELECT ${SCENARIO_COLS} FROM bot_scenarios WHERE id = $1`, [id]);
  return r.rows[0] ? rowToScenario(r.rows[0]) : null;
}

// ── Значения метрики по менеджерам ──────────────────────────────────────────

function mskDate(dateStr: string): Date {
  // Конвенция lib/period: Date = МСК-календарь в СЕРВЕРНОМ локальном времени
  // (todayMsk() = toZonedTime, дальше startOfDay/endOfDay без TZ). fetchByManagers
  // делает addDays(startOfDay(to), 1) — поэтому именно локальная полночь, не +03:00.
  return new Date(`${dateStr}T00:00:00`);
}

async function metricByManager(metric: Metric, all: Metric[], fromStr: string, toStr: string): Promise<Map<number, number | null>> {
  const rows = await fetchByManagers({ period: { from: mskDate(fromStr), to: mskDate(toStr) }, accountType: 'managers' });
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

// ── Шаблоны текстов ─────────────────────────────────────────────────────────

export const TEMPLATE_PLACEHOLDERS: { key: string; hint: string }[] = [
  { key: 'имя', hint: 'имя менеджера' },
  { key: 'показатель', hint: 'название метрики' },
  { key: 'значение', hint: 'текущее значение за окно' },
  { key: 'цель', hint: 'база: цель или своё среднее' },
  { key: 'порог', hint: 'база минус допустимая просадка' },
  { key: 'дельта', hint: 'отклонение от базы со знаком' },
  { key: 'было', hint: 'значение в начале цепочки (в проверках)' },
  { key: 'окно', hint: 'длина окна в днях' },
  { key: 'дней', hint: 'через сколько дней проверка' },
];

function fmt(v: number | null, metric: Metric): string {
  return formatValue(v, metric.dataType, metric.decimalPlaces);
}

function fmtDelta(d: number | null, metric: Metric): string {
  if (d === null) return '—';
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  const abs = Math.abs(d);
  if (metric.dataType === 'percent') return `${sign}${abs.toLocaleString('ru-RU', { maximumFractionDigits: Math.max(1, metric.decimalPlaces) })} п.п.`;
  return `${sign}${fmt(abs, metric)}`;
}

function firstName(full: string): string {
  // «Иванов Иван Иванович» / «Иван Иванов» — берём то, что похоже на имя: второе
  // слово при трёх, первое при двух. Не угадали — не страшно, это обращение.
  const parts = full.trim().split(/\s+/);
  if (parts.length >= 3) return parts[1];
  return parts[0] ?? full;
}

export function renderTemplate(tpl: string, ctx: Record<string, string>): string {
  return tpl.replace(/\{\s*([^}]+?)\s*\}/g, (m, key: string) => {
    const k = key.toLowerCase();
    return k in ctx ? ctx[k] : m;
  });
}

function buildCtx(s: Scenario, metric: Metric, e: Pick<ManagerEval, 'name' | 'value' | 'base' | 'threshold' | 'delta' | 'run'>): Record<string, string> {
  return {
    'имя': firstName(e.name),
    'показатель': metric.nameRu,
    'значение': fmt(e.value, metric),
    'цель': fmt(e.base, metric),
    'порог': fmt(e.threshold, metric),
    'дельта': fmtDelta(e.delta, metric),
    'было': fmt(e.run?.startValue ?? e.value, metric),
    'окно': String(s.windowDays),
    'дней': String(s.followupDays),
    // латинские синонимы — на всякий
    'name': firstName(e.name), 'metric': metric.nameRu, 'value': fmt(e.value, metric), 'target': fmt(e.base, metric),
    'threshold': fmt(e.threshold, metric), 'delta': fmtDelta(e.delta, metric), 'days': String(s.followupDays),
  };
}

// ── Оценка ───────────────────────────────────────────────────────────────────

interface OpenRunRow { id: string; manager_bitrix_id: number; step: number; next_check_at: string | null; start_value: string | null }

async function loadState(scenarioId: string, todayStr: string) {
  const db = systemDb();
  const [open, closed, praised, sentToday] = await Promise.all([
    db.query<OpenRunRow>(
      `SELECT id::text, manager_bitrix_id, step, to_char(next_check_at, 'YYYY-MM-DD') AS next_check_at, start_value
         FROM bot_scenario_runs WHERE scenario_id = $1 AND status = 'open'`,
      [scenarioId],
    ),
    db.query<{ manager_bitrix_id: number; closed_at: string | Date }>(
      `SELECT manager_bitrix_id, max(closed_at) AS closed_at FROM bot_scenario_runs
        WHERE scenario_id = $1 AND status = 'closed' GROUP BY manager_bitrix_id`,
      [scenarioId],
    ),
    db.query<{ manager_bitrix_id: number; at: string | Date }>(
      `SELECT manager_bitrix_id, max(created_at) AS at FROM bot_scenario_events
        WHERE scenario_id = $1 AND kind = 'praise' GROUP BY manager_bitrix_id`,
      [scenarioId],
    ),
    // Дневной лимит — по ВСЕМ сценариям, не только по этому.
    db.query<{ manager_bitrix_id: number }>(
      `SELECT DISTINCT manager_bitrix_id FROM bot_scenario_events
        WHERE (created_at AT TIME ZONE 'Europe/Moscow')::date = $1::date`,
      [todayStr],
    ),
  ]);
  const openBy = new Map<number, ManagerEval['run']>();
  for (const r of open.rows) {
    openBy.set(Number(r.manager_bitrix_id), {
      id: Number(r.id), step: r.step,
      nextCheckAt: r.next_check_at,
      startValue: r.start_value === null ? null : Number(r.start_value),
    });
  }
  const closedBy = new Map<number, string>();
  for (const r of closed.rows) closedBy.set(Number(r.manager_bitrix_id), mskDateStr(new Date(r.closed_at)));
  const praisedBy = new Map<number, string>();
  for (const r of praised.rows) praisedBy.set(Number(r.manager_bitrix_id), mskDateStr(new Date(r.at)));
  const sentTodaySet = new Set(sentToday.rows.map(r => Number(r.manager_bitrix_id)));
  return { openBy, closedBy, praisedBy, sentTodaySet };
}

export interface EvaluateResult {
  scenario: Scenario;
  metric: Metric;
  window: { from: string; to: string };
  baselineWindow: { from: string; to: string } | null;
  evals: ManagerEval[];
  summary: RunSummary;
}

export async function evaluateScenario(s: Scenario, opts: { todayStr?: string } = {}): Promise<EvaluateResult> {
  const todayStr = opts.todayStr ?? mskDateStr();
  const all = await loadMetrics();
  const metric = all.find(m => m.id === s.metricId);
  if (!metric) throw new Error(`Метрика «${s.metricId}» не найдена в каталоге`);

  const winTo = addDaysStr(todayStr, -1);
  const winFrom = addDaysStr(todayStr, -s.windowDays);
  const baseTo = addDaysStr(winFrom, -1);
  const baseFrom = addDaysStr(winFrom, -s.baselineDays);

  const [{ managers }, values, baseValues, state] = await Promise.all([
    fetchWorkingManagers(),
    metricByManager(metric, all, winFrom, winTo),
    s.baseline === 'own_avg' ? metricByManager(metric, all, baseFrom, baseTo) : Promise.resolve(null),
    loadState(s.id, todayStr),
  ]);

  const evals: ManagerEval[] = [];
  const summary: RunSummary = {
    date: todayStr, managers: managers.length, noData: 0, below: 0, norm: 0,
    sent: { advice: 0, followup_same: 0, followup_improved: 0, praise: 0 }, skipped: 0,
  };

  for (const m of managers) {
    const value = values.get(m.bitrixId) ?? null;
    const base = s.baseline === 'target' ? s.targetValue : (baseValues?.get(m.bitrixId) ?? null);
    const run = state.openBy.get(m.bitrixId) ?? null;
    const e: ManagerEval = {
      bitrixId: m.bitrixId, name: m.name, value, base, threshold: null, delta: null,
      status: 'no_data', action: 'none', reason: '', text: null, run,
    };
    evals.push(e);

    if (value === null) { e.reason = 'нет данных за окно'; summary.noData++; continue; }
    if (base === null) {
      e.reason = s.baseline === 'own_avg' ? 'нет собственной базы (мало истории)' : 'цель не задана';
      summary.noData++; continue;
    }
    e.threshold = base - s.dropThreshold;
    e.delta = value - base;
    e.status = value < e.threshold ? 'below' : value >= base ? 'norm' : 'between';
    if (e.status === 'below') summary.below++;
    if (e.status === 'norm') summary.norm++;

    const ctx = buildCtx(s, metric, e);
    const capped = state.sentTodaySet.has(m.bitrixId);

    if (run) {
      if (run.nextCheckAt && run.nextCheckAt > todayStr) {
        e.reason = `цепочка открыта (шаг ${run.step}), проверка ${run.nextCheckAt}`;
        continue;
      }
      if (capped) { e.reason = 'проверка отложена: сегодня менеджер уже получал сообщение сценариев'; summary.skipped++; continue; }
      if (value >= e.threshold) {
        e.action = 'followup_improved'; e.closeReason = 'improved';
        e.reason = `проверка: вышел на порог (${fmt(e.threshold, metric)}) — похвалить и закрыть цепочку`;
        e.text = renderTemplate(s.followupImprovedText, ctx);
      } else if (run.step >= s.maxSteps) {
        e.action = 'followup_same'; e.closeReason = 'max_steps';
        e.reason = `проверка: всё ещё ниже порога, шаги исчерпаны (${run.step}/${s.maxSteps}) — последнее сообщение, тишина ${s.cooldownDays} дн.`;
        e.text = renderTemplate(s.followupSameText, ctx);
      } else {
        e.action = 'followup_same'; e.nextStep = run.step + 1;
        e.reason = `проверка: всё ещё ниже порога — повторный совет (шаг ${run.step + 1}/${s.maxSteps}), следующая проверка через ${s.followupDays} дн.`;
        e.text = renderTemplate(s.followupSameText, ctx);
      }
      summary.sent[e.action]++;
      continue;
    }

    if (e.status === 'below') {
      const closedAt = state.closedBy.get(m.bitrixId);
      if (closedAt && addDaysStr(closedAt, s.cooldownDays) > todayStr) {
        e.reason = `ниже порога, но пауза после прошлой цепочки до ${addDaysStr(closedAt, s.cooldownDays)}`;
        summary.skipped++; continue;
      }
      if (capped) { e.reason = 'ниже порога, отложено: сегодня менеджер уже получал сообщение сценариев'; summary.skipped++; continue; }
      e.action = 'advice'; e.nextStep = 1;
      e.reason = `ниже порога на ${fmtDelta(value - e.threshold, metric)} — совет, проверка через ${s.followupDays} дн.`;
      e.text = renderTemplate(s.adviceText, ctx);
      summary.sent.advice++;
      continue;
    }

    if (e.status === 'norm') {
      if (!s.praiseEnabled || !s.praiseText?.trim()) { e.reason = 'в норме (похвала выключена)'; continue; }
      const praisedAt = state.praisedBy.get(m.bitrixId);
      if (praisedAt && addDaysStr(praisedAt, s.praiseCooldownDays) > todayStr) {
        e.reason = `в норме, хвалили ${praisedAt} — следующая похвала не раньше ${addDaysStr(praisedAt, s.praiseCooldownDays)}`;
        continue;
      }
      if (capped) { e.reason = 'в норме, похвала отложена: сегодня менеджер уже получал сообщение сценариев'; summary.skipped++; continue; }
      e.action = 'praise';
      e.reason = 'в норме или выше цели — похвала';
      e.text = renderTemplate(s.praiseText, ctx);
      summary.sent.praise++;
      continue;
    }

    e.reason = `в коридоре: ниже цели, но не ниже порога (${fmt(e.threshold, metric)})`;
  }

  // Порядок: сначала кто требует действия, внутри — по глубине просадки.
  const order: Record<ManagerEval['action'], number> = { followup_improved: 0, followup_same: 1, advice: 2, praise: 3, none: 4 };
  evals.sort((a, b) => order[a.action] - order[b.action] || (a.delta ?? 0) - (b.delta ?? 0) || a.name.localeCompare(b.name, 'ru'));

  return {
    scenario: s, metric, window: { from: winFrom, to: winTo },
    baselineWindow: s.baseline === 'own_avg' ? { from: baseFrom, to: baseTo } : null,
    evals, summary,
  };
}

// ── Прогон с отправкой и записью состояния ───────────────────────────────────

const KIND_LABEL: Record<ScenarioEventKind, string> = {
  advice: 'совет', followup_same: 'проверка: без улучшения', followup_improved: 'проверка: улучшение', praise: 'похвала',
};

export async function runScenario(s: Scenario, opts: { todayStr?: string; managerIds?: number[] } = {}): Promise<EvaluateResult> {
  const res = await evaluateScenario(s, opts);
  const todayStr = res.summary.date;
  const db = systemDb();
  const only = opts.managerIds ? new Set(opts.managerIds) : null;

  for (const e of res.evals) {
    if (e.action === 'none' || !e.text) continue;
    if (only && !only.has(e.bitrixId)) continue;
    try {
      const prefs = await fetchManagerBotPrefs(e.bitrixId);
      const suppressReason = prefs.enabled ? null : 'manager_opted_out_all';
      const trace = {
        scenario: { id: s.id, name: s.name, metric: s.metricId, baseline: s.baseline },
        window: res.window, baselineWindow: res.baselineWindow,
        value: e.value, base: e.base, threshold: e.threshold, delta: e.delta, status: e.status,
        run: e.run, action: e.action, reason: e.reason,
      };
      await sendManagerBotMessage(e.bitrixId, e.text, `scenario_${e.action}`,
        `Сценарий «${s.name}» · ${KIND_LABEL[e.action]} (${e.name})`, { suppressReason, decisionTrace: trace });

      // Состояние пишем и при suppressReason: менеджер отказался от бота — не
      // спамить ему тем же советом каждый день, цепочка живёт как обычно.
      let runId: number | null = e.run?.id ?? null;
      if (e.action === 'advice') {
        const ins = await db.query<{ id: string }>(
          `INSERT INTO bot_scenario_runs (scenario_id, manager_bitrix_id, step, start_value, last_value, next_check_at, last_sent_at)
           VALUES ($1, $2, 1, $3, $3, $4::date, now())
           ON CONFLICT (scenario_id, manager_bitrix_id) WHERE status = 'open' DO UPDATE SET last_sent_at = now()
           RETURNING id::text`,
          [s.id, e.bitrixId, e.value, addDaysStr(todayStr, s.followupDays)],
        );
        runId = Number(ins.rows[0]?.id ?? 0) || null;
      } else if (e.action === 'followup_improved' || (e.action === 'followup_same' && e.closeReason === 'max_steps')) {
        await db.query(
          `UPDATE bot_scenario_runs SET status = 'closed', closed_at = now(), closed_reason = $2, last_value = $3, last_sent_at = now() WHERE id = $1`,
          [runId, e.closeReason, e.value],
        );
      } else if (e.action === 'followup_same') {
        await db.query(
          `UPDATE bot_scenario_runs SET step = $2, last_value = $3, next_check_at = $4::date, last_sent_at = now() WHERE id = $1`,
          [runId, e.nextStep ?? (e.run?.step ?? 1) + 1, e.value, addDaysStr(todayStr, s.followupDays)],
        );
      }
      await db.query(
        `INSERT INTO bot_scenario_events (scenario_id, run_id, manager_bitrix_id, kind, value, threshold, text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [s.id, runId, e.bitrixId, e.action, e.value, e.threshold, e.text],
      );
    } catch (err) {
      console.warn(`[scenarios] «${s.name}» → менеджер ${e.bitrixId} (${e.action}) не отправлено:`, err instanceof Error ? err.message : err);
    }
  }

  await db.query(`UPDATE bot_scenarios SET last_run_at = now(), last_run_summary = $2 WHERE id = $1`, [s.id, JSON.stringify(res.summary)]);
  return res;
}

/** Тик из instrumentation.ts (раз в минуту): чьи час и день пришли — прогнать.
 *  Защита от дублей/нескольких инстансов — атомарный claim по МСК-дате в
 *  last_run_at, Redis не нужен. */
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
    if (!claimed.rowCount) continue; // другой инстанс уже взял
    const s = await loadScenario(id);
    if (!s) continue;
    try {
      const res = await runScenario(s, { todayStr });
      const sent = res.summary.sent;
      console.log(`[scenarios] «${s.name}»: менеджеров ${res.summary.managers}, ниже порога ${res.summary.below}, советов ${sent.advice}, проверок ${sent.followup_same + sent.followup_improved}, похвал ${sent.praise}`);
    } catch (err) {
      console.error(`[scenarios] «${s.name}» упал:`, err instanceof Error ? err.message : err);
      await db.query(`UPDATE bot_scenarios SET last_run_summary = $2 WHERE id = $1`,
        [id, JSON.stringify({ date: todayStr, error: err instanceof Error ? err.message : String(err) })]).catch(() => {});
    }
  }
}

/** Закрыть открытые цепочки сценария (выключение/удаление) — чтобы после
 *  включения обратно не посыпались «проверки» месячной давности. */
export async function closeOpenRuns(scenarioId: string, reason: 'disabled' | 'manual'): Promise<number> {
  const r = await systemDb().query(
    `UPDATE bot_scenario_runs SET status = 'closed', closed_at = now(), closed_reason = $2 WHERE scenario_id = $1 AND status = 'open'`,
    [scenarioId, reason],
  );
  return r.rowCount ?? 0;
}

export type { ManagerRef };
