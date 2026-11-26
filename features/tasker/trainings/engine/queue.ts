// Канбан тренера (TASKER_FEEDBACK_2026-11-23.md п.6, миграция 281): все открытые задачи «Теория» на тренера по всем
// менеджерам, сгруппированные по показателю — «очередь». Тренер выделяет 3–5 человек по теме → «Собрать занятие»:
// событие обучения с записью этих менеджеров, задачи связываются с событием (tasker_tasks.training_event_id).
// Автопредложение: по теме набралось ≥ min — ближайший слот сетки тренера, где тренер свободен (и по возможности
// все менеджеры), с учётом закреплённых за слотом отделов. Занятость — checkAvailability ядра (Битрикс + Монолитика).
import 'server-only';
import { systemDb } from '@/lib/db/clients';
import { resolveEmployeeNames } from '@/lib/org/employeeDirectory';
import { canSeeManager } from '@/lib/org/sessionScope';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { checkAvailability } from '../../engine/availability';
import type { Snapshot } from '../../types';
import type {
  TrainingAssembleResponse, TrainingQueueGroup, TrainingQueueItem, TrainingQueueResponse, TrainingSlot, TrainingSuggestion,
} from '../types';
import { createEvent, enroll, getEvent, publicMetrics, TrainingError, type TrainingActor } from './index';
import { closureMessage, closuresBetween, findClosure } from './closures';
import { defaultTrainerId, groupMaxFor, groupSettings, loadSlots } from './slots';
import { theoryTaskWhere } from './theory';

const seesAll = (a: TrainingActor) => a.canManage || a.scope.kind === 'all';

interface QueueRow {
  id: string; bitrix_task_id: string | null; title: string; body: string; manager_bitrix_id: string; manager_name: string | null;
  dept_name: string | null; creator_name: string | null; rop_name: string | null; metric_id: string; snapshot: Snapshot | null;
  created_at: Date; deadline: Date; slot_start: Date | null; ev_id: string | null; ev_title: string | null; ev_start: Date | null;
}

async function loadQueue(actor: TrainingActor, opts: { metricId?: string; taskIds?: number[] } = {}): Promise<TrainingQueueItem[] | null> {
  const trainer = await defaultTrainerId();
  const theory = await theoryTaskWhere('t', trainer);
  if (!theory) return null;
  const args: unknown[] = [...theory.args];
  const where = [theory.sql, 't.cancelled_at IS NULL', 't.closed_at IS NULL', 't.verdict IS NULL', 'COALESCE(t.bitrix_status, 0) NOT IN (5, 6, 7)',
    // назначено на прошедшее занятие — из очереди уходит (задачу закрывает тренер/РОП)
    '(ev.id IS NULL OR ev.start_at + make_interval(mins => ev.duration_min) > now())'];
  if (opts.metricId) { args.push(opts.metricId); where.push(`t.metric_id = $${args.length}`); }
  if (opts.taskIds) { args.push(opts.taskIds); where.push(`t.id = ANY($${args.length}::bigint[])`); }
  const r = await systemDb().query<QueueRow>(
    `SELECT t.id, t.bitrix_task_id, t.title, t.body, t.manager_bitrix_id, t.manager_name, t.dept_name, t.creator_name, t.rop_name,
            t.metric_id, t.snapshot, t.created_at, t.deadline, t.slot_start, ev.id AS ev_id, ev.title AS ev_title, ev.start_at AS ev_start
       FROM tasker_tasks t
       LEFT JOIN tasker_training_events ev ON ev.id = t.training_event_id AND ev.cancelled_at IS NULL
      WHERE ${where.join(' AND ')}
      ORDER BY t.created_at, t.id
      LIMIT 1000`, args);
  const rows = seesAll(actor) ? r.rows : r.rows.filter(x => canSeeManager(actor.scope, x.manager_bitrix_id));
  const missing = rows.filter(x => !x.manager_name).map(x => Number(x.manager_bitrix_id));
  const names = missing.length ? await resolveEmployeeNames(missing) : new Map<number, string>();
  return rows.map(x => ({
    taskId: Number(x.id), bitrixTaskId: x.bitrix_task_id ? Number(x.bitrix_task_id) : null, title: x.title, body: x.body,
    manager: { id: Number(x.manager_bitrix_id), name: x.manager_name ?? names.get(Number(x.manager_bitrix_id)) ?? `Сотрудник #${x.manager_bitrix_id}` },
    departmentName: x.dept_name ?? x.snapshot?.deptName ?? null, creatorName: x.creator_name, ropName: x.rop_name,
    metricId: x.metric_id, snapshot: x.snapshot && Object.keys(x.snapshot).length ? x.snapshot : null,
    createdAt: x.created_at.toISOString(), deadline: x.deadline.toISOString(),
    event: x.ev_id ? { id: Number(x.ev_id), title: x.ev_title ?? '', startsAt: (x.ev_start as Date).toISOString() } : null,
    ownSlot: !x.ev_id && x.slot_start ? x.slot_start.toISOString() : null,
  }));
}

export async function queue(actor: TrainingActor): Promise<TrainingQueueResponse> {
  const [items, group, metrics, trainerId] = await Promise.all([loadQueue(actor), groupSettings(), publicMetrics(), defaultTrainerId()]);
  const trainerName = (await resolveEmployeeNames([Number(trainerId)])).get(Number(trainerId)) ?? `Сотрудник #${trainerId}`;
  const label = new Map(metrics.map(m => [m.id, m.label]));
  const kindOf = new Map(metrics.map(m => [m.id, m.kind]));
  // Обучения по материалам (тема — товарная группа) — большие группы (group.maxProduct), остальные — group.max.
  const maxOf = (id: string) => (kindOf.get(id) === 'product_group' || /^pg_/.test(id) ? group.maxProduct : group.max);
  const order = new Map(metrics.map((m, i) => [m.id, i]));
  const by = new Map<string, TrainingQueueGroup>();
  for (const it of items ?? []) {
    let g = by.get(it.metricId);
    if (!g) { g = { metricId: it.metricId, label: label.get(it.metricId) ?? it.metricId, items: [], waiting: 0, max: maxOf(it.metricId) }; by.set(it.metricId, g); }
    g.items.push(it);
    if (!it.event && !it.ownSlot) g.waiting++; // своё время у РОПа — не ждёт группу
  }
  const groups = [...by.values()].sort((a, b) => b.waiting - a.waiting || (order.get(a.metricId) ?? 999) - (order.get(b.metricId) ?? 999));
  return {
    groups, group, metrics, canManage: actor.canManage, available: items !== null,
    trainer: { id: Number(trainerId), name: trainerName },
  };
}

// ── Автопредложение слота ───────────────────────────────────────────────────

const ymdMsk = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);
const isoWeekday = (ymd: string) => { const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
const addYmd = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** Не предлагаем слоты, до которых меньше часа: людям надо успеть увидеть приглашение. */
const LEAD_MS = 60 * 60_000;

/** Закреплённый слот без выбранных отделов (только подпись из Excel) автоматически не предлагается. */
export const slotAutoEligible = (s: TrainingSlot) => s.active && !(s.departmentIds.length === 0 && !!s.departmentLabel);

export async function suggest(actor: TrainingActor, metricId: string, rawTaskIds: unknown, rawLimit: unknown): Promise<TrainingSuggestion[]> {
  if (!actor.canManage) throw new TrainingError('Собирать занятия из очереди может тренер', 403);
  if (!metricId) throw new TrainingError('Не указана тема');
  const limit = Math.min(6, Math.max(1, Number(rawLimit) || 3));
  const [items, group, trainer, slots] = await Promise.all([loadQueue(actor, { metricId }), groupSettings(), defaultTrainerId(), loadSlots()]);
  // Время, выбранное РОПом (один на один), в группу не тянем — правка Будковского 25.11.
  const waiting = (items ?? []).filter(i => !i.event && !i.ownSlot);
  const wanted = Array.isArray(rawTaskIds) ? new Set(rawTaskIds.map(Number)) : null;
  const max = await groupMaxFor([metricId], group);
  // По материалам (большие группы) по умолчанию берём всех ждущих до максимума, иначе — «обычно берём».
  const chosen = (wanted && wanted.size ? waiting.filter(i => wanted.has(i.taskId)) : waiting)
    .slice(0, wanted && wanted.size ? max : max > group.max ? max : group.target);
  if (!chosen.length) return [];
  const managers = [...new Set(chosen.map(i => String(i.manager.id)))];

  // Закрепление: слот с отделами — только если все выбранные менеджеры из этих отделов.
  const eligible: TrainingSlot[] = [];
  for (const s of slots.filter(slotAutoEligible)) {
    if (s.departmentIds.length) {
      const inDept = new Set((await resolveManagersForDepartments(s.departmentIds)).map(m => m.managerId));
      if (!managers.every(m => inDept.has(m))) continue;
    }
    eligible.push(s);
  }
  if (!eligible.length) return [];

  const now = Date.now();
  const today = ymdMsk(now);
  const cands: { slot: TrainingSlot; start: number; end: number }[] = [];
  for (let d = 0; d <= group.horizonDays && cands.length < 120; d++) {
    const ymd = addYmd(today, d);
    const wd = isoWeekday(ymd);
    for (const s of eligible) {
      if (s.weekday !== wd) continue;
      const start = Date.parse(`${ymd}T${s.startTime}:00+03:00`);
      if (start - now < LEAD_MS) continue;
      cands.push({ slot: s, start, end: start + s.durationMin * 60_000 });
    }
  }
  cands.sort((a, b) => a.start - b.start);
  // Закрытое тренером время (299) не предлагаем.
  if (cands.length) {
    const closed = await closuresBetween(trainer, cands[0].start, cands[cands.length - 1].end);
    if (closed.length) {
      const open = cands.filter(c => !closed.some(x => Date.parse(x.startsAt) < c.end && c.start < Date.parse(x.endsAt)));
      cands.length = 0;
      cands.push(...open);
    }
  }
  if (!cands.length) return [];

  const avail = await checkAvailability([trainer, ...managers], cands.map(c => ({ start: c.start, end: c.end })), {}, () => true);
  const trainerBusy = new Set((avail.busy.find(p => String(p.id) === trainer)?.conflicts ?? []).map(c => c.slotIndex));
  const name = new Map(chosen.map(i => [String(i.manager.id), i.manager.name]));
  const scored = cands.map((c, idx) => {
    const busy: TrainingSuggestion['busy'] = [];
    for (const p of avail.busy) {
      if (String(p.id) === trainer) continue;
      const hit = p.conflicts.find(x => x.slotIndex === idx);
      if (hit) busy.push({ managerId: p.id, name: name.get(String(p.id)) ?? p.name, title: hit.title });
    }
    return { c, idx, busy };
  }).filter(x => !trainerBusy.has(x.idx));
  // Сначала — где свободны все (по времени), затем — где занятых меньше всего.
  const free = scored.filter(x => x.busy.length === 0);
  const rest = scored.filter(x => x.busy.length > 0).sort((a, b) => a.busy.length - b.busy.length || a.c.start - b.c.start);
  return [...free, ...rest].slice(0, limit).map(x => ({
    startsAt: new Date(x.c.start).toISOString(), durationMin: x.c.slot.durationMin, slotId: x.c.slot.id,
    slotLabel: x.c.slot.label, place: x.c.slot.place, departmentLabel: x.c.slot.departmentLabel,
    taskIds: chosen.map(i => i.taskId), busy: x.busy, bitrixChecked: avail.bitrixChecked,
  }));
}

// ── «Собрать занятие» ───────────────────────────────────────────────────────

export async function assemble(actor: TrainingActor, raw: unknown): Promise<TrainingAssembleResponse> {
  if (!actor.canManage) throw new TrainingError('Собирать занятия из очереди может тренер', 403);
  const b = (raw ?? {}) as Record<string, unknown>;
  const taskIds = Array.isArray(b.taskIds) ? [...new Set(b.taskIds.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
  const group = await groupSettings();
  if (!taskIds.length) throw new TrainingError('Выберите менеджеров из очереди');
  const items = await loadQueue(actor, { taskIds });
  if (!items) throw new TrainingError('Задачи «Теория» ещё не развёрнуты в ядре Задачника', 409);
  const found = new Map(items.map(i => [i.taskId, i]));
  const lost = taskIds.filter(id => !found.get(id) || found.get(id)!.event || found.get(id)!.ownSlot);
  if (lost.length) throw new TrainingError('Часть задач уже не в очереди (закрыты или назначены на занятие) — обновите список', 409);
  const chosen = taskIds.map(id => found.get(id)!);
  const max = await groupMaxFor([...new Set(chosen.map(i => i.metricId))], group);
  if (taskIds.length > max) throw new TrainingError(`В группе не больше ${max} человек`);
  const startMs = Date.parse(String(b.startsAt ?? ''));
  const durMin = Number(b.durationMin);
  if (Number.isFinite(startMs) && Number.isFinite(durMin) && durMin > 0) {
    const closed = await findClosure(await defaultTrainerId(), startMs, startMs + durMin * 60_000);
    if (closed) throw new TrainingError(closureMessage(closed), 409);
  }

  const metricIds = Array.isArray(b.metricIds) && b.metricIds.length ? b.metricIds : [...new Set(chosen.map(i => i.metricId))];
  const depts = [...new Set(chosen.map(i => i.departmentName).filter((x): x is string => !!x))];
  const departmentLabel = b.departmentLabel != null && String(b.departmentLabel).trim()
    ? String(b.departmentLabel) : depts.length && depts.length <= 2 ? depts.join(', ') : null;
  const managersCount = new Set(chosen.map(i => i.manager.id)).size;
  const event = await createEvent(actor, {
    title: b.title, description: b.description ?? '', startsAt: b.startsAt, durationMin: b.durationMin, place: b.place ?? null,
    capacity: Math.max(max, managersCount), trainerId: Number(await defaultTrainerId()), metricIds,
    slotId: b.slotId ?? null, departmentLabel,
  });

  const failed: TrainingAssembleResponse['failed'] = [];
  const linked: number[] = [];
  for (const it of chosen) {
    try {
      await enroll(actor, event.id, it.manager.id, it.taskId);
      linked.push(it.taskId);
    } catch (e) {
      failed.push({ taskId: it.taskId, reason: e instanceof Error ? e.message : 'не удалось записать' });
    }
  }
  if (linked.length) {
    await systemDb().query('UPDATE tasker_tasks SET training_event_id = $1, updated_at = now() WHERE id = ANY($2::bigint[])', [event.id, linked]);
  }
  return { event: await getEvent(actor, event.id), failed };
}
