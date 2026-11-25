// «Большой брат» — рейтинг РОПов: загрузка источников и склейка в единый список задач РОПов.
//
// Источники (BIG_BROTHER_SPEC.md, «Источники»):
//  - Задачник: tasker_tasks (system) — creator_bitrix_id ставит задачу менеджеру manager_bitrix_id. Исполнитель в Битриксе
//    с миграции 279 — РОП/тренер, адресат — менеджер, поэтому «кому» берём из manager_bitrix_id.
//  - Канбан повторки: repeat_kanban_events (system) — ручные постановки задач (actor_bitrix_id → manager_id).
//  - Битрикс: sa.bitrix_task_current — задачи в группах трёх сервисов (Задачник — tasker_settings.group_id, большие —
//    BIG_DEALS_GROUP_IDS, повторка — REPEAT_PROJECT_GROUP_ID), поставленные РОПом руками (created_by). Задача, которую
//    уже знаем по журналу Монолитики (bitrix_task_id / task_id), второй раз не считается — via = 'mono'.
// Статус/закрытие/срок — из sa.bitrix_task_current (копия Roan, лаг ≤ 5 мин), у Задачника — фолбэк на свои поля.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadAccountLogins } from '@/features/reports/engine/byManagers';
import { loadSettings } from '@/features/tasker/engine/config';
import { BIG_DEALS_GROUP_IDS } from '@/features/big-deals-kanban/engine/config';
import { REPEAT_PROJECT_GROUP_ID } from '@/features/repeat-kanban/engine/config';
import type { RopService, RopTask } from './types';

export interface OrgPerson {
  id: string; name: string; deptName: string | null; ropId: string | null; ropName: string | null;
  shortLogin: string | null; branch: string | null;
}

/** Оргструктура: действующие сотрудники. ВНИМАНИЕ: sa.org_resolved_hierarchy — только текущее состояние (истории нет),
 *  поэтому команда РОПа — на сегодня, а не на дату периода (отмечено в notes ответа). */
export async function loadOrg(): Promise<OrgPerson[]> {
  const r = await analyticsDb().query<{
    id: string; name: string | null; dept: string | null; rop: string | null; rop_name: string | null; login: string | null; branch: string | null;
  }>(
    `SELECT manager_bitrix_user_id::text AS id, manager_name AS name, department_name AS dept,
            rop_bitrix_user_id::text AS rop, rop_name, short_login AS login, branch
       FROM sa.org_resolved_hierarchy WHERE is_active`,
  );
  return r.rows.map(x => ({
    id: x.id, name: x.name?.trim() || `#${x.id}`, deptName: x.dept, ropId: x.rop, ropName: x.rop_name,
    shortLogin: x.login, branch: x.branch,
  }));
}

/** Битрикс-логины (employees): manager* — продажи, logist* — логисты. Сбой — пустая карта (фильтр не применяется). */
export async function loadLogins(): Promise<Map<string, string>> {
  return loadAccountLogins().catch(() => new Map<string, string>());
}

export interface ServiceGroups { tasker: number | null; big: readonly number[]; repeat: number }

export async function serviceGroups(): Promise<ServiceGroups> {
  const s = await loadSettings().catch(() => ({ groupId: null }));
  return { tasker: s.groupId, big: BIG_DEALS_GROUP_IDS, repeat: REPEAT_PROJECT_GROUP_ID };
}

export function serviceOfGroup(g: ServiceGroups, groupId: number | null): RopService | null {
  if (groupId == null) return null;
  if (g.tasker != null && groupId === g.tasker) return 'tasker';
  if (groupId === g.repeat) return 'repeat';
  if (g.big.includes(groupId)) return 'big';
  return null;
}

/** События канбана повторки, которые ставят задачу менеджеру. */
export const REPEAT_CREATE_EVENTS = ['deal_task_created', 'deal_returned_from_reject', 'task_created', 'task_replaced'] as const;
export const REPEAT_ACCEPT_EVENTS = ['task_accepted', 'task_accepted_deal_closed', 'task_accepted_postponed'] as const;

interface BxRow {
  task_id: string; group_id: number | null; created_by: string | null; responsible_id: string | null; created_at: Date;
  status: number | null; closed_at: Date | null; closed_by: string | null; deadline_at: Date | null;
}
const BX_COLS = `task_id::text, group_id, created_by::text, responsible_id::text, created_at, status, closed_at, closed_by::text, deadline_at`;

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface RopActivity {
  tasks: RopTask[];
  /** Приёмки задач в канбане повторки, по актёру. */
  repeatAccepted: Map<string, number>;
  /** Возвраты на доработку в канбане повторки, по актёру. */
  repeatReturned: Map<string, number>;
}

/** Все задачи, поставленные людьми из creatorIds за [fromIso, toExclIso), по трём сервисам. */
export async function loadRopTasks(creatorIds: string[], fromIso: string, toExclIso: string): Promise<RopActivity> {
  const empty: RopActivity = { tasks: [], repeatAccepted: new Map(), repeatReturned: new Map() };
  if (!creatorIds.length) return empty;
  const groups = await serviceGroups();
  const groupIds = [...(groups.tasker != null ? [groups.tasker] : []), ...groups.big, groups.repeat];
  const creatorInts = creatorIds.map(Number).filter(Number.isFinite);

  const [tasker, repeatEv, bx] = await Promise.all([
    systemDb().query<{
      id: string; bitrix_task_id: string | null; creator: string; manager: string | null; created_at: Date;
      bitrix_status: number | null; closed_at: Date | null; done_at: Date | null; deadline: Date | null; verdict: string | null;
    }>(
      `SELECT id::text, bitrix_task_id::text, creator_bitrix_id AS creator, manager_bitrix_id AS manager, created_at,
              bitrix_status, closed_at, done_at, deadline, verdict
         FROM tasker_tasks
        WHERE cancelled_at IS NULL AND creator_bitrix_id = ANY($1::text[])
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
      [creatorIds, fromIso, toExclIso],
    ).then(r => r.rows),
    systemDb().query<{ actor: string; manager_id: string | null; task_id: string | null; event_type: string; ts: Date }>(
      `SELECT actor_bitrix_id AS actor, manager_id, task_id::text, event_type, ts
         FROM repeat_kanban_events
        WHERE actor_type = 'user' AND actor_bitrix_id = ANY($1::text[])
          AND ts >= $2::timestamptz AND ts < $3::timestamptz
          AND event_type = ANY($4::text[])`,
      [creatorIds, fromIso, toExclIso, [...REPEAT_CREATE_EVENTS, ...REPEAT_ACCEPT_EVENTS, 'task_returned']],
    ).then(r => r.rows),
    groupIds.length
      ? analyticsDb().query<BxRow>(
        `SELECT ${BX_COLS} FROM sa.bitrix_task_current
          WHERE NOT is_deleted AND group_id = ANY($1::int[]) AND created_by = ANY($2::int[])
            AND created_at >= $3::timestamptz AND created_at < $4::timestamptz`,
        [groupIds, creatorInts, fromIso, toExclIso],
      ).then(r => r.rows)
      : Promise.resolve([] as BxRow[]),
  ]);

  // Задачи Монолитики → их bitrix id; состояние подтягиваем из копии Битрикса отдельным запросом.
  const monoBxIds = new Set<string>();
  const foreignMono = new Set<string>();
  for (const t of tasker) if (t.bitrix_task_id) monoBxIds.add(t.bitrix_task_id);
  for (const e of repeatEv) if (e.task_id && (REPEAT_CREATE_EVENTS as readonly string[]).includes(e.event_type)) monoBxIds.add(e.task_id);
  // Канбан повторки ставит задачу в Битрикс с постановщиком = РОП менеджера, а не нажавший (сверка 25.11: задача 174888
  // нажата Будковским, в Битриксе created_by = Павленко). Поэтому задача, известная ЛЮБОМУ журналу Монолитики (кем бы ни
  // поставлена), «напрямую» не считается — она засчитана тому, кто нажал.
  const directCand = bx.filter(r => !monoBxIds.has(r.task_id)).map(r => Number(r.task_id));
  if (directCand.length) {
    const [ev, tk] = await Promise.all([
      systemDb().query<{ id: string }>(
        `SELECT DISTINCT task_id::text AS id FROM repeat_kanban_events WHERE task_id = ANY($1::bigint[]) AND event_type = ANY($2::text[])`,
        [directCand, [...REPEAT_CREATE_EVENTS]]),
      systemDb().query<{ id: string }>(
        `SELECT bitrix_task_id::text AS id FROM tasker_tasks WHERE bitrix_task_id = ANY($1::bigint[])`, [directCand]),
    ]);
    for (const r of [...ev.rows, ...tk.rows]) foreignMono.add(r.id);
  }
  const bxById = new Map<string, BxRow>(bx.map(r => [r.task_id, r]));
  const missing = [...monoBxIds].filter(id => !bxById.has(id)).map(Number).filter(Number.isFinite);
  if (missing.length) {
    const extra = await analyticsDb().query<BxRow>(
      `SELECT ${BX_COLS} FROM sa.bitrix_task_current WHERE task_id = ANY($1::bigint[])`, [missing],
    ).then(r => r.rows).catch(() => [] as BxRow[]);
    for (const r of extra) bxById.set(r.task_id, r);
  }

  const tasks: RopTask[] = [];
  for (const t of tasker) {
    const b = t.bitrix_task_id ? bxById.get(t.bitrix_task_id) : undefined;
    const closedAt = iso(b?.closed_at ?? t.closed_at ?? t.done_at);
    tasks.push({
      key: `tasker:${t.id}`, service: 'tasker', via: 'mono', creatorId: t.creator, assigneeId: t.manager,
      createdAt: iso(t.created_at)!, bitrixTaskId: t.bitrix_task_id ? Number(t.bitrix_task_id) : null,
      status: b?.status ?? t.bitrix_status ?? (closedAt ? 5 : null), closedAt, closedBy: b?.closed_by ?? null,
      deadlineAt: iso(b?.deadline_at ?? t.deadline), verdict: t.verdict,
    });
  }
  const repeatAccepted = new Map<string, number>();
  const repeatReturned = new Map<string, number>();
  const seenRepeat = new Set<string>();
  for (const e of repeatEv) {
    if ((REPEAT_ACCEPT_EVENTS as readonly string[]).includes(e.event_type)) { repeatAccepted.set(e.actor, (repeatAccepted.get(e.actor) ?? 0) + 1); continue; }
    if (e.event_type === 'task_returned') { repeatReturned.set(e.actor, (repeatReturned.get(e.actor) ?? 0) + 1); continue; }
    // Одна кнопка может записать несколько событий по одной задаче — считаем задачу один раз.
    const k = e.task_id ? `bx:${e.task_id}` : `ev:${e.actor}:${e.manager_id}:${new Date(e.ts).getTime()}`;
    if (seenRepeat.has(k)) continue;
    seenRepeat.add(k);
    const b = e.task_id ? bxById.get(e.task_id) : undefined;
    tasks.push({
      key: `repeat:${k}`, service: 'repeat', via: 'mono', creatorId: e.actor, assigneeId: e.manager_id ?? b?.responsible_id ?? null,
      createdAt: iso(e.ts)!, bitrixTaskId: e.task_id ? Number(e.task_id) : null,
      status: b?.status ?? null, closedAt: iso(b?.closed_at), closedBy: b?.closed_by ?? null, deadlineAt: iso(b?.deadline_at), verdict: null,
    });
  }
  for (const b of bx) {
    if (monoBxIds.has(b.task_id) || foreignMono.has(b.task_id)) continue;
    const service = serviceOfGroup(groups, b.group_id);
    if (!service || !b.created_by) continue;
    tasks.push({
      key: `bx:${b.task_id}`, service, via: 'direct', creatorId: b.created_by, assigneeId: b.responsible_id,
      createdAt: iso(b.created_at)!, bitrixTaskId: Number(b.task_id), status: b.status, closedAt: iso(b.closed_at),
      closedBy: b.closed_by, deadlineAt: iso(b.deadline_at), verdict: null,
    });
  }
  return { tasks, repeatAccepted, repeatReturned };
}
