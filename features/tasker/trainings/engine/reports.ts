// Отчёты эффективности обучений (миграция 277): свод по тренерам / темам / показателям за период и история
// обучений менеджера. Видимость — как у карточки события: тренер и админ — все, РОП — свои менеджеры
// (срез сессии), менеджер — только себя (срез «self» = свой bitrix id).
import 'server-only';
import { systemDb } from '@/lib/db/clients';
import { resolveEmployeeNames } from '@/lib/org/employeeDirectory';
import { canSeeManager } from '@/lib/org/sessionScope';
import type { Snapshot } from '../../types';
import type {
  TrainingEffectMetricRow, TrainingEffectRow, TrainingEffectivenessResponse, TrainingHistoryItem,
  TrainingHistoryResponse, TrainingLogEntry, TrainingOutcome, TrainingResult,
} from '../types';
import { personMetricIds, personOutcome } from './effect';
import { publicMetrics, TrainingError, type TrainingActor } from './index';
import { loadResults, resultKey } from './results';

const seesAll = (a: TrainingActor) => a.canManage || a.scope.kind === 'all';
const canView = (a: TrainingActor, managerId: string) => seesAll(a) || canSeeManager(a.scope, managerId);

/** Итог человека, если замерены все его показатели; иначе null («ждёт замера»). */
function outcomeIfComplete(need: string[], results: TrainingResult[]): TrainingOutcome | null {
  if (!need.length || !need.every(id => results.some(r => r.metricId === id && r.verdict))) return null;
  return personOutcome(results);
}

function emptyRow(key: string, label: string): TrainingEffectRow {
  return { key, label, events: 0, people: 0, measured: 0, improved: 0, noChange: 0, notEnoughData: 0, improvedShare: null };
}
function finish<T extends TrainingEffectRow>(r: T): T {
  const base = r.measured - r.notEnoughData;
  return { ...r, improvedShare: base > 0 ? r.improved / base : null };
}

export async function effectiveness(actor: TrainingActor, from: string, to: string): Promise<TrainingEffectivenessResponse> {
  const db = systemDb();
  const ev = await db.query<{ id: string; title: string; trainer: string | null; metric_ids: string[] }>(
    `SELECT id, title, trainer_bitrix_user_id AS trainer, metric_ids FROM tasker_training_events
      WHERE cancelled_at IS NULL AND start_at <= now() AND start_at >= $1::date AND start_at < ($2::date + 1)
      ORDER BY start_at LIMIT 2000`, [from, to]);
  const metrics = await publicMetrics();
  if (!ev.rows.length) return { from, to, byTrainer: [], byTopic: [], byMetric: [], metrics };
  const en = await db.query<{ event_id: string; m: string; goal_metric_ids: string[]; task_metric_id: string | null }>(
    `SELECT event_id, manager_bitrix_user_id AS m, goal_metric_ids, task_metric_id FROM tasker_training_enrollments
      WHERE event_id = ANY($1::bigint[]) AND attended`, [ev.rows.map(e => e.id)]);
  const people = en.rows.filter(x => canView(actor, x.m));
  const results = await loadResults(ev.rows.map(e => e.id));
  const names = await resolveEmployeeNames(ev.rows.map(e => Number(e.trainer)).filter(n => Number.isFinite(n) && n > 0));
  const evById = new Map(ev.rows.map(e => [e.id, e]));
  const metricById = new Map(metrics.map(m => [m.id, m]));

  const trainers = new Map<string, TrainingEffectRow>();
  const topics = new Map<string, TrainingEffectRow>();
  const byMetric = new Map<string, TrainingEffectMetricRow & { _events: Set<string>; _d: number[]; _dd: number[] }>();
  const rowFor = (map: Map<string, TrainingEffectRow>, key: string, label: string) => {
    let r = map.get(key);
    if (!r) { r = emptyRow(key, label); map.set(key, r); }
    return r;
  };
  // Сколько провёл — все прошедшие неотменённые события периода (и с нулём посетивших).
  for (const e of ev.rows) {
    const tKey = e.trainer ?? '—';
    rowFor(trainers, tKey, e.trainer ? names.get(Number(e.trainer)) ?? `Сотрудник #${e.trainer}` : 'Без тренера').events++;
    const topicKey = e.title.trim().toLowerCase();
    rowFor(topics, topicKey, e.title.trim()).events++;
  }
  const tally = (r: TrainingEffectRow, o: TrainingOutcome | null) => {
    r.people++;
    if (!o) return;
    r.measured++;
    if (o === 'improved') r.improved++;
    else if (o === 'no_change') r.noChange++;
    else r.notEnoughData++;
  };
  for (const p of people) {
    const e = evById.get(p.event_id)!;
    const need = personMetricIds(e.metric_ids ?? [], p.goal_metric_ids ?? [], p.task_metric_id);
    const res = results.get(resultKey(p.event_id, p.m)) ?? [];
    const o = outcomeIfComplete(need, res);
    tally(trainers.get(e.trainer ?? '—')!, o);
    tally(topics.get(e.title.trim().toLowerCase())!, o);
    for (const id of need) {
      const def = metricById.get(id);
      let row = byMetric.get(id);
      if (!row) {
        row = {
          ...emptyRow(id, def?.label ?? id), format: def?.format ?? 'number', higherIsBetter: def?.higherIsBetter ?? true,
          avgDelta: null, avgDeptDelta: null, _events: new Set(), _d: [], _dd: [],
        };
        byMetric.set(id, row);
      }
      row._events.add(p.event_id);
      row.people++;
      const r = res.find(x => x.metricId === id);
      if (!r?.verdict) continue;
      row.measured++;
      if (r.verdict === 'improved' || r.verdict === 'achieved') row.improved++;
      else if (r.verdict === 'no_change') row.noChange++;
      else { row.notEnoughData++; continue; }
      if (r.valueBefore !== null && r.valueAfter !== null) row._d.push(r.valueAfter - r.valueBefore);
      if (r.deptBefore !== null && r.deptAfter !== null) row._dd.push(r.deptAfter - r.deptBefore);
    }
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const sort = <T extends TrainingEffectRow>(xs: T[]) => xs.sort((a, b) => b.people - a.people || b.events - a.events || a.label.localeCompare(b.label, 'ru'));
  return {
    from, to, metrics,
    byTrainer: sort([...trainers.values()].map(finish)),
    byTopic: sort([...topics.values()].map(finish)),
    byMetric: sort([...byMetric.values()].map(({ _events, _d, _dd, ...r }) => finish({ ...r, events: _events.size, avgDelta: avg(_d), avgDeptDelta: avg(_dd) }))),
  };
}

export async function managerHistory(actor: TrainingActor, managerId: string): Promise<TrainingHistoryResponse> {
  if (!canView(actor, managerId)) throw new TrainingError('Этот менеджер вам недоступен', 403);
  const db = systemDb();
  const [en, log] = await Promise.all([
    db.query<{
      event_id: string; enrolled_by_name: string | null; goal_metric_ids: string[]; goal_note: string | null;
      tasker_task_id: string | null; attended: boolean | null; task_metric_id: string | null; task_snapshot: Snapshot | null;
    }>(
      `SELECT x.event_id, u.display_name AS enrolled_by_name, x.goal_metric_ids, x.goal_note, x.tasker_task_id, x.attended,
              x.task_metric_id, x.task_snapshot
         FROM tasker_training_enrollments x LEFT JOIN users u ON u.id = x.enrolled_by
        WHERE x.manager_bitrix_user_id = $1`, [managerId]),
    db.query<{ event_id: string; action: TrainingLogEntry['action']; created_at: Date; actor_name: string | null; details: Record<string, unknown> }>(
      `SELECT l.event_id, l.action, l.created_at, u.display_name AS actor_name, l.details
         FROM tasker_training_enrollment_log l LEFT JOIN users u ON u.id = l.actor_user_id
        WHERE l.manager_bitrix_user_id = $1 ORDER BY l.created_at`, [managerId]),
  ]);
  const eventIds = [...new Set([...en.rows.map(x => x.event_id), ...log.rows.map(x => x.event_id)])];
  const [names, metrics] = await Promise.all([resolveEmployeeNames([Number(managerId)]), publicMetrics()]);
  const manager = { id: Number(managerId), name: names.get(Number(managerId)) ?? `Сотрудник #${managerId}` };
  if (!eventIds.length) return { manager, items: [], metrics };
  const ev = await db.query<{
    id: string; title: string; start_at: Date; duration_min: number; trainer: string | null; cancelled_at: Date | null; metric_ids: string[];
  }>(
    `SELECT id, title, start_at, duration_min, trainer_bitrix_user_id AS trainer, cancelled_at, metric_ids
       FROM tasker_training_events WHERE id = ANY($1::bigint[]) ORDER BY start_at DESC`, [eventIds]);
  const trainerNames = await resolveEmployeeNames(ev.rows.map(e => Number(e.trainer)).filter(n => Number.isFinite(n) && n > 0));
  const results = await loadResults(eventIds, [managerId]);
  const enBy = new Map(en.rows.map(x => [x.event_id, x]));
  const items: TrainingHistoryItem[] = ev.rows.map(e => {
    const x = enBy.get(e.id);
    const lastEnroll = [...log.rows].reverse().find(l => l.event_id === e.id && (l.action === 'enroll' || l.action === 'goal'));
    const res = x?.attended ? results.get(resultKey(e.id, managerId)) ?? [] : [];
    const need = personMetricIds(e.metric_ids ?? [], x?.goal_metric_ids ?? [], x?.task_metric_id ?? null);
    return {
      event: {
        id: Number(e.id), title: e.title, startsAt: e.start_at.toISOString(), durationMin: e.duration_min,
        trainer: e.trainer ? { id: Number(e.trainer), name: trainerNames.get(Number(e.trainer)) ?? `Сотрудник #${e.trainer}` } : null,
        cancelledAt: e.cancelled_at ? e.cancelled_at.toISOString() : null,
      },
      enrolled: !!x,
      enrolledBy: x?.enrolled_by_name ?? lastEnroll?.actor_name ?? null,
      goalMetricIds: x?.goal_metric_ids ?? ((lastEnroll?.details?.goalMetricIds as string[] | undefined) ?? []),
      goalNote: x?.goal_note ?? ((lastEnroll?.details?.goalNote as string | undefined) ?? null),
      taskerTaskId: x?.tasker_task_id ? Number(x.tasker_task_id) : null,
      attended: x?.attended ?? null,
      results: res,
      outcome: x?.attended ? outcomeIfComplete(need, res) : null,
      log: log.rows.filter(l => l.event_id === e.id).map(l => ({
        action: l.action, at: l.created_at.toISOString(), actorName: l.actor_name, details: l.details ?? {},
      })),
    };
  });
  return { manager, items, metrics };
}
