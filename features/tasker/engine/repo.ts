// Чтение задач и сессий Задачника из system БД + сведение со живыми статусами Битрикса.
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import type { SessionScope } from '@/lib/org/sessionScope';
import { hasPerm } from '@/lib/auth/perms';
import type {
  Snapshot, TaskerChecklistItem, TaskerSession, TaskerStatus, TaskerSyncState, TaskerTask, TaskerTaskKind, TaskerTasksQuery, TaskerVerdict,
} from '../types';
import { bitrixTaskUrl, loadMetricDefs, loadSettings, mskToday, type TaskerMetricDef } from './config';
import { loadLiveTasks } from './live';

export interface TaskRow {
  id: string; bitrix_task_id: string | null; marker: string;
  manager_bitrix_id: string; manager_name: string | null; rop_bitrix_id: string | null; rop_name: string | null;
  director_bitrix_id: string | null; director_name: string | null; creator_bitrix_id: string | null;
  creator_user_id: string | null; creator_name: string | null; dept_name: string | null;
  metric_id: string; period_from: string; period_to: string; snapshot: Snapshot; target: string | null;
  template_id: number | null; title: string; body: string; deadline: Date; duration_min: number;
  slot_start: Date | null; slot_end: Date | null; control_date: string; bitrix_status: number | null; closed_at: Date | null;
  verdict: TaskerVerdict | null; measured_value: string | null; measured_at: Date | null;
  session_id: string | null; training_event_id: string | null; checklist: TaskerChecklistItem[];
  sync_state: TaskerSyncState; sync_error: string | null; created_at: Date; updated_at: Date;
  // 279
  kind: TaskerTaskKind | null; assignee_bitrix_id: string | null; assignee_name: string | null; auditor_ids: string[] | null;
  done_note: string | null; done_at: Date | null; done_by: string | null;
  calendar_event_id: string | null; calendar_owner_id: string | null;
}

/** Кто смотрит (для canChangeStatus): Bitrix ID и право «ставить задачи». */
export interface TaskViewer { bitrixId: string | null; userId: string; canManage: boolean }

export function viewerOf(session: SessionUser): TaskViewer {
  return { bitrixId: session.bitrixUserId ? String(session.bitrixUserId) : null, userId: session.id, canManage: hasPerm(session, 'action.tasker.assign') };
}

/** Менять статус/завершать: исполнитель — всегда; с правом «ставить задачи» — постановщик (кто нажал / от чьего
 *  имени), РОП и директор менеджера. Менеджер — объект задачи — только смотрит (правка 23.11). */
export function canChangeStatusOf(r: TaskRow, v: TaskViewer): boolean {
  if (v.bitrixId && r.assignee_bitrix_id === v.bitrixId) return true;
  if (!v.canManage) return false;
  if (r.creator_user_id === v.userId) return true;
  return !!v.bitrixId && v.bitrixId !== r.manager_bitrix_id
    && (r.creator_bitrix_id === v.bitrixId || r.rop_bitrix_id === v.bitrixId || r.director_bitrix_id === v.bitrixId);
}

// Даты как текст — без сдвига часового пояса при чтении date-колонок.
export const TASK_COLUMNS = `t.*, t.period_from::text AS period_from, t.period_to::text AS period_to, t.control_date::text AS control_date`;

const OPEN_BITRIX = 'COALESCE(t.bitrix_status, 2) NOT IN (5, 7)';
/** Задача «открыта» для лимитов: не отменена, не закрыта в Битриксе, без вердикта. */
export const OPEN_TASK_SQL = `t.cancelled_at IS NULL AND t.verdict IS NULL AND ${OPEN_BITRIX}`;

export function deriveStatus(bitrixStatus: number | null, verdict: TaskerVerdict | null, controlDate: string, today = mskToday()): TaskerStatus {
  if (verdict) return 'result';
  const s = bitrixStatus ?? 2;
  // 4 «ждёт контроля» — только у старых задач (до TASK_CONTROL='N'): исполнитель уже сдал — считаем завершённой.
  if (s === 5 || s === 7 || s === 4) return controlDate > today ? 'measuring' : 'done';
  if (s === 3) return 'in_progress';
  return 'new';
}

const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const isoOf = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export function mapTask(
  r: TaskRow, metrics: Map<string, TaskerMetricDef>, groupId: number | null,
  live?: { at: number; byId: Map<number, { status: number; closedDate: string | null }> } | null, viewer?: TaskViewer | null,
): TaskerTask {
  const m = metrics.get(r.metric_id);
  const bxId = num(r.bitrix_task_id);
  const lv = bxId && live ? live.byId.get(bxId) : undefined;
  // Строка, изменённая из Монолитики после снимка Битрикса, — свежее снимка.
  const useLive = lv && new Date(r.updated_at).getTime() <= live!.at;
  const bitrixStatus = useLive ? lv!.status : r.bitrix_status;
  const closedAt = useLive ? lv!.closedDate : isoOf(r.closed_at);
  return {
    id: Number(r.id),
    bitrixTaskId: bxId,
    bitrixUrl: bxId ? bitrixTaskUrl(bxId, groupId) : null,
    syncState: r.sync_state,
    syncError: r.sync_error,
    title: r.title,
    body: r.body,
    kind: r.kind ?? null,
    assignee: r.assignee_bitrix_id ? { id: Number(r.assignee_bitrix_id), name: r.assignee_name ?? `#${r.assignee_bitrix_id}` } : null,
    manager: { id: Number(r.manager_bitrix_id), name: r.manager_name ?? `#${r.manager_bitrix_id}` },
    rop: r.rop_bitrix_id ? { id: Number(r.rop_bitrix_id), name: r.rop_name ?? `#${r.rop_bitrix_id}` } : null,
    director: r.director_bitrix_id ? { id: Number(r.director_bitrix_id), name: r.director_name ?? `#${r.director_bitrix_id}` } : null,
    creator: { id: Number(r.creator_bitrix_id ?? 0), name: r.creator_name ?? '—' },
    departmentName: r.dept_name,
    metricId: r.metric_id,
    metricLabel: m?.label ?? r.metric_id,
    metricGroup: m?.group ?? 'conversion',
    higherIsBetter: m?.higherIsBetter ?? true,
    format: m?.format ?? 'number',
    period: { from: r.period_from, to: r.period_to },
    snapshot: r.snapshot,
    target: num(r.target),
    templateId: r.template_id,
    deadline: new Date(r.deadline).toISOString(),
    durationMin: r.duration_min,
    slotStart: isoOf(r.slot_start),
    slotEnd: isoOf(r.slot_end),
    controlDate: r.control_date,
    status: deriveStatus(bitrixStatus, r.verdict, r.control_date),
    bitrixStatus: bitrixStatus ?? null,
    closedAt,
    doneNote: r.done_note ?? null,
    doneAt: isoOf(r.done_at),
    doneBy: r.done_by ?? null,
    canChangeStatus: !r.verdict && !!viewer && canChangeStatusOf(r, viewer),
    verdict: r.verdict,
    measuredValue: num(r.measured_value),
    measuredAt: r.verdict ? isoOf(r.measured_at) : null,
    sessionId: num(r.session_id),
    trainingEventId: num(r.training_event_id),
    checklist: r.checklist ?? [],
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** SQL-условие видимости: свой срез менеджеров (менеджер видит задачи про себя — на чтение) + то, что поставил
 *  сам / где исполнитель (РОП, тренер) / РОП / директор / наблюдатель (AUDITORS). */
function visibilitySql(scope: SessionScope, session: SessionUser, params: unknown[]): string {
  if (scope.kind === 'all') return 'TRUE';
  params.push([...scope.managerIds]);
  const a = `t.manager_bitrix_id = ANY($${params.length}::text[])`;
  params.push(session.id);
  const b = `t.creator_user_id = $${params.length}`;
  if (!session.bitrixUserId) return `(${a} OR ${b})`;
  params.push(session.bitrixUserId);
  const me = `$${params.length}`;
  return `(${a} OR ${b} OR t.manager_bitrix_id = ${me} OR t.rop_bitrix_id = ${me} OR t.director_bitrix_id = ${me}
    OR t.assignee_bitrix_id = ${me} OR t.creator_bitrix_id = ${me} OR ${me} = ANY(t.auditor_ids))`;
}

export async function listTasks(session: SessionUser, scope: SessionScope, q: TaskerTasksQuery & { ids?: number[] }): Promise<TaskerTask[]> {
  const params: unknown[] = [];
  const where = ['t.cancelled_at IS NULL', visibilitySql(scope, session, params)];
  if (q.ids?.length) { params.push(q.ids); where.push(`t.id = ANY($${params.length}::bigint[])`); }
  if (q.managerId) { params.push(String(q.managerId)); where.push(`t.manager_bitrix_id = $${params.length}`); }
  if (q.ropId) { params.push(String(q.ropId)); where.push(`t.rop_bitrix_id = $${params.length}`); }
  if (q.metricId) { params.push(q.metricId); where.push(`t.metric_id = $${params.length}`); }
  if (q.mine === 'created') { params.push(session.id); where.push(`t.creator_user_id = $${params.length}`); }
  if (q.mine === 'watch') {
    params.push(session.bitrixUserId ?? '-');
    where.push(`(t.director_bitrix_id = $${params.length} OR t.rop_bitrix_id = $${params.length} OR t.assignee_bitrix_id = $${params.length} OR $${params.length} = ANY(t.auditor_ids))`);
  }
  // Окно для «Недели»/«Сегодня»: задача попадает, если слот, срок или дата замера — в окне,
  // либо (для «Сегодня») она просрочена и ещё открыта.
  if (q.from || q.to) {
    params.push(q.from ?? '1970-01-01'); const f = `$${params.length}::date`;
    params.push(q.to ?? '2999-12-31'); const t = `$${params.length}::date`;
    const inWin = (col: string) => `((${col} AT TIME ZONE 'Europe/Moscow')::date BETWEEN ${f} AND ${t})`;
    const overdue = q.view === 'today' ? ` OR (${OPEN_TASK_SQL} AND (t.deadline AT TIME ZONE 'Europe/Moscow')::date < ${f})` : '';
    where.push(`(${inWin('t.slot_start')} OR ${inWin('t.deadline')} OR (t.control_date BETWEEN ${f} AND ${t})${overdue})`);
  } else if (q.view === 'board') {
    // Доска: всё открытое + итоги за последние 60 дней.
    where.push(`(t.verdict IS NULL OR t.measured_at > now() - interval '60 days')`);
  }
  const r = await systemDb().query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM tasker_tasks t WHERE ${where.join(' AND ')} ORDER BY t.deadline, t.id LIMIT 2000`, params,
  );
  const [settings, metrics] = await Promise.all([loadSettings(), loadMetricDefs()]);
  const mm = new Map(metrics.map(m => [m.id, m]));
  const live = r.rows.some(x => x.bitrix_task_id) ? await loadLiveTasks(settings.groupId) : null;
  const viewer = viewerOf(session);
  return r.rows.map(x => mapTask(x, mm, settings.groupId, live, viewer));
}

export async function getTaskRow(id: number): Promise<TaskRow | null> {
  const r = await systemDb().query<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasker_tasks t WHERE t.id = $1 AND t.cancelled_at IS NULL`, [id]);
  return r.rows[0] ?? null;
}

export async function getTask(id: number, viewer?: TaskViewer | null): Promise<TaskerTask | null> {
  const row = await getTaskRow(id);
  if (!row) return null;
  const [settings, metrics] = await Promise.all([loadSettings(), loadMetricDefs()]);
  return mapTask(row, new Map(metrics.map(m => [m.id, m])), settings.groupId, null, viewer);
}

// ── Сессии ──────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string; rop_bitrix_id: string; metric_id: string; slot_start: Date; duration_min: number; calendar_event_id: string | null;
  task_ids: string[] | null; managers: { id: string; name: string | null }[] | null; rop_name: string | null;
}

export async function listSessions(
  session: SessionUser, scope: SessionScope,
  q: { ropId?: number | null; metricId?: string | null; from?: string | null; to?: string | null; ids?: number[] },
): Promise<TaskerSession[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.ids) { params.push(q.ids); where.push(`s.id = ANY($${params.length}::bigint[])`); }
  if (q.ropId) { params.push(String(q.ropId)); where.push(`s.rop_bitrix_id = $${params.length}`); }
  if (q.metricId) { params.push(q.metricId); where.push(`s.metric_id = $${params.length}`); }
  if (q.from) { params.push(q.from); where.push(`(s.slot_start AT TIME ZONE 'Europe/Moscow')::date >= $${params.length}::date`); }
  if (q.to) { params.push(q.to); where.push(`(s.slot_start AT TIME ZONE 'Europe/Moscow')::date <= $${params.length}::date`); }
  // Видимость: сессия видна, если видна хоть одна её задача или ты её РОП/создатель.
  const vis = scope.kind === 'all' ? 'TRUE' : (() => {
    params.push([...scope.managerIds]);
    const a = `EXISTS (SELECT 1 FROM tasker_tasks v WHERE v.session_id = s.id AND v.cancelled_at IS NULL AND v.manager_bitrix_id = ANY($${params.length}::text[]))`;
    params.push(session.bitrixUserId ?? '-'); const me = `$${params.length}`;
    params.push(session.id); const uid = `$${params.length}`;
    return `(${a} OR s.rop_bitrix_id = ${me} OR s.created_by = ${uid})`;
  })();
  where.push(vis);
  const r = await systemDb().query<SessionRow>(
    `SELECT s.id, s.rop_bitrix_id, s.metric_id, s.slot_start, s.duration_min, s.calendar_event_id,
            (SELECT max(t.rop_name) FROM tasker_tasks t WHERE t.session_id = s.id AND t.rop_bitrix_id = s.rop_bitrix_id) AS rop_name,
            (SELECT array_agg(t.id ORDER BY t.id) FROM tasker_tasks t WHERE t.session_id = s.id AND t.cancelled_at IS NULL) AS task_ids,
            (SELECT json_agg(DISTINCT jsonb_build_object('id', t.manager_bitrix_id, 'name', t.manager_name))
               FROM tasker_tasks t WHERE t.session_id = s.id AND t.cancelled_at IS NULL) AS managers
       FROM tasker_sessions s WHERE ${where.join(' AND ')} ORDER BY s.slot_start LIMIT 500`, params,
  );
  const metrics = new Map((await loadMetricDefs()).map(m => [m.id, m]));
  return r.rows.map(s => ({
    id: Number(s.id),
    rop: { id: Number(s.rop_bitrix_id), name: s.rop_name ?? `#${s.rop_bitrix_id}` },
    metricId: s.metric_id,
    metricLabel: metrics.get(s.metric_id)?.label ?? s.metric_id,
    slotStart: new Date(s.slot_start).toISOString(),
    durationMin: s.duration_min,
    calendarEventId: num(s.calendar_event_id),
    taskIds: (s.task_ids ?? []).map(Number),
    managers: (s.managers ?? []).map(x => ({ id: Number(x.id), name: x.name ?? `#${x.id}` })),
  }));
}
