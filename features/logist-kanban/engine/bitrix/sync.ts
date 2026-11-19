// S4 — дубль-задача Битрикса для запроса логисту. Решение владельца: на переходе ДУБЛИРУЕМ (Панель снабжения,
// «Реализация» и отчёты считают по задачам в проектах «регион × товарная группа»). Пишем в одну сторону.
//
// Как устроено. Действие в Монолитике коммитится сразу и от Битрикса не зависит. Хук afterLogistChange
// (requests/hooks.ts) вызывает enqueueForChange(): операции кладутся в logist_bx_outbox (миграция 270) с готовым
// текстом/параметрами, и тут же — не дожидаясь — drainRequest(). Операции запроса выполняются строго по порядку:
// упала — следующие ждут, у запроса bx_sync_status='error' + bx_sync_error (видно в карточке), повтор с бэкоффом
// (1, 2, 4 … 60 мин) — фоновой задачей logistBxSync (instrumentation.ts, на проде через BACKGROUND_JOBS_ALLOW)
// и при следующем действии по запросу.
//
// Что и когда (статусы задачи: 2 ждёт выполнения, 3 выполняется, 4 ждёт контроля, 5 завершена):
//   send      → tasks.task.add в проект очереди: заголовок «Товар | кол-во | адрес», описание как у бизнес-процесса,
//               UF_CRM_TASK=D_<сделка>, постановщик = менеджер, исполнитель = менеджер до взятия (Битрикс требует
//               исполнителя; Панель снабжения берёт снабженца из смены исполнителя), контроль постановщика, срок = SLA.
//   take      → исполнитель = логист, tasks.task.start от логиста → 3.
//   answer    → (из «Новых» — исполнитель = логист) комментарий от логиста с вариантом, tasks.task.complete от логиста → 4.
//               Повторный вариант в «Ждёт контроля» — только комментарий.
//   return    → комментарий от менеджера, 4 → disapprove / 5 → renew (новый цикл в Панели снабжения).
//   accept    → комментарий «принят вариант №N», approve (→ 5; из 2/3 — complete + approve).
//   cancel    → комментарий с причиной, закрыть (complete + approve).
//   release / transfer / reassign / withdraw_offer / add_items — комментарий + исполнитель/проект.
//   message   → комментарий от имени автора (task.commentitem.add с AUTHOR_ID — в задачах нового вида попадает в чат;
//               файлы так не доходят — BACKLOG «Картинки в чат задачи», — вместо них строка «файлы в Монолитике»).
// «От имени»: сначала токен сотрудника (callAsUser), нет — вебхук (владелец — админ портала).
// Выключатели — config.ts (по умолчанию всё выключено).
import { systemDb } from '@/lib/db/clients';
import { callAsUser, UserCallUnsure } from '@/lib/bitrix/userTokens';
import { bitrixPortalOrigin } from '@/lib/bitrix/appAuth';
import { postToTaskChat, read, taskWebhook, writeOnce } from '@/features/repeat-kanban/engine/createDeal';
import type { LogistHookCtx } from '../requests/hooks';
import { bxFlags, tasksBlockedReason } from './config';
import { opsForChange, type BxOp } from './ops';

const db = () => systemDb();
const appBaseUrl = () => (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.ru').replace(/\/$/, '');
const portalBaseUrl = () => (bitrixPortalOrigin() || 'https://td.monolit-crm.ru').replace(/\/$/, '');

// ── постановка в очередь ────────────────────────────────────────────────────────────────

/** Из хука: положить операции и сразу запустить синк (не дожидаясь). Ничего не бросает наружу. */
export async function enqueueForChange(ctx: LogistHookCtx): Promise<void> {
  const r = ctx.request;
  const started = r.bxTaskId != null || (await db().query(`SELECT 1 FROM logist_bx_outbox WHERE request_id = $1 AND op = 'create_task' LIMIT 1`, [r.id])).rowCount;
  if (ctx.action === 'send') {
    if (started) return;
    const blocked = tasksBlockedReason(bxFlags(), r.queue?.groupId, r.deal?.id);
    if (blocked) return; // флаг выключен / не тестовый проект — запрос живёт без дубль-задачи
  } else if (!started) {
    return; // задачи нет и не будет (отправлен при выключенной записи) — дописывать некуда
  }
  const ops = opsForChange(ctx, appBaseUrl(), portalBaseUrl());
  if (!ops.length) return;
  for (const o of ops) {
    await db().query(`INSERT INTO logist_bx_outbox (request_id, op, payload) VALUES ($1, $2, $3)`, [r.id, o.op, JSON.stringify(o)]);
    if (o.op === 'comment' && o.messageId) await db().query(`UPDATE logist_request_messages SET bx_sync_status = 'pending' WHERE id = $1`, [o.messageId]);
  }
  await db().query(`UPDATE logist_requests SET bx_sync_status = CASE WHEN bx_sync_status = 'error' THEN 'error' ELSE 'pending' END WHERE id = $1`, [r.id]);
  void drainRequest(r.id).catch(e => console.error('[logist-bx] drain', r.id, e instanceof Error ? e.message : e));
}

// ── выполнение ──────────────────────────────────────────────────────────────────────────

interface OutboxRow { id: string; request_id: string; op: string; payload: BxOp; status: string; attempts: number; next_at: Date; created_at: Date }

export const backoffMinutes = (attempts: number) => Math.min(60, 2 ** Math.max(0, attempts - 1));

/** Выполнить всё готовое по запросу (по порядку, до первой ошибки). Один исполнитель на запрос (advisory lock). */
export async function drainRequest(requestId: number, opts: { force?: boolean } = {}): Promise<{ done: number; error: string | null }> {
  const client = await db().connect();
  let done = 0;
  try {
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('logist_bx_outbox'), $1::int) AS ok`, [requestId % 2_000_000_000]);
    if (!lock.rows[0]?.ok) return { done: 0, error: null };
    try {
      for (;;) {
        if (!bxFlags().tasks) return { done, error: null }; // выключили — ждём включения
        const r = await client.query<OutboxRow>(
          `SELECT * FROM logist_bx_outbox WHERE request_id = $1 AND status IN ('pending','running','error') ORDER BY id LIMIT 1`, [requestId]);
        const row = r.rows[0];
        if (!row) {
          if (done) await client.query(`UPDATE logist_requests SET bx_sync_status = 'ok', bx_sync_error = NULL, bx_synced_at = now() WHERE id = $1`, [requestId]);
          return { done, error: null };
        }
        if (!opts.force && row.next_at.getTime() > Date.now()) return { done, error: null };
        await client.query(`UPDATE logist_bx_outbox SET status = 'running', attempts = attempts + 1 WHERE id = $1`, [row.id]);
        try {
          const result = await execute(requestId, row.payload, row.attempts + 1, row.created_at);
          await client.query(`UPDATE logist_bx_outbox SET status = 'ok', result = $2, last_error = NULL, done_at = now() WHERE id = $1`, [row.id, JSON.stringify(result ?? null)]);
          done++;
        } catch (e) {
          const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
          const attempts = row.attempts + 1;
          await client.query(`UPDATE logist_bx_outbox SET status = 'error', last_error = $2, next_at = now() + make_interval(mins => $3) WHERE id = $1`,
            [row.id, msg, backoffMinutes(attempts)]);
          await client.query(`UPDATE logist_requests SET bx_sync_status = 'error', bx_sync_error = $2 WHERE id = $1`, [requestId, `${OP_LABEL[row.op] ?? row.op}: ${msg}`]);
          if (row.payload.op === 'comment' && row.payload.messageId) await client.query(`UPDATE logist_request_messages SET bx_sync_status = 'error' WHERE id = $1`, [row.payload.messageId]);
          console.warn(`[logist-bx] запрос ${requestId}, ${row.op} (попытка ${attempts}): ${msg}`);
          return { done, error: msg };
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('logist_bx_outbox'), $1::int)`, [requestId % 2_000_000_000]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/** Фоновая задача: все запросы, где есть что повторить. */
export async function drainAll(limit = 50): Promise<{ requests: number; done: number; errors: number }> {
  if (!bxFlags().tasks) return { requests: 0, done: 0, errors: 0 };
  const r = await db().query<{ request_id: string }>(
    `SELECT request_id FROM logist_bx_outbox WHERE status IN ('pending','running','error') GROUP BY request_id
      HAVING min(next_at) <= now() ORDER BY min(id) LIMIT $1`, [limit]);
  let done = 0, errors = 0;
  for (const x of r.rows) {
    const res = await drainRequest(Number(x.request_id)).catch(e => ({ done: 0, error: String(e) }));
    done += res.done; if (res.error) errors++;
  }
  return { requests: r.rowCount ?? 0, done, errors };
}

const OP_LABEL: Record<string, string> = {
  create_task: 'Создание задачи в Битриксе', comment: 'Комментарий в задачу', assign: 'Исполнитель задачи',
  complete: 'Задача → «Ждёт контроля»', reopen: 'Возобновление задачи', close: 'Завершение задачи',
};

// ── вызовы Битрикса ─────────────────────────────────────────────────────────────────────

/** Задача: от имени сотрудника (токен), иначе вебхуком. UserCallUnsure — пробрасываем: повторит очередь. */
async function taskCall<T>(as: string | null, method: string, params: Record<string, unknown>): Promise<T> {
  const mine = as ? await callAsUser<T>(as, method, params) : undefined;
  if (mine !== undefined) return mine;
  return writeOnce<T>(taskWebhook(), method, params);
}

interface BxTaskBrief { status: number; responsibleId: string; createdBy: string; groupId: number }
async function taskBrief(taskId: number): Promise<BxTaskBrief> {
  const r = await read<{ task?: { status?: string; responsibleId?: string; createdBy?: string; groupId?: string } }>('tasks.task.get', {
    taskId, select: ['ID', 'STATUS', 'RESPONSIBLE_ID', 'CREATED_BY', 'GROUP_ID'],
  });
  const t = r?.task;
  if (!t) throw new Error(`задача ${taskId} не найдена в Битриксе`);
  return { status: Number(t.status), responsibleId: String(t.responsibleId ?? ''), createdBy: String(t.createdBy ?? ''), groupId: Number(t.groupId ?? 0) };
}

async function comment(taskId: number, as: string | null, asName: string, text: string): Promise<number | null> {
  if (as) {
    const ok = await postToTaskChat(taskId, as, text);
    if (!ok) throw new Error('Битрикс не принял комментарий');
    return null;
  }
  const id = await writeOnce<number>(taskWebhook(), 'task.commentitem.add', { TASKID: taskId, FIELDS: { POST_MESSAGE: `[B]${asName}[/B] (из Монолитики):\n${text}` } });
  return Number(id) || null;
}

const update = (taskId: number, fields: Record<string, unknown>) => writeOnce(taskWebhook(), 'tasks.task.update', { taskId, fields });

/** Довести до «завершена»: complete (если не 4/5), затем approve, если осталась в 4. */
async function closeTask(taskId: number, as: string | null): Promise<void> {
  let t = await taskBrief(taskId);
  if (t.status === 5) return;
  if (t.status !== 4) { await taskCall(as, 'tasks.task.complete', { taskId }); t = await taskBrief(taskId); }
  if (t.status === 4) await taskCall(as, 'tasks.task.approve', { taskId });
}

async function taskIdOf(requestId: number): Promise<number> {
  const r = await db().query<{ bx_task_id: string | null }>(`SELECT bx_task_id FROM logist_requests WHERE id = $1`, [requestId]);
  const id = Number(r.rows[0]?.bx_task_id);
  if (!id) throw new Error('дубль-задача ещё не создана');
  return id;
}

/** Ищем задачу, созданную прошлой попыткой (ответ Битрикса потерялся): тот же проект и постановщик, маркер в описании. */
async function findCreated(o: Extract<BxOp, { op: 'create_task' }>, since: Date): Promise<number | null> {
  const from = new Date(since.getTime() - 5 * 60_000).toISOString();
  const r = await read<{ tasks?: { id: string; description?: string }[] }>('tasks.task.list', {
    filter: { GROUP_ID: o.groupId, CREATED_BY: Number(o.managerId), '>=CREATED_DATE': from },
    select: ['ID', 'DESCRIPTION'], order: { ID: 'desc' },
  });
  const hit = (r?.tasks ?? []).find(t => (t.description ?? '').includes(o.marker));
  return hit ? Number(hit.id) : null;
}

async function journal(requestId: number, data: Record<string, unknown>): Promise<void> {
  await db().query(
    `INSERT INTO logist_request_events (request_id, kind, cycle, queue_id, actor_name, data)
     SELECT id, 'bx_sync', cycle, queue_id, 'Битрикс', $2 FROM logist_requests WHERE id = $1`, [requestId, JSON.stringify(data)]);
}

async function execute(requestId: number, o: BxOp, attempt: number, createdAt: Date): Promise<unknown> {
  if (o.op === 'create_task') {
    const existing = await db().query<{ bx_task_id: string | null }>(`SELECT bx_task_id FROM logist_requests WHERE id = $1`, [requestId]);
    if (existing.rows[0]?.bx_task_id) return { taskId: Number(existing.rows[0].bx_task_id), already: true };
    let taskId = attempt > 1 ? await findCreated(o, createdAt) : null;
    if (!taskId) {
      const fields: Record<string, unknown> = {
        TITLE: o.title, DESCRIPTION: o.description, GROUP_ID: o.groupId,
        CREATED_BY: Number(o.managerId), RESPONSIBLE_ID: Number(o.managerId), TASK_CONTROL: 'Y',
        ...(o.deadline ? { DEADLINE: o.deadline } : {}),
        ...(o.dealId ? { UF_CRM_TASK: [`D_${o.dealId}`] } : {}),
      };
      const res = await taskCall<{ task?: { id?: string | number } }>(o.managerId, 'tasks.task.add', { fields }).catch(e => {
        if (e instanceof UserCallUnsure) throw new Error(`${e.message} — следующая попытка сначала поищет созданную задачу`);
        throw e;
      });
      taskId = Number(res?.task?.id ?? 0);
      if (!taskId) throw new Error('Битрикс не вернул id задачи');
    }
    await db().query(`UPDATE logist_requests SET bx_task_id = $2, bx_synced_at = now() WHERE id = $1`, [requestId, taskId]);
    await journal(requestId, { taskId, op: 'create_task' });
    return { taskId };
  }

  const taskId = await taskIdOf(requestId);
  switch (o.op) {
    case 'comment': {
      const cid = await comment(taskId, o.as, o.asName, o.comment);
      if (o.messageId) await db().query(`UPDATE logist_request_messages SET bx_sync_status = 'ok', bx_comment_id = $2 WHERE id = $1`, [o.messageId, cid]);
      return { taskId, commentId: cid };
    }
    case 'assign': {
      const t = await taskBrief(taskId);
      if (o.pause && t.status === 3) await taskCall(null, 'tasks.task.pause', { taskId });
      const fields: Record<string, unknown> = {};
      if (t.responsibleId !== o.responsibleId) fields.RESPONSIBLE_ID = Number(o.responsibleId);
      if (o.groupId && t.groupId !== o.groupId) fields.GROUP_ID = o.groupId;
      if (Object.keys(fields).length) await update(taskId, fields);
      if (o.start && (t.status === 1 || t.status === 2 || t.status === 6)) await taskCall(o.responsibleId, 'tasks.task.start', { taskId });
      return { taskId, fields };
    }
    case 'complete': {
      // с контролем постановщика complete от исполнителя-логиста → «Ждёт контроля» (4)
      const t = await taskBrief(taskId);
      if (t.status !== 4 && t.status !== 5) await taskCall(o.as, 'tasks.task.complete', { taskId });
      return { taskId };
    }
    case 'reopen': {
      const t = await taskBrief(taskId);
      if (t.status === 4) await taskCall(o.as, 'tasks.task.disapprove', { taskId });
      else if (t.status === 5) await taskCall(o.as, 'tasks.task.renew', { taskId });
      return { taskId, from: t.status };
    }
    case 'close':
      await closeTask(taskId, o.as);
      return { taskId };
  }
}
