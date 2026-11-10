// Задачи канбана повторных продаж — задачи Битрикса в проекте «Повторные продажи»
// (группа 118; ТЗ старого канбана, решение владельца 20.10). Читаем копию
// sa.bitrix_task_current — туда же попадают задачи, поставленные старым канбаном
// /crm/mltclients/, поэтому на карточке видны обе. Свою таблицу задач (миграция 230,
// repeat_kanban_tasks) больше не пишем.
//
// Статусы Битрикса: 1 новая, 2 ждёт выполнения, 3 выполняется, 4 ждёт контроля,
// 5 завершена, 6 отложена. status_view = -2 — «не просмотрена» исполнителем.
import { analyticsDb } from '@/lib/db/clients';
import { REPEAT_PROJECT_GROUP_ID } from './config';

export type RepeatTaskState = 'unread' | 'pending' | 'in_progress' | 'control' | 'done' | 'deferred';

export interface RepeatTask {
  id: number;
  dealId: number;
  title: string;
  state: RepeatTaskState;
  createdById: string | null;
  createdByName: string | null;
  responsibleId: string | null;
  responsibleName: string | null;
  createdAt: string;
  deadlineAt: string | null;
  /** Последнее изменение (для «ждёт контроля N дней»). */
  changedAt: string | null;
  closedAt: string | null;
}

function stateOf(status: number | null, view: number | null): RepeatTaskState {
  if (status === 5) return 'done';
  if (status === 4) return 'control';
  if (status === 6) return 'deferred';
  if (status === 3) return 'in_progress';
  if (view === -2) return 'unread';
  return 'pending';
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** Задачи, поставленные из Монолитики, — пары «сделка → задача» из нашего журнала и очереди.
 *  Синк задач (sa.bitrix_task_current) часто пишет задачу без привязки к сделке: событие
 *  ONTASKADD приходит без UF_CRM_TASK, а сверка её не досыпает (23.10: за 22.10 у 42 из 53 задач
 *  проекта deal_id пустой) — карточка писала «Сделка без задачи», хотя задачу только что поставили
 *  (сделка 273512, задача 170743). Связь берём из своих записей. */
interface LinkedTask { dealId: number; createdAt: string; creatorId: string | null; creatorName: string | null; responsibleId: string | null; deadlineAt: string | null }

async function linkedTasks(dealIds: number[]): Promise<Map<number, LinkedTask>> {
  const { systemDb } = await import('@/lib/db/clients');
  type Raw = { task_id: string; deal_id: string; at: Date; creator_id: string | null; creator_name: string | null; resp: string | null; deadline: string | null; dtime: string | null };
  const r = await systemDb().query<Raw>(
    `SELECT DISTINCT ON (task_id) task_id::text, deal_id::text, ts AS at, actor_bitrix_id AS creator_id, actor_name AS creator_name,
            payload->>'responsible' AS resp, payload->>'deadline' AS deadline, payload->>'deadlineTime' AS dtime
       FROM repeat_kanban_events
      WHERE task_id IS NOT NULL AND deal_id = ANY($1::bigint[])
      ORDER BY task_id, ts
     `,
    [dealIds],
  ).catch(() => ({ rows: [] as Raw[] }));
  const q = await systemDb().query<Raw>(
    `SELECT issued_task_id::text AS task_id, issued_deal_id::text AS deal_id, issued_at AS at, queued_by AS creator_id, queued_by_name AS creator_name,
            coalesce(new_responsible_id, manager_id) AS resp, NULL AS deadline, NULL AS dtime
       FROM repeat_task_queue WHERE issued_task_id IS NOT NULL AND issued_deal_id = ANY($1::bigint[])`,
    [dealIds],
  ).catch(() => ({ rows: [] as Raw[] }));
  const out = new Map<number, LinkedTask>();
  for (const x of [...r.rows, ...q.rows]) {
    const id = Number(x.task_id);
    if (out.has(id)) continue;
    out.set(id, {
      dealId: Number(x.deal_id), createdAt: new Date(x.at).toISOString(), creatorId: x.creator_id, creatorName: x.creator_name, responsibleId: x.resp,
      deadlineAt: x.deadline && /^\d{4}-\d{2}-\d{2}$/.test(x.deadline) ? new Date(`${x.deadline}T${x.dtime && /^\d{2}:\d{2}$/.test(x.dtime) ? x.dtime : '19:00'}:00+03:00`).toISOString() : null,
    });
  }
  return out;
}

/** Последняя задача проекта по каждой сделке: по привязке в копии Битрикса И по нашим записям. */
export async function fetchTasksForDeals(dealIds: number[]): Promise<Map<number, RepeatTask>> {
  if (!dealIds.length) return new Map();
  try {
    const links = await linkedTasks(dealIds);
    // Задачи, поставленные в Битриксе руками после 08.10 (taskReview.ts: syncChangedProjectTasks) — как свои.
    const { knownBxTasks } = await import('./taskReview');
    const bxExtra = new Map((await knownBxTasks(dealIds).catch(() => [])).map(t => [t.id, t]));
    for (const t of bxExtra.values()) {
      if (!links.has(t.id)) links.set(t.id, { dealId: t.dealId, createdAt: t.createdAt, creatorId: t.createdBy, creatorName: null, responsibleId: t.responsibleId, deadlineAt: t.deadline });
    }
    const r = await analyticsDb().query(
      `SELECT t.task_id, t.deal_id, t.title, t.status, t.status_view, t.created_by, t.responsible_id,
              t.responsible_name, t.created_at, t.deadline_at, t.changed_at, t.closed_at, org.manager_name AS created_by_name
         FROM sa.bitrix_task_current t
         LEFT JOIN LATERAL (SELECT manager_name FROM sa.org_resolved_hierarchy o
                             WHERE o.manager_bitrix_user_id = t.created_by::text LIMIT 1) org ON true
        WHERE t.group_id = $2 AND NOT t.is_deleted AND (t.deal_id = ANY($1::bigint[]) OR t.task_id = ANY($3::bigint[]))`,
      [dealIds, REPEAT_PROJECT_GROUP_ID, [...links.keys()]],
    );
    const out = new Map<number, RepeatTask>();
    // Статус из Битрикса, узнанный при приёмке, — поверх копии (taskReview.ts: копия задач стоит с 08.10).
    const { knownTaskStatuses } = await import('./taskReview');
    const known = await knownTaskStatuses(r.rows.map(x => Number(x.task_id))).catch(() => new Map());
    for (const x of r.rows) {
      const k = known.get(Number(x.task_id));
      if (k && (!x.changed_at || new Date(k.at) > new Date(x.changed_at))) {
        x.status = k.status; if (k.closedAt) { x.closed_at = k.closedAt; x.changed_at = k.closedAt; }
        if (k.deadline !== undefined) x.deadline_at = k.deadline; // срок перенесли в Битриксе после 08.10
      }
      const dealId = x.deal_id !== null ? Number(x.deal_id) : links.get(Number(x.task_id))?.dealId;
      if (!dealId) continue;
      const task: RepeatTask = {
        id: Number(x.task_id), dealId, title: String(x.title ?? ''),
        state: stateOf(x.status !== null ? Number(x.status) : null, x.status_view !== null ? Number(x.status_view) : null),
        createdById: x.created_by !== null ? String(x.created_by) : null, createdByName: x.created_by_name ?? null,
        responsibleId: x.responsible_id !== null ? String(x.responsible_id) : null, responsibleName: x.responsible_name ?? null,
        createdAt: iso(x.created_at)!, deadlineAt: iso(x.deadline_at), changedAt: iso(x.changed_at), closedAt: iso(x.closed_at),
      };
      const cur = out.get(dealId);
      if (!cur || task.createdAt > cur.createdAt) out.set(dealId, task);
    }
    // Задачи, поставленные из Монолитики, которых в копии нет вовсе (09.11: копия задач стоит с 08.10 —
    // с 05.11 из 62 наших задач в ней 1). Собираем по своему журналу; статус — из кэша Битрикса (taskReview.ts).
    const inCopy = new Set(r.rows.map(x => Number(x.task_id)));
    const missing = [...links].filter(([id]) => !inCopy.has(id));
    if (missing.length) {
      const st = await knownTaskStatuses(missing.map(([id]) => id)).catch(() => new Map());
      const people = [...new Set(missing.flatMap(([, l]) => [l.responsibleId, l.creatorName ? null : l.creatorId]).filter((v): v is string => !!v))];
      const names = new Map((await analyticsDb().query<{ id: string; n: string }>(
        `SELECT DISTINCT ON (manager_bitrix_user_id) manager_bitrix_user_id AS id, manager_name AS n FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id = ANY($1::text[])`, [people],
      ).catch(() => ({ rows: [] as { id: string; n: string }[] }))).rows.map(x => [x.id, x.n]));
      for (const [id, l] of missing) {
        const k = st.get(id);
        const task: RepeatTask = {
          id, dealId: l.dealId, title: bxExtra.get(id)?.title ?? '', state: stateOf(k ? k.status : bxExtra.get(id)?.status ?? null, null),
          createdById: l.creatorId, createdByName: l.creatorName ?? (l.creatorId ? names.get(l.creatorId) ?? null : null), responsibleId: l.responsibleId, responsibleName: l.responsibleId ? names.get(l.responsibleId) ?? null : null,
          createdAt: l.createdAt, deadlineAt: k && k.deadline !== undefined ? k.deadline : l.deadlineAt, changedAt: k?.closedAt ?? k?.at ?? null, closedAt: k?.status === 5 ? k.closedAt ?? null : null,
        };
        const cur = out.get(l.dealId);
        if (!cur || task.createdAt > cur.createdAt) out.set(l.dealId, task);
      }
    }
    return out;
  } catch (e) {
    console.warn('[repeat-kanban] задачи проекта не прочитались:', e instanceof Error ? e.message : e);
    return new Map();
  }
}
