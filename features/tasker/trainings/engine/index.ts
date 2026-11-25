// Обучения Задачника — движок (TASKER_SPEC.md «Обучения», фаза 1; миграции 275, 277).
// Таблицы system БД: tasker_training_events, tasker_training_enrollments (+ журнал и замеры — 277).
//
// Права:
//  - видеть расписание — все с section.tasker (проверяет роут);
//  - создавать/править/отменять — action.tasker.trainings.manage (тренер, выдаётся лично;
//    имя тренера в код не зашиваем);
//  - записывать/отписывать менеджера — РОП/директор/админ (срез сессии не «только себя»)
//    или носитель action.tasker.assign — и только видимых им менеджеров (canSeeManager).
//    Тренер может записать/отписать любого (ведёт своё событие).
import 'server-only';
import type { SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { getEmployeeDirectory, resolveEmployeeNames } from '@/lib/org/employeeDirectory';
import { getSalesDepartmentOptions, resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { canSeeManager, getSessionScope, type SessionScope } from '@/lib/org/sessionScope';
import { loadMetricDefs, publicMetric } from '../../engine/config';
import { ensureTopicIds } from '../../engine/topics';
import type { Snapshot, TaskerMetric } from '../../types';
import { retryStaleCalendarSyncs, syncTrainingCalendar } from './calendar';
import { DEFAULT_MEASURE_DAYS, personMetricIds, personOutcome, summarize, trainingWindows } from './effect';
import { loadResults, resultKey, writeLog } from './results';
import { syncTaskEnrollmentsThrottled } from './taskLink';
import type {
  TrainingAttendee, TrainingEnrollment, TrainingEvent, TrainingManagerOption,
} from '../types';

/** Белый список показателей Задачника для ответа клиенту (подписи/формат). Таблицы ещё нет — пусто. */
export async function publicMetrics(): Promise<TaskerMetric[]> {
  const defs = await loadMetricDefs().catch(() => []);
  return defs.map(publicMetric); // с типом темы и признаком архива (миграция 282)
}

export class TrainingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface TrainingActor {
  session: SessionUser;
  scope: SessionScope;
  canManage: boolean;
  canEnroll: boolean;
}

export async function getTrainingActor(session: SessionUser): Promise<TrainingActor> {
  const scope = await getSessionScope(session);
  const canManage = hasPerm(session, 'action.tasker.trainings.manage');
  const canEnroll = canManage || hasPerm(session, 'action.tasker.assign') || scope.kind !== 'self';
  return { session, scope, canManage, canEnroll };
}

/** Тренер видит и правит любую запись; остальные — только менеджеров своего среза. */
function canTouchManager(actor: TrainingActor, managerId: string): boolean {
  return actor.canManage || canSeeManager(actor.scope, managerId);
}

// ── Чтение ─────────────────────────────────────────────────────────────────

interface EventRow {
  id: string; title: string; description: string; start_at: Date; duration_min: number;
  place: string | null; capacity: number | null; trainer_bitrix_user_id: string | null;
  cancelled_at: Date | null; enrolled_count: string;
  calendar_event_id: string | null; calendar_sync_state: string; calendar_sync_error: string | null;
  metric_ids: string[]; measure_before_days: number; measure_after_days: number;
  slot_id: string | null; department_label: string | null;
}
interface EnrollRow {
  event_id: string; manager_bitrix_user_id: string; enrolled_by_name: string | null;
  tasker_task_id: string | null; created_at: Date;
  goal_metric_ids: string[]; goal_note: string | null; task_metric_id: string | null; task_snapshot: Snapshot | null;
  attended: boolean | null;
}

export interface ListEventsParams {
  from?: string | null;
  to?: string | null;
  /** Только ещё не закончившиеся. */
  upcoming?: boolean;
  includeCancelled?: boolean;
  ids?: number[];
}

export async function listEvents(actor: TrainingActor, p: ListEventsParams = {}): Promise<TrainingEvent[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('$?', `$${args.length}`)); };
  if (p.ids?.length) add('e.id = ANY($?::bigint[])', p.ids);
  if (p.from) add('e.start_at >= $?::date', p.from);
  if (p.to) add(`e.start_at < ($?::date + 1)`, p.to);
  if (p.upcoming) where.push(`e.start_at + make_interval(mins => e.duration_min) > now()`);
  if (!p.includeCancelled) where.push('e.cancelled_at IS NULL');
  retryStaleCalendarSyncs();
  await syncTaskEnrollmentsThrottled(); // записи «из формы задачи» — до чтения, чтобы были видны сразу
  const db = systemDb();
  const ev = await db.query<EventRow>(
    `SELECT e.id, e.title, e.description, e.start_at, e.duration_min, e.place, e.capacity,
            e.trainer_bitrix_user_id, e.cancelled_at,
            e.calendar_event_id, e.calendar_sync_state, e.calendar_sync_error,
            e.metric_ids, e.measure_before_days, e.measure_after_days,
            -- колонки 281 через to_jsonb: до наката миграции расписание продолжает работать
            to_jsonb(e) ->> 'slot_id' AS slot_id, to_jsonb(e) ->> 'department_label' AS department_label,
            (SELECT count(*) FROM tasker_training_enrollments x WHERE x.event_id = e.id) AS enrolled_count
       FROM tasker_training_events e
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.start_at, e.id
      LIMIT 500`,
    args,
  );
  if (ev.rows.length === 0) return [];
  const en = await db.query<EnrollRow>(
    `SELECT x.event_id, x.manager_bitrix_user_id, u.display_name AS enrolled_by_name, x.tasker_task_id, x.created_at,
            x.goal_metric_ids, x.goal_note, x.task_metric_id, x.task_snapshot, x.attended
       FROM tasker_training_enrollments x
       LEFT JOIN users u ON u.id = x.enrolled_by
      WHERE x.event_id = ANY($1::bigint[])
      ORDER BY x.created_at`,
    [ev.rows.map(r => r.id)],
  );
  const ids = [
    ...ev.rows.map(r => Number(r.trainer_bitrix_user_id)),
    ...en.rows.map(r => Number(r.manager_bitrix_user_id)),
  ].filter(n => Number.isFinite(n) && n > 0);
  const [names, dir] = await Promise.all([resolveEmployeeNames(ids), getEmployeeDirectory()]);
  const results = await loadResults(ev.rows.map(r => r.id));
  const evById = new Map(ev.rows.map(r => [r.id, r]));
  const person = (raw: string | null) => {
    const id = Number(raw);
    return raw && Number.isFinite(id) ? { id, name: names.get(id) ?? `Сотрудник #${id}` } : null;
  };
  const byEvent = new Map<string, TrainingAttendee[]>();
  for (const r of en.rows) {
    if (!canTouchManager(actor, r.manager_bitrix_user_id)) continue; // чужие — только числом
    const m = person(r.manager_bitrix_user_id)!;
    const list = byEvent.get(r.event_id) ?? [];
    list.push({
      manager: m,
      departmentName: dir.get(m.id)?.departmentName ?? null,
      enrolledBy: r.enrolled_by_name,
      taskerTaskId: r.tasker_task_id ? Number(r.tasker_task_id) : null,
      enrolledAt: r.created_at.toISOString(),
      canUnenroll: actor.canEnroll,
      goalMetricIds: r.goal_metric_ids ?? [],
      goalNote: r.goal_note,
      taskMetricId: r.task_metric_id,
      taskSnapshot: r.task_snapshot,
      attended: r.attended,
      results: r.attended ? results.get(resultKey(r.event_id, r.manager_bitrix_user_id)) ?? [] : [],
      outcome: null,
    });
    const a = list[list.length - 1];
    const evr = evById.get(r.event_id);
    const need = personMetricIds(evr?.metric_ids ?? [], a.goalMetricIds, a.taskMetricId);
    a.outcome = a.attended && need.length && need.every(id => a.results.some(x => x.metricId === id && x.verdict))
      ? personOutcome(a.results) : null;
    byEvent.set(r.event_id, list);
  }
  return ev.rows.map(r => ({
    id: Number(r.id),
    title: r.title,
    description: r.description,
    startsAt: r.start_at.toISOString(),
    durationMin: r.duration_min,
    place: r.place,
    capacity: r.capacity,
    trainer: person(r.trainer_bitrix_user_id),
    cancelledAt: r.cancelled_at ? r.cancelled_at.toISOString() : null,
    enrolledCount: Number(r.enrolled_count),
    attendees: byEvent.get(r.id) ?? [],
    metricIds: r.metric_ids ?? [],
    measureBeforeDays: r.measure_before_days ?? DEFAULT_MEASURE_DAYS,
    measureAfterDays: r.measure_after_days ?? DEFAULT_MEASURE_DAYS,
    slotId: r.slot_id ? Number(r.slot_id) : null,
    departmentLabel: r.department_label,
    effect: summarize(
      (byEvent.get(r.id) ?? []).map(a => ({
        attended: a.attended, outcome: a.outcome, resultsComplete: a.outcome !== null,
        measurable: personMetricIds(r.metric_ids ?? [], a.goalMetricIds, a.taskMetricId).length > 0,
      })),
      trainingWindows(r.start_at, r.measure_before_days ?? DEFAULT_MEASURE_DAYS, r.measure_after_days ?? DEFAULT_MEASURE_DAYS).measureFrom,
    ),
    calendar: {
      state: (r.calendar_sync_state === 'synced' || r.calendar_sync_state === 'failed' ? r.calendar_sync_state : 'pending') as TrainingEvent['calendar']['state'],
      // Текст ошибки Битрикса — только тренеру (может содержать технические детали).
      error: actor.canManage ? r.calendar_sync_error : null,
      eventId: r.calendar_event_id ? Number(r.calendar_event_id) : null,
    },
  }));
}

export async function getEvent(actor: TrainingActor, id: number): Promise<TrainingEvent> {
  const [e] = await listEvents(actor, { ids: [id], includeCancelled: true });
  if (!e) throw new TrainingError('Обучение не найдено', 404);
  return e;
}

/**
 * Записи менеджеров на обучения (для видов Задачника B: «Неделя»/«Сегодня»).
 * managerIds режутся срезом сессии; пустой список = весь срез. Отменённые события не отдаются.
 */
export async function listEnrollments(
  actor: TrainingActor,
  p: { managerIds?: number[]; from?: string | null; to?: string | null },
): Promise<TrainingEnrollment[]> {
  const args: unknown[] = [];
  const where = ['e.cancelled_at IS NULL'];
  if (p.from) { args.push(p.from); where.push(`e.start_at >= $${args.length}::date`); }
  if (p.to) { args.push(p.to); where.push(`e.start_at < ($${args.length}::date + 1)`); }
  let requested = (p.managerIds ?? []).map(String);
  if (actor.scope.kind !== 'all') {
    const allowed = actor.scope.managerIds;
    requested = requested.length ? requested.filter(id => allowed.has(id)) : [...allowed];
    if (requested.length === 0) return [];
  }
  if (requested.length) { args.push(requested); where.push(`x.manager_bitrix_user_id = ANY($${args.length}::text[])`); }
  const r = await systemDb().query<{
    event_id: string; title: string; start_at: Date; duration_min: number; place: string | null;
    trainer_bitrix_user_id: string | null; manager_bitrix_user_id: string;
  }>(
    `SELECT e.id AS event_id, e.title, e.start_at, e.duration_min, e.place, e.trainer_bitrix_user_id, x.manager_bitrix_user_id
       FROM tasker_training_enrollments x
       JOIN tasker_training_events e ON e.id = x.event_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.start_at, x.manager_bitrix_user_id
      LIMIT 2000`,
    args,
  );
  const names = await resolveEmployeeNames(
    r.rows.flatMap(x => [Number(x.manager_bitrix_user_id), Number(x.trainer_bitrix_user_id)]).filter(n => Number.isFinite(n) && n > 0),
  );
  const nm = (id: number) => names.get(id) ?? `Сотрудник #${id}`;
  return r.rows.map(x => {
    const tId = Number(x.trainer_bitrix_user_id);
    const mId = Number(x.manager_bitrix_user_id);
    return {
      eventId: Number(x.event_id),
      title: x.title,
      startsAt: x.start_at.toISOString(),
      durationMin: x.duration_min,
      place: x.place,
      trainer: x.trainer_bitrix_user_id && Number.isFinite(tId) ? { id: tId, name: nm(tId) } : null,
      manager: { id: mId, name: nm(mId) },
    };
  });
}

/** Кого текущий пользователь может записать (SearchSelect «Записать менеджера»). */
export async function listEnrollableManagers(actor: TrainingActor): Promise<TrainingManagerOption[]> {
  if (!actor.canEnroll) return [];
  // Только сотрудники отделов продаж (дерево «Отдел продаж», как пикеры отчётов) — без бухгалтерии и прочих
  // (правка 23.11 после выкатки). РОП/директор — дополнительно в пределах своего среза.
  const [dir, salesDepts] = await Promise.all([getEmployeeDirectory(), getSalesDepartmentOptions()]);
  const sales = await resolveManagersForDepartments(salesDepts.map(d => d.id));
  const allowed = actor.canManage || actor.scope.kind === 'all' ? null : actor.scope.managerIds;
  const list: TrainingManagerOption[] = [];
  const seen = new Set<string>();
  for (const m of sales) {
    if (seen.has(m.managerId) || (allowed && !allowed.has(m.managerId))) continue;
    seen.add(m.managerId);
    const id = Number(m.managerId);
    if (!Number.isFinite(id)) continue;
    list.push({ id, name: dir.get(id)?.name ?? m.name, departmentName: dir.get(id)?.departmentName ?? null });
  }
  return list.filter(m => !/^User \d+$/.test(m.name)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// ── Запись событий (тренер) ────────────────────────────────────────────────

interface CleanInput {
  title?: string; description?: string; startAt?: Date; durationMin?: number;
  place?: string | null; capacity?: number | null; trainerId?: string | null;
  metricIds?: string[]; beforeDays?: number; afterDays?: number;
  slotId?: number | null; departmentLabel?: string | null;
}

/** Темы Задачника (неизвестные — ошибка, не тихий пропуск). Товарная группа, выбранная в форме (pg_<id>_<замер>),
 *  которой ещё нет среди тем, — заводится тут же (ensureTopicIds; тренеру конструктор тем не нужен). */
async function cleanMetricIds(raw: unknown, login: string): Promise<string[]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new TrainingError('Показатели — списком');
  const ids = [...new Set(raw.map(x => String(x).trim()).filter(Boolean))];
  if (ids.length > 10) throw new TrainingError('Не больше 10 показателей');
  if (!ids.length) return [];
  await ensureTopicIds(login, ids);
  // Служебная тема «Сделки» (289) — без замера, в обучения не годится.
  const known = new Set((await loadMetricDefs()).filter(m => m.kind !== 'deal').map(m => m.id));
  const bad = ids.filter(id => !known.has(id));
  if (bad.length) throw new TrainingError(`Показатель не из списка Задачника: ${bad.join(', ')}`);
  return ids;
}

function cleanDays(raw: unknown, what: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 7 || n > 90) throw new TrainingError(`Окно «${what}» — от 7 до 90 дней`);
  return n;
}

async function cleanInput(raw: unknown, partial: boolean, login: string): Promise<CleanInput> {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: CleanInput = {};
  if (!partial || b.title !== undefined) {
    const t = String(b.title ?? '').trim();
    if (!t) throw new TrainingError('Укажите тему');
    if (t.length > 200) throw new TrainingError('Тема длиннее 200 символов');
    out.title = t;
  }
  if (b.description !== undefined) {
    const d = String(b.description ?? '');
    if (d.length > 10000) throw new TrainingError('Описание слишком длинное');
    out.description = d;
  }
  if (!partial || b.startsAt !== undefined) {
    const d = new Date(String(b.startsAt ?? ''));
    if (Number.isNaN(d.getTime())) throw new TrainingError('Укажите дату и время начала');
    out.startAt = d;
  }
  if (!partial || b.durationMin !== undefined) {
    const n = Number(b.durationMin);
    if (!Number.isInteger(n) || n < 5 || n > 600) throw new TrainingError('Длительность — от 5 до 600 минут');
    out.durationMin = n;
  }
  if (b.place !== undefined) {
    const s = b.place == null ? '' : String(b.place).trim();
    if (s.length > 500) throw new TrainingError('Место/ссылка длиннее 500 символов');
    out.place = s || null;
  }
  if (b.capacity !== undefined) {
    if (b.capacity == null || b.capacity === '') out.capacity = null;
    else {
      const n = Number(b.capacity);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new TrainingError('Лимит мест — целое число от 1');
      out.capacity = n;
    }
  }
  if (b.trainerId !== undefined) {
    if (b.trainerId == null || b.trainerId === '') out.trainerId = null;
    else {
      const n = Number(b.trainerId);
      if (!Number.isInteger(n) || n <= 0) throw new TrainingError('Некорректный тренер');
      out.trainerId = String(n);
    }
  }
  if (b.metricIds !== undefined) out.metricIds = await cleanMetricIds(b.metricIds, login);
  if (b.slotId !== undefined) {
    const n = b.slotId == null || b.slotId === '' ? null : Number(b.slotId);
    if (n !== null && (!Number.isInteger(n) || n <= 0)) throw new TrainingError('Некорректный слот');
    out.slotId = n;
  }
  if (b.departmentLabel !== undefined) {
    const s = b.departmentLabel == null ? '' : String(b.departmentLabel).trim();
    out.departmentLabel = s ? s.slice(0, 80) : null;
  }
  if (b.measureBeforeDays !== undefined) out.beforeDays = cleanDays(b.measureBeforeDays, 'до');
  if (b.measureAfterDays !== undefined) out.afterDays = cleanDays(b.measureAfterDays, 'после');
  return out;
}

function requireManage(actor: TrainingActor) {
  if (!actor.canManage) throw new TrainingError('Вести расписание обучений может только тренер', 403);
}

export async function createEvent(actor: TrainingActor, raw: unknown): Promise<TrainingEvent> {
  requireManage(actor);
  const v = await cleanInput(raw, false, actor.session.login);
  const trainer = v.trainerId !== undefined ? v.trainerId : actor.session.bitrixUserId;
  const r = await systemDb().query<{ id: string }>(
    `INSERT INTO tasker_training_events (title, description, start_at, duration_min, place, capacity, trainer_bitrix_user_id, created_by,
                                         metric_ids, measure_before_days, measure_after_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [v.title, v.description ?? '', v.startAt, v.durationMin, v.place ?? null, v.capacity ?? null, trainer ?? null, actor.session.id,
      v.metricIds ?? [], v.beforeDays ?? DEFAULT_MEASURE_DAYS, v.afterDays ?? DEFAULT_MEASURE_DAYS],
  );
  const id = Number(r.rows[0].id);
  // Колонки 281 — отдельным UPDATE и только если заданы: без миграции создание события не ломается.
  if (v.slotId != null || v.departmentLabel != null) {
    await systemDb().query('UPDATE tasker_training_events SET slot_id = $2, department_label = $3 WHERE id = $1',
      [id, v.slotId ?? null, v.departmentLabel ?? null]);
  }
  await syncTrainingCalendar(id); // не бросает: сбой Битрикса = «не синхронизировано» + повтор
  return getEvent(actor, id);
}

export async function updateEvent(actor: TrainingActor, id: number, raw: unknown): Promise<TrainingEvent> {
  requireManage(actor);
  const v = await cleanInput(raw, true, actor.session.login);
  const cols: Record<string, unknown> = {
    title: v.title, description: v.description, start_at: v.startAt, duration_min: v.durationMin,
    place: v.place, capacity: v.capacity, trainer_bitrix_user_id: v.trainerId,
    metric_ids: v.metricIds, measure_before_days: v.beforeDays, measure_after_days: v.afterDays,
    slot_id: v.slotId, department_label: v.departmentLabel,
  };
  // Календарь Битрикса трогаем, только если поменялось то, что в нём видно.
  const calendarRelevant = [v.title, v.description, v.startAt, v.durationMin, v.place, v.trainerId].some(x => x !== undefined);
  const sets: string[] = [];
  const args: unknown[] = [id];
  for (const [k, val] of Object.entries(cols)) {
    if (val === undefined) continue;
    args.push(val);
    sets.push(`${k} = $${args.length}`);
  }
  const db = systemDb();
  const cur = await db.query<{ cancelled_at: Date | null; enrolled: string }>(
    `SELECT cancelled_at, (SELECT count(*) FROM tasker_training_enrollments WHERE event_id = $1) AS enrolled
       FROM tasker_training_events WHERE id = $1`, [id],
  );
  if (!cur.rows[0]) throw new TrainingError('Обучение не найдено', 404);
  if (cur.rows[0].cancelled_at) throw new TrainingError('Обучение отменено — правка недоступна', 409);
  if (v.capacity != null && v.capacity < Number(cur.rows[0].enrolled)) {
    throw new TrainingError(`Уже записано ${cur.rows[0].enrolled} — лимит не может быть меньше`, 409);
  }
  if (sets.length) {
    await db.query(
      `UPDATE tasker_training_events SET ${sets.join(', ')}${calendarRelevant ? `, calendar_sync_state = 'pending'` : ''}, updated_at = now() WHERE id = $1`,
      args,
    );
    // Сменили показатели или окна — старые замеры недействительны, пересчитаются.
    if (v.metricIds !== undefined || v.beforeDays !== undefined || v.afterDays !== undefined || v.startAt !== undefined) {
      await db.query('DELETE FROM tasker_training_results WHERE event_id = $1', [id]);
    }
    if (calendarRelevant) await syncTrainingCalendar(id);
  }
  return getEvent(actor, id);
}

/** DELETE = отмена: событие остаётся в истории, записи не удаляются. */
export async function cancelEvent(actor: TrainingActor, id: number): Promise<TrainingEvent> {
  requireManage(actor);
  const r = await systemDb().query(
    `UPDATE tasker_training_events SET cancelled_at = COALESCE(cancelled_at, now()), cancelled_by = COALESCE(cancelled_by, $2),
            calendar_sync_state = 'pending', updated_at = now()
      WHERE id = $1`,
    [id, actor.session.id],
  );
  if (!r.rowCount) throw new TrainingError('Обучение не найдено', 404);
  await syncTrainingCalendar(id);
  return getEvent(actor, id);
}

// ── Запись менеджеров (РОП/директор/админ/тренер) ──────────────────────────

function parseManagerId(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new TrainingError('Не указан менеджер');
  return String(n);
}

export interface EnrollGoal { goalMetricIds?: unknown; goalNote?: unknown }

export async function enroll(
  actor: TrainingActor, eventId: number, rawManagerId: unknown, rawTaskId?: unknown, goal: EnrollGoal = {},
): Promise<TrainingEvent> {
  if (!actor.canEnroll) throw new TrainingError('Записывать на обучения может РОП, директор или администратор', 403);
  const managerId = parseManagerId(rawManagerId);
  if (!canTouchManager(actor, managerId)) throw new TrainingError('Этот менеджер вам не подчиняется', 403);
  const taskId = rawTaskId == null || rawTaskId === '' ? null : Number(rawTaskId);
  if (taskId !== null && (!Number.isInteger(taskId) || taskId <= 0)) throw new TrainingError('Некорректная задача');
  const goalIds = goal.goalMetricIds === undefined ? null : await cleanMetricIds(goal.goalMetricIds, actor.session.login);
  const note = goal.goalNote == null ? null : String(goal.goalNote).trim().slice(0, 2000) || null;
  // Записали из задачи — её показатель и снимок становятся целью (если цель не задали явно).
  const task = taskId ? await taskGoal(taskId, managerId) : null;

  const client = await systemDb().connect();
  let changed = false;
  let logged: { action: 'enroll' | 'goal'; details: Record<string, unknown> } | null = null;
  try {
    await client.query('BEGIN');
    // Блокируем событие: две одновременные записи не перескочат лимит мест.
    const ev = await client.query<{ capacity: number | null; cancelled_at: Date | null; ended: boolean; metric_ids: string[] }>(
      `SELECT capacity, cancelled_at, (start_at + make_interval(mins => duration_min) <= now()) AS ended, metric_ids
         FROM tasker_training_events WHERE id = $1 FOR UPDATE`, [eventId],
    );
    const e = ev.rows[0];
    if (!e) throw new TrainingError('Обучение не найдено', 404);
    if (e.cancelled_at) throw new TrainingError('Обучение отменено', 409);
    if (e.ended) throw new TrainingError('Обучение уже прошло', 409);
    const exists = await client.query(
      'SELECT 1 FROM tasker_training_enrollments WHERE event_id = $1 AND manager_bitrix_user_id = $2', [eventId, managerId],
    );
    if (exists.rowCount) {
      // Повторная запись (например, из формы задачи) — не ошибка; привяжем задачу, если её ещё нет.
      if (taskId || goalIds !== null || note !== null) {
        await client.query(
          `UPDATE tasker_training_enrollments
              SET tasker_task_id = COALESCE(tasker_task_id, $3),
                  task_metric_id = COALESCE(task_metric_id, $4), task_snapshot = COALESCE(task_snapshot, $5::jsonb),
                  goal_metric_ids = COALESCE($6::text[], goal_metric_ids), goal_note = COALESCE($7, goal_note)
            WHERE event_id = $1 AND manager_bitrix_user_id = $2`,
          [eventId, managerId, taskId, task?.metricId ?? null, task?.snapshot ? JSON.stringify(task.snapshot) : null, goalIds, note],
        );
        logged = { action: 'goal', details: { goalMetricIds: goalIds, goalNote: note, taskId } };
      }
    } else {
      if (e.capacity != null) {
        const c = await client.query<{ n: string }>('SELECT count(*) AS n FROM tasker_training_enrollments WHERE event_id = $1', [eventId]);
        if (Number(c.rows[0].n) >= e.capacity) throw new TrainingError('Мест больше нет', 409);
      }
      const goals = goalIds ?? (e.metric_ids?.length ? e.metric_ids : task ? [task.metricId] : []);
      await client.query(
        `INSERT INTO tasker_training_enrollments
           (event_id, manager_bitrix_user_id, enrolled_by, tasker_task_id, goal_metric_ids, goal_note, task_metric_id, task_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [eventId, managerId, actor.session.id, taskId, goals, note ?? task?.note ?? null, task?.metricId ?? null,
          task?.snapshot ? JSON.stringify(task.snapshot) : null],
      );
      logged = { action: 'enroll', details: { goalMetricIds: goals, goalNote: note ?? task?.note ?? null, taskId } };
      await client.query(`UPDATE tasker_training_events SET calendar_sync_state = 'pending' WHERE id = $1`, [eventId]);
      changed = true;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (logged) await writeLog(systemDb(), { eventId, managerId, action: logged.action, actorUserId: actor.session.id, taskId, details: logged.details });
  if (changed) await syncTrainingCalendar(eventId); // менеджер → участник события в календаре тренера
  return getEvent(actor, eventId);
}

export async function unenroll(actor: TrainingActor, eventId: number, rawManagerId: unknown): Promise<TrainingEvent> {
  if (!actor.canEnroll) throw new TrainingError('Отписывать с обучений может РОП, директор или администратор', 403);
  const managerId = parseManagerId(rawManagerId);
  if (!canTouchManager(actor, managerId)) throw new TrainingError('Этот менеджер вам не подчиняется', 403);
  const del = await systemDb().query(
    'DELETE FROM tasker_training_enrollments WHERE event_id = $1 AND manager_bitrix_user_id = $2', [eventId, managerId],
  );
  if (del.rowCount) {
    await writeLog(systemDb(), { eventId, managerId, action: 'unenroll', actorUserId: actor.session.id });
    await systemDb().query('DELETE FROM tasker_training_results WHERE event_id = $1 AND manager_bitrix_user_id = $2', [eventId, managerId]);
    // Задача «Теория» этого менеджера отвязывается от занятия: снова в очереди тренера — со своим временем РОПа
    // (один на один) или ждёт группу. Иначе висела «назначена на занятие», с которого человека сняли.
    await systemDb().query(
      'UPDATE tasker_tasks SET training_event_id = NULL, updated_at = now() WHERE training_event_id = $1 AND manager_bitrix_id = $2',
      [eventId, managerId]).catch(e => console.warn('[tasker/trainings] отвязка задачи:', e instanceof Error ? e.message : e));
    await systemDb().query(`UPDATE tasker_training_events SET calendar_sync_state = 'pending' WHERE id = $1`, [eventId]);
    await syncTrainingCalendar(eventId);
  }
  return getEvent(actor, eventId);
}

/** Повтор синхронизации с календарём Битрикса вручную (кнопка тренера). */
export async function resyncCalendar(actor: TrainingActor, id: number): Promise<TrainingEvent> {
  requireManage(actor);
  const r = await systemDb().query('UPDATE tasker_training_events SET calendar_sync_attempts = 0 WHERE id = $1', [id]);
  if (!r.rowCount) throw new TrainingError('Обучение не найдено', 404);
  await syncTrainingCalendar(id);
  return getEvent(actor, id);
}

// ── Цель из задачи и посещаемость ─────────────────────────────────────────

/** Показатель и снимок задачи Задачника (ядро, 274) — цель записи «из формы задачи». */
export async function taskGoal(taskId: number, managerId: string): Promise<{ metricId: string; snapshot: Snapshot | null; note: string } | null> {
  const r = await systemDb().query<{ metric_id: string; snapshot: Snapshot | null; title: string; manager_bitrix_id: string }>(
    'SELECT metric_id, snapshot, title, manager_bitrix_id FROM tasker_tasks WHERE id = $1', [taskId],
  ).catch(() => ({ rows: [] as { metric_id: string; snapshot: Snapshot | null; title: string; manager_bitrix_id: string }[] }));
  const t = r.rows[0];
  if (!t || String(t.manager_bitrix_id) !== managerId) return null;
  return { metricId: t.metric_id, snapshot: t.snapshot && Object.keys(t.snapshot).length ? t.snapshot : null, note: `Задача: ${t.title}` };
}

/** Тренер отмечает «был / не был» (null — снять отметку). Только после начала события, не для отменённых. */
export async function setAttendance(actor: TrainingActor, eventId: number, rawManagerId: unknown, rawAttended: unknown): Promise<TrainingEvent> {
  requireManage(actor);
  const managerId = parseManagerId(rawManagerId);
  if (rawAttended !== null && typeof rawAttended !== 'boolean') throw new TrainingError('attended — true, false или null');
  const attended = rawAttended as boolean | null;
  const db = systemDb();
  const ev = await db.query<{ cancelled_at: Date | null; started: boolean }>(
    'SELECT cancelled_at, start_at <= now() AS started FROM tasker_training_events WHERE id = $1', [eventId],
  );
  if (!ev.rows[0]) throw new TrainingError('Обучение не найдено', 404);
  if (ev.rows[0].cancelled_at) throw new TrainingError('Обучение отменено', 409);
  if (!ev.rows[0].started) throw new TrainingError('Отмечать посещение можно после начала обучения', 409);
  const r = await db.query(
    `UPDATE tasker_training_enrollments
        SET attended = $3, attendance_marked_by = $4, attendance_marked_at = CASE WHEN $3::boolean IS NULL THEN NULL ELSE now() END
      WHERE event_id = $1 AND manager_bitrix_user_id = $2 AND attended IS DISTINCT FROM $3::boolean`,
    [eventId, managerId, attended, actor.session.id],
  );
  if (r.rowCount) {
    await writeLog(db, {
      eventId, managerId, actorUserId: actor.session.id,
      action: attended === null ? 'attendance_cleared' : attended ? 'attended' : 'absent',
    });
    if (attended !== true) await db.query('DELETE FROM tasker_training_results WHERE event_id = $1 AND manager_bitrix_user_id = $2', [eventId, managerId]);
  }
  return getEvent(actor, eventId);
}
