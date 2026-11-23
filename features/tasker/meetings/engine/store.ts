// Регулярные собрания Задачника — хранение, права, участники (TASKER_SPEC.md «Регулярные собрания»).
// Создают РОП / директор / админ (action.tasker.assign). Организатор — создатель; директор/админ может
// выбрать другого (своего РОПа). Участники — отделы целиком (uuid sa.departments, с поддеревом) и/или люди.
// Видимость: админ — всё; иначе собрание видно создателю, организатору и тем, у кого в зоне есть хоть один
// участник (руководители участников; менеджер — если участник сам).
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { canSeeDept, canSeeManager, type SessionScope } from '@/lib/org/sessionScope';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { loadDepartments } from '@/lib/org/deptCategories';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { getEmployeeDirectory } from '@/lib/org/employeeDirectory';
import type {
  TaskerMeeting, TaskerMeetingInput, TaskerMeetingOccurrence, TaskerPerson, TaskerRecurrence,
} from '../../types';
import { TaskerError, mskToday } from '../../engine/config';
import { expandDates, nextDates, normalizeRecurrence, occurrenceStart, recurrenceLabel, toBitrixRrule } from './recurrence';

export interface MeetingRow {
  id: string; title: string; agenda: string; organizer_bitrix_id: string; start_date: string; start_time: string;
  duration_min: number; recurrence: TaskerRecurrence['kind']; weekdays: number[]; month_day: number | null;
  month_nth: number | null; month_weekday: number | null; until_date: string | null; place: string | null;
  dept_ids: string[]; person_ids: string[]; created_by: string | null; created_by_name: string | null;
  cancelled_at: Date | null; calendar_mode: 'rrule' | 'rolling'; calendar_event_id: string | null;
  calendar_owner_id: string | null; calendar_occ_date: string | null; calendar_sync_state: 'pending' | 'synced' | 'failed';
  calendar_sync_error: string | null; cancelled_dates: string[] | null;
}

export const MEETING_SELECT = `SELECT m.*, m.start_date::text AS start_date, to_char(m.start_time, 'HH24:MI') AS start_time,
  m.until_date::text AS until_date, m.calendar_occ_date::text AS calendar_occ_date,
  (SELECT array_agg(x.occ_date::text ORDER BY x.occ_date) FROM tasker_meeting_exceptions x WHERE x.meeting_id = m.id) AS cancelled_dates
  FROM tasker_meetings m`;

export function recurrenceOf(r: Pick<MeetingRow, 'recurrence' | 'weekdays' | 'month_day' | 'month_nth' | 'month_weekday'>): TaskerRecurrence {
  switch (r.recurrence) {
    case 'weekdays': return { kind: 'weekdays' };
    case 'weekly': return { kind: 'weekly', days: r.weekdays ?? [] };
    case 'biweekly': return { kind: 'biweekly', days: r.weekdays ?? [] };
    case 'monthly_day': return { kind: 'monthly_day', day: r.month_day ?? 1 };
    case 'monthly_nth': return { kind: 'monthly_nth', nth: (r.month_nth ?? 1) as 1 | 2 | 3 | 4 | -1, weekday: r.month_weekday ?? 1 };
  }
}

export const seriesOf = (r: MeetingRow) => ({ startDate: r.start_date, untilDate: r.until_date, recurrence: recurrenceOf(r) });

/** Участники серии: люди отделов (с поддеревом) + отдельные люди, без организатора. Bitrix ID → имя. */
export async function participantsOf(r: Pick<MeetingRow, 'dept_ids' | 'person_ids' | 'organizer_bitrix_id'>, memo?: Map<string, Promise<{ managerId: string; name: string }[]>>): Promise<TaskerPerson[]> {
  const key = [...(r.dept_ids ?? [])].sort().join(',');
  let deptPeople: Promise<{ managerId: string; name: string }[]>;
  if (!key) deptPeople = Promise.resolve([]);
  else if (memo?.has(key)) deptPeople = memo.get(key)!;
  else {
    deptPeople = resolveManagersForDepartments(r.dept_ids);
    memo?.set(key, deptPeople);
  }
  const [fromDepts, dir] = await Promise.all([deptPeople, getEmployeeDirectory()]);
  const out = new Map<string, string>();
  for (const m of fromDepts) out.set(String(m.managerId), m.name);
  for (const id of r.person_ids ?? []) if (!out.has(id)) out.set(id, dir.get(Number(id))?.name ?? `#${id}`);
  out.delete(String(r.organizer_bitrix_id));
  return [...out].map(([id, name]) => ({ id: Number(id), name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// ── права ───────────────────────────────────────────────────────────────────

export const canPickOrganizer = (session: SessionUser) => hasFullManagerAccess(session) || session.roleName === 'Директор';

function canSeeMeeting(session: SessionUser, scope: SessionScope, r: MeetingRow, participants: TaskerPerson[]): boolean {
  if (scope.kind === 'all') return true;
  const me = session.bitrixUserId ? String(session.bitrixUserId) : null;
  if (r.created_by === session.id || (me && r.organizer_bitrix_id === me)) return true;
  if (canSeeManager(scope, r.organizer_bitrix_id)) return true;
  return participants.some(p => canSeeManager(scope, String(p.id)) || (me !== null && String(p.id) === me));
}

export function canEditMeeting(session: SessionUser, scope: SessionScope, r: Pick<MeetingRow, 'created_by' | 'organizer_bitrix_id'>): boolean {
  if (!hasPerm(session, 'action.tasker.assign')) return false;
  if (scope.kind === 'all') return true;
  const me = session.bitrixUserId ? String(session.bitrixUserId) : null;
  return r.created_by === session.id || (!!me && r.organizer_bitrix_id === me) || canSeeManager(scope, r.organizer_bitrix_id);
}

// ── чтение ──────────────────────────────────────────────────────────────────

async function mapMeeting(r: MeetingRow, participants: TaskerPerson[], canEdit: boolean): Promise<TaskerMeeting> {
  const [{ byId }, dir] = await Promise.all([loadDepartments(), getEmployeeDirectory()]);
  const rec = recurrenceOf(r);
  const cancelled = new Set(r.cancelled_dates ?? []);
  const upcoming = r.cancelled_at ? [] : nextDates(seriesOf(r), mskToday(), 8).map(d => ({
    date: d, startsAt: occurrenceStart(d, r.start_time), cancelled: cancelled.has(d),
  }));
  return {
    id: Number(r.id),
    title: r.title,
    agenda: r.agenda,
    organizer: { id: Number(r.organizer_bitrix_id), name: dir.get(Number(r.organizer_bitrix_id))?.name ?? `#${r.organizer_bitrix_id}` },
    startDate: r.start_date,
    startTime: r.start_time,
    durationMin: r.duration_min,
    recurrence: rec,
    recurrenceLabel: recurrenceLabel(rec, r.start_time),
    untilDate: r.until_date,
    place: r.place,
    departments: (r.dept_ids ?? []).map(id => ({ id, name: byId.get(id)?.name ?? 'Отдел' })),
    people: (r.person_ids ?? []).map(id => ({ id: Number(id), name: dir.get(Number(id))?.name ?? `#${id}` })),
    participants,
    cancelledDates: r.cancelled_dates ?? [],
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
    upcoming,
    calendar: {
      state: r.calendar_sync_state, error: r.calendar_sync_error,
      eventId: r.calendar_event_id ? Number(r.calendar_event_id) : null, mode: r.calendar_mode,
    },
    canEdit,
    createdBy: r.created_by_name,
  };
}

export async function listMeetings(
  session: SessionUser, scope: SessionScope, opts: { from?: string | null; to?: string | null; includeCancelled?: boolean; managerId?: number | null } = {},
): Promise<{ meetings: TaskerMeeting[]; occurrences: TaskerMeetingOccurrence[] }> {
  const r = await systemDb().query<MeetingRow>(
    `${MEETING_SELECT} WHERE ($1 OR m.cancelled_at IS NULL) ORDER BY m.start_time, m.id LIMIT 500`, [!!opts.includeCancelled]);
  const memo = new Map<string, Promise<{ managerId: string; name: string }[]>>();
  const visible: { row: MeetingRow; participants: TaskerPerson[] }[] = [];
  for (const row of r.rows) {
    const participants = await participantsOf(row, memo);
    if (!canSeeMeeting(session, scope, row, participants)) continue;
    if (opts.managerId && String(opts.managerId) !== row.organizer_bitrix_id && !participants.some(p => p.id === opts.managerId)) continue;
    visible.push({ row, participants });
  }
  const meetings = await Promise.all(visible.map(v => mapMeeting(v.row, v.participants, canEditMeeting(session, scope, v.row))));
  const occurrences: TaskerMeetingOccurrence[] = [];
  if (opts.from && opts.to) {
    for (const [i, v] of visible.entries()) {
      if (v.row.cancelled_at) continue;
      const m = meetings[i];
      const cancelled = new Set(m.cancelledDates);
      for (const d of expandDates(seriesOf(v.row), opts.from, opts.to)) {
        occurrences.push({
          meetingId: m.id, date: d, startsAt: occurrenceStart(d, m.startTime), durationMin: m.durationMin, title: m.title,
          place: m.place, organizer: m.organizer, participantsCount: m.participants.length, recurrenceLabel: m.recurrenceLabel,
          cancelled: cancelled.has(d),
        });
      }
    }
    occurrences.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }
  return { meetings, occurrences };
}

export async function getMeetingRow(id: number): Promise<MeetingRow | null> {
  const r = await systemDb().query<MeetingRow>(`${MEETING_SELECT} WHERE m.id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function getMeeting(session: SessionUser, scope: SessionScope, id: number): Promise<TaskerMeeting> {
  const row = await getMeetingRow(id);
  if (!row) throw new TaskerError('Собрание не найдено', 'forbidden', 404);
  const participants = await participantsOf(row);
  if (!canSeeMeeting(session, scope, row, participants)) throw new TaskerError('Собрание не найдено', 'forbidden', 404);
  return mapMeeting(row, participants, canEditMeeting(session, scope, row));
}

// ── запись ──────────────────────────────────────────────────────────────────

const isYmd = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isHm = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

interface Normalized {
  title: string; agenda: string; organizer: string; startDate: string; startTime: string; durationMin: number;
  recurrence: TaskerRecurrence; untilDate: string | null; place: string | null; deptIds: string[]; personIds: string[];
}

function normalize(session: SessionUser, scope: SessionScope, raw: unknown, prev?: MeetingRow): Normalized {
  const b = (raw ?? {}) as Partial<TaskerMeetingInput>;
  const pick = <K extends keyof TaskerMeetingInput>(k: K) => (k in b ? b[k] : undefined);
  const title = String(pick('title') ?? prev?.title ?? '').trim().slice(0, 200);
  if (!title) throw new TaskerError('Нужно название собрания');
  const agenda = String(pick('agenda') ?? prev?.agenda ?? '').slice(0, 10_000);
  const startDate = pick('startDate') ?? prev?.start_date;
  if (!isYmd(startDate)) throw new TaskerError('Некорректная дата начала');
  const startTime = pick('startTime') ?? prev?.start_time;
  if (!isHm(startTime)) throw new TaskerError('Время начала — в формате ЧЧ:ММ');
  const durationMin = Math.round(Number(pick('durationMin') ?? prev?.duration_min ?? 30));
  if (!Number.isFinite(durationMin) || durationMin < 5 || durationMin > 480) throw new TaskerError('Длительность — от 5 минут до 8 часов');
  let recurrence: TaskerRecurrence;
  try { recurrence = normalizeRecurrence(pick('recurrence') ?? (prev ? recurrenceOf(prev) : null)); }
  catch (e) { throw new TaskerError(e instanceof Error ? e.message : 'Некорректный повтор'); }
  const untilRaw = 'untilDate' in b ? b.untilDate : prev?.until_date ?? null;
  const untilDate = untilRaw ? String(untilRaw) : null;
  if (untilDate !== null && (!isYmd(untilDate) || untilDate < startDate)) throw new TaskerError('Дата окончания — не раньше даты начала');
  const placeRaw = 'place' in b ? b.place : prev?.place ?? null;
  const place = placeRaw ? String(placeRaw).trim().slice(0, 500) || null : null;

  const me = session.bitrixUserId ? String(session.bitrixUserId) : null;
  const orgRaw = b.organizerId ? String(b.organizerId) : prev?.organizer_bitrix_id ?? me;
  if (!orgRaw) throw new TaskerError('Не выбран организатор: у вашей учётной записи нет Bitrix ID');
  if (orgRaw !== me && orgRaw !== prev?.organizer_bitrix_id) {
    if (!canPickOrganizer(session)) throw new TaskerError('Организатором может быть только создатель (выбрать другого может директор или администратор)', 'forbidden', 403);
    if (!canSeeManager(scope, orgRaw)) throw new TaskerError('Организатор не в вашей зоне', 'forbidden', 403);
  }

  const deptIds = [...new Set(('departmentIds' in b ? b.departmentIds ?? [] : prev?.dept_ids ?? []).map(String))].slice(0, 50);
  const personIds = [...new Set(('personIds' in b ? b.personIds ?? [] : prev?.person_ids ?? []).map(String))].filter(x => /^\d+$/.test(x)).slice(0, 300);
  for (const d of deptIds) {
    if (prev?.dept_ids?.includes(d)) continue;
    if (!canSeeDept(scope, d)) throw new TaskerError('Один из отделов не в вашей зоне', 'forbidden', 403);
  }
  for (const p of personIds) {
    if (prev?.person_ids?.includes(p)) continue;
    if (!canSeeManager(scope, p)) throw new TaskerError(`Сотрудник #${p} не в вашей зоне`, 'forbidden', 403);
  }
  if (!deptIds.length && !personIds.length) throw new TaskerError('Добавьте участников: отдел или людей');
  return { title, agenda, organizer: orgRaw, startDate, startTime, durationMin, recurrence, untilDate, place, deptIds, personIds };
}

function recurrenceCols(r: TaskerRecurrence) {
  return {
    recurrence: r.kind,
    weekdays: r.kind === 'weekly' || r.kind === 'biweekly' ? r.days : [],
    month_day: r.kind === 'monthly_day' ? r.day : null,
    month_nth: r.kind === 'monthly_nth' ? r.nth : null,
    month_weekday: r.kind === 'monthly_nth' ? r.weekday : null,
  };
}

export async function createMeeting(session: SessionUser, scope: SessionScope, raw: unknown): Promise<number> {
  if (!hasPerm(session, 'action.tasker.assign')) throw new TaskerError('Создавать собрания может РОП, директор или администратор', 'forbidden', 403);
  const n = normalize(session, scope, raw);
  const rc = recurrenceCols(n.recurrence);
  const r = await systemDb().query<{ id: string }>(
    `INSERT INTO tasker_meetings (title, agenda, organizer_bitrix_id, start_date, start_time, duration_min, recurrence, weekdays,
        month_day, month_nth, month_weekday, until_date, place, dept_ids, person_ids, created_by, created_by_name, calendar_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [n.title, n.agenda, n.organizer, n.startDate, n.startTime, n.durationMin, rc.recurrence, rc.weekdays, rc.month_day, rc.month_nth,
      rc.month_weekday, n.untilDate, n.place, n.deptIds, n.personIds, session.id, session.displayName,
      toBitrixRrule(n.recurrence, n.untilDate) ? 'rrule' : 'rolling'],
  );
  return Number(r.rows[0].id);
}

export async function updateMeeting(session: SessionUser, scope: SessionScope, id: number, raw: unknown): Promise<void> {
  const prev = await getMeetingRow(id);
  if (!prev || prev.cancelled_at) throw new TaskerError('Собрание не найдено или отменено', 'forbidden', 404);
  if (!canEditMeeting(session, scope, prev)) throw new TaskerError('Править собрание может его создатель, организатор или их руководитель', 'forbidden', 403);
  const n = normalize(session, scope, raw, prev);
  const rc = recurrenceCols(n.recurrence);
  await systemDb().query(
    `UPDATE tasker_meetings SET title=$2, agenda=$3, organizer_bitrix_id=$4, start_date=$5, start_time=$6, duration_min=$7, recurrence=$8,
        weekdays=$9, month_day=$10, month_nth=$11, month_weekday=$12, until_date=$13, place=$14, dept_ids=$15, person_ids=$16,
        calendar_mode=$17, calendar_sync_state='pending', calendar_sync_attempts=0, updated_at=now()
      WHERE id=$1`,
    [id, n.title, n.agenda, n.organizer, n.startDate, n.startTime, n.durationMin, rc.recurrence, rc.weekdays, rc.month_day, rc.month_nth,
      rc.month_weekday, n.untilDate, n.place, n.deptIds, n.personIds, toBitrixRrule(n.recurrence, n.untilDate) ? 'rrule' : 'rolling'],
  );
}

export async function cancelMeeting(session: SessionUser, scope: SessionScope, id: number): Promise<void> {
  const prev = await getMeetingRow(id);
  if (!prev) throw new TaskerError('Собрание не найдено', 'forbidden', 404);
  if (!canEditMeeting(session, scope, prev)) throw new TaskerError('Отменить собрание может его создатель, организатор или их руководитель', 'forbidden', 403);
  await systemDb().query(
    `UPDATE tasker_meetings SET cancelled_at = COALESCE(cancelled_at, now()), calendar_sync_state = 'pending', calendar_sync_attempts = 0, updated_at = now() WHERE id = $1`, [id]);
}

/** Отменить / вернуть одно вхождение (в Битрикс не уходит: EXDATE через REST не принимается). */
export async function setOccurrence(session: SessionUser, scope: SessionScope, id: number, date: unknown, cancelled: boolean): Promise<void> {
  const prev = await getMeetingRow(id);
  if (!prev || prev.cancelled_at) throw new TaskerError('Собрание не найдено или отменено', 'forbidden', 404);
  if (!canEditMeeting(session, scope, prev)) throw new TaskerError('Отменять встречи может создатель, организатор или их руководитель', 'forbidden', 403);
  if (!isYmd(date) || !expandDates(seriesOf(prev), date, date).length) throw new TaskerError('В этот день собрания нет');
  if (cancelled) {
    await systemDb().query(`INSERT INTO tasker_meeting_exceptions (meeting_id, occ_date, cancelled_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, date, session.displayName]);
  } else {
    await systemDb().query(`DELETE FROM tasker_meeting_exceptions WHERE meeting_id = $1 AND occ_date = $2`, [id, date]);
  }
  // Скользящее событие учитывает отмены (переедет на следующее вхождение) — пересинхронизировать.
  if (prev.calendar_mode === 'rolling') {
    await systemDb().query(`UPDATE tasker_meetings SET calendar_sync_state = 'pending', calendar_sync_attempts = 0 WHERE id = $1`, [id]);
  }
}
