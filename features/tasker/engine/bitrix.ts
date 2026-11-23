// Запись Задачника в Битрикс — через outbox (tasker_bx_outbox, миграция 274) по образцу
// features/logist-kanban/engine/bitrix/sync.ts: действие в Монолитике коммитится сразу, операции
// в Битрикс выполняются по порядку внутри задачи с ретраем и бэкоффом; создание задачи
// идемпотентно — при повторе ищем задачу прошлой попытки по маркеру в описании (findCreated).
// Постановщик — callAsUser (токен нажавшего) с откатом на вебхук, как в канбане повторных.
import { systemDb } from '@/lib/db/clients';
import { bx } from '@/lib/bitrix/notify';
import { callAsUser, UserCallUnsure } from '@/lib/bitrix/userTokens';
import { read, taskWebhook, writeOnce } from '@/features/repeat-kanban/engine/createDeal';
import { loadSettings, NOT_CONFIGURED_MESSAGE, TaskerError } from './config';
import { syncSessionCalendar } from './calendar';
import type { TaskerPatchableStatus } from '../types';

export type BxOp =
  | { op: 'create_task'; fields: Record<string, unknown>; marker: string; creatorBitrixId: string | null }
  | { op: 'checklist'; items: string[] }
  | { op: 'status'; target: TaskerPatchableStatus; asBitrixId: string | null }
  | { op: 'update'; fields: Record<string, unknown>; asBitrixId: string | null }
  | { op: 'comment'; text: string }
  | { op: 'calendar'; sessionId: number };

interface OutboxRow { id: string; task_id: string; op: string; payload: BxOp; attempts: number; next_at: Date; created_at: Date }

export const backoffMinutes = (attempts: number) => Math.min(60, 2 ** Math.max(0, attempts - 1));
const MAX_ATTEMPTS = 12;

export async function enqueue(taskId: number, ops: BxOp[]): Promise<void> {
  if (!ops.length) return;
  const values: string[] = [];
  const params: unknown[] = [taskId];
  ops.forEach((o, i) => { values.push(`($1, $${2 * i + 2}, $${2 * i + 3}::jsonb)`); params.push(o.op, JSON.stringify(o)); });
  await systemDb().query(`INSERT INTO tasker_bx_outbox (task_id, op, payload) VALUES ${values.join(', ')}`, params);
}

/** Выполнить готовое по задаче (по порядку, до первой ошибки). Один исполнитель на задачу (advisory lock). */
export async function drainTask(taskId: number, opts: { force?: boolean } = {}): Promise<{ done: number; error: string | null }> {
  const client = await systemDb().connect();
  let done = 0;
  const key = taskId % 2_000_000_000;
  try {
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('tasker_bx_outbox'), $1::int) AS ok`, [key]);
    if (!lock.rows[0]?.ok) return { done: 0, error: null };
    try {
      for (;;) {
        const r = await client.query<OutboxRow>(
          `SELECT * FROM tasker_bx_outbox WHERE task_id = $1 AND status IN ('pending','running','error') ORDER BY id LIMIT 1`, [taskId]);
        const row = r.rows[0];
        if (!row) {
          if (done) await client.query(`UPDATE tasker_tasks SET sync_state = 'synced', sync_error = NULL, updated_at = now() WHERE id = $1 AND bitrix_task_id IS NOT NULL`, [taskId]);
          return { done, error: null };
        }
        if (!opts.force && row.next_at.getTime() > Date.now()) return { done, error: null };
        await client.query(`UPDATE tasker_bx_outbox SET status = 'running', attempts = attempts + 1 WHERE id = $1`, [row.id]);
        try {
          const result = await execute(taskId, row.payload, row.attempts + 1, row.created_at);
          await client.query(`UPDATE tasker_bx_outbox SET status = 'ok', result = $2, last_error = NULL, done_at = now() WHERE id = $1`, [row.id, JSON.stringify(result ?? null)]);
          done++;
        } catch (e) {
          const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
          const attempts = row.attempts + 1;
          // «Не настроен проект» — не ошибка Битрикса: ждём настройки без счёта попыток.
          const notConfigured = e instanceof TaskerError && e.code === 'not_configured';
          const giveUp = !notConfigured && attempts >= MAX_ATTEMPTS;
          await client.query(
            `UPDATE tasker_bx_outbox SET status = $4, last_error = $2, attempts = CASE WHEN $5 THEN attempts - 1 ELSE attempts END,
                    next_at = now() + make_interval(mins => $3) WHERE id = $1`,
            [row.id, msg, notConfigured ? 30 : backoffMinutes(attempts), giveUp ? 'skipped' : 'error', notConfigured]);
          await client.query(`UPDATE tasker_tasks SET sync_state = 'failed', sync_error = $2, updated_at = now() WHERE id = $1`, [taskId, `${OP_LABEL[row.op] ?? row.op}: ${msg}`]);
          console.warn(`[tasker-bx] задача ${taskId}, ${row.op} (попытка ${attempts}): ${msg}`);
          return { done, error: msg };
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('tasker_bx_outbox'), $1::int)`, [key]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/** Фоновая задача: все задачи, где есть что повторить. */
export async function drainAll(limit = 50): Promise<{ tasks: number; done: number; errors: number }> {
  const r = await systemDb().query<{ task_id: string }>(
    `SELECT task_id FROM tasker_bx_outbox WHERE status IN ('pending','running','error') GROUP BY task_id
      HAVING min(next_at) <= now() ORDER BY min(id) LIMIT $1`, [limit]);
  let done = 0, errors = 0;
  for (const x of r.rows) {
    const res = await drainTask(Number(x.task_id)).catch(e => ({ done: 0, error: String(e) }));
    done += res.done; if (res.error) errors++;
  }
  return { tasks: r.rowCount ?? 0, done, errors };
}

const OP_LABEL: Record<string, string> = {
  create_task: 'Создание задачи в Битриксе', checklist: 'Чек-лист заказчиков', status: 'Смена статуса',
  update: 'Сроки задачи', comment: 'Комментарий в задачу', calendar: 'Событие сессии в календаре РОПа',
};

// ── вызовы ──────────────────────────────────────────────────────────────────

async function taskCall<T>(as: string | null, method: string, params: Record<string, unknown>): Promise<T> {
  const mine = as ? await callAsUser<T>(as, method, params) : undefined;
  if (mine !== undefined) return mine;
  return writeOnce<T>(taskWebhook(), method, params);
}

async function bitrixTaskIdOf(taskId: number): Promise<number> {
  const r = await systemDb().query<{ bitrix_task_id: string | null }>(`SELECT bitrix_task_id FROM tasker_tasks WHERE id = $1`, [taskId]);
  const id = Number(r.rows[0]?.bitrix_task_id ?? 0);
  if (!id) throw new Error('задача ещё не создана в Битриксе');
  return id;
}

/** Задача, созданная прошлой попыткой (ответ Битрикса потерялся): тот же проект, маркер в описании. */
async function findCreated(groupId: number, marker: string, since: Date): Promise<number | null> {
  const from = new Date(since.getTime() - 5 * 60_000).toISOString();
  const r = await read<{ tasks?: { id: string; description?: string }[] }>('tasks.task.list', {
    filter: { GROUP_ID: groupId, '>=CREATED_DATE': from },
    select: ['ID', 'DESCRIPTION'], order: { ID: 'desc' },
  });
  const hit = (r?.tasks ?? []).find(t => (t.description ?? '').includes(marker));
  return hit ? Number(hit.id) : null;
}

async function execute(taskId: number, o: BxOp, attempt: number, createdAt: Date): Promise<unknown> {
  switch (o.op) {
    case 'create_task': {
      const { groupId } = await loadSettings();
      if (!groupId) throw new TaskerError(NOT_CONFIGURED_MESSAGE, 'not_configured', 409);
      let id = attempt > 1 ? await findCreated(groupId, o.marker, createdAt) : null;
      if (!id) {
        const params = { fields: { ...o.fields, GROUP_ID: groupId } };
        let res: { task?: { id?: string | number } } | undefined;
        try {
          res = await taskCall<{ task?: { id?: string | number } }>(o.creatorBitrixId, 'tasks.task.add', params);
        } catch (e) {
          // Сеть/таймаут при вызове от имени — задача могла создаться: следующая попытка сначала ищет.
          if (e instanceof UserCallUnsure) throw new Error(`ответ Битрикса не получен (${e.message}) — повтор найдёт задачу по маркеру`);
          throw e;
        }
        id = Number(res?.task?.id ?? 0);
        if (!id) throw new Error('Битрикс не вернул id задачи');
      }
      await systemDb().query(
        `UPDATE tasker_tasks SET bitrix_task_id = $2, bitrix_status = COALESCE(bitrix_status, 2), updated_at = now() WHERE id = $1`, [taskId, id]);
      return { taskId: id };
    }
    case 'checklist': {
      const bxId = await bitrixTaskIdOf(taskId);
      // Повтор после частичного успеха: пункты, которые уже есть, не дублируем.
      const existing = await bx(taskWebhook(), 'task.checklistitem.getlist', { TASKID: bxId }).catch(() => null) as { result?: { TITLE?: string }[] } | null;
      const have = new Set((existing?.result ?? []).map(x => (x.TITLE ?? '').trim()));
      let added = 0;
      for (const title of o.items) {
        if (have.has(title.trim())) continue;
        await writeOnce(taskWebhook(), 'task.checklistitem.add', { TASKID: bxId, FIELDS: { TITLE: title, IS_COMPLETE: 'N' } });
        added++;
      }
      return { added };
    }
    case 'status': {
      const bxId = await bitrixTaskIdOf(taskId);
      const cur = await read<{ task?: { status?: string } }>('tasks.task.get', { taskId: bxId, select: ['ID', 'STATUS'] });
      const status = Number(cur?.task?.status ?? 0);
      const steps = statusSteps(status, o.target);
      for (const method of steps) {
        if (method === 'tasks.task.approve') {
          // complete от постановщика закрывает сразу (5) — тогда «принять» не нужно.
          const mid = await read<{ task?: { status?: string } }>('tasks.task.get', { taskId: bxId, select: ['ID', 'STATUS'] });
          if (Number(mid?.task?.status ?? 0) !== 4) continue;
        }
        await taskCall(o.asBitrixId, method, { taskId: bxId });
      }
      const after = await read<{ task?: { status?: string } }>('tasks.task.get', { taskId: bxId, select: ['ID', 'STATUS', 'CLOSED_DATE'] });
      const st = Number(after?.task?.status ?? 0) || null;
      await systemDb().query(
        `UPDATE tasker_tasks SET bitrix_status = $2, closed_at = CASE WHEN $2 = 5 THEN COALESCE(closed_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1`,
        [taskId, st]);
      return { from: status, to: st, steps };
    }
    case 'update': {
      const bxId = await bitrixTaskIdOf(taskId);
      await taskCall(o.asBitrixId, 'tasks.task.update', { taskId: bxId, fields: o.fields });
      return { ok: true };
    }
    case 'calendar':
      return syncSessionCalendar(o.sessionId);
    case 'comment': {
      const bxId = await bitrixTaskIdOf(taskId);
      // Без AUTHOR_ID — автор = владелец вебхука (системный комментарий автозамера).
      const id = await writeOnce<number>(taskWebhook(), 'task.commentitem.add', { TASKID: bxId, FIELDS: { POST_MESSAGE: o.text } });
      return { commentId: id };
    }
  }
}

/**
 * Последовательность методов Битрикса из текущего статуса в целевой.
 * Статусы: 1 новая, 2 ждёт выполнения, 3 выполняется, 4 ждёт контроля, 5 завершена, 6 отложена, 7 отклонена.
 */
export function statusSteps(cur: number, target: TaskerPatchableStatus): string[] {
  const closed = cur === 5 || cur === 7;
  switch (target) {
    case 'new':
      if (closed || cur === 4) return ['tasks.task.renew'];
      if (cur === 3) return ['tasks.task.pause'];
      if (cur === 6) return ['tasks.task.renew'];
      return [];
    case 'in_progress':
      if (cur === 3) return [];
      if (cur === 4) return ['tasks.task.disapprove', 'tasks.task.start'];
      if (closed) return ['tasks.task.renew', 'tasks.task.start'];
      return ['tasks.task.start'];
    case 'awaiting_control':
      if (cur === 4) return [];
      if (closed) return ['tasks.task.renew', 'tasks.task.complete'];
      return ['tasks.task.complete'];
    case 'done':
      if (cur === 5) return [];
      if (cur === 4) return ['tasks.task.approve'];
      return ['tasks.task.complete', 'tasks.task.approve'];
  }
}
