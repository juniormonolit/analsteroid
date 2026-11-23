// Живые статусы задач Задачника — tasks.task.list по GROUP_ID проекта (как канбан больших чеков,
// features/big-deals-kanban/engine/load.ts), не копия Roan: она отстаёт. Кэш 3 мин (SWR в Redis,
// без Redis — в памяти процесса). Изменения статуса заодно пишутся в tasker_tasks.bitrix_status —
// по ним автозамер знает, что задача закрыта, а доска не пустеет, если Битрикс недоступен.
import { systemDb } from '@/lib/db/clients';
import { cachedSwr } from '@/lib/cache/redis';
import { bxBatch, taskWebhook, type BatchCmd } from '@/features/big-deals-kanban/engine/rest';

export interface LiveTask {
  id: number;
  status: number;
  closedDate: string | null;
  deadline: string | null;
  startPlan: string | null;
  endPlan: string | null;
}

const FRESH_SEC = 180;
const KEEP_SEC = 24 * 3600;
const CLOSED_DAYS = 120;
const SELECT = ['ID', 'STATUS', 'CLOSED_DATE', 'DEADLINE', 'START_DATE_PLAN', 'END_DATE_PLAN'];

interface RawTask { id: string; status: string; closedDate?: string | null; deadline?: string | null; startDatePlan?: string | null; endDatePlan?: string | null }

const iso = (s: string | null | undefined) => (s ? new Date(s).toISOString() : null);

interface LiveSnap { at: number; tasks: LiveTask[] }

async function fetchLive(groupId: number): Promise<LiveSnap> {
  const closedSince = new Date(Date.now() - CLOSED_DAYS * 86400_000).toISOString();
  const filters: Record<string, Record<string, unknown>> = {
    open: { GROUP_ID: groupId, '<REAL_STATUS': 5 },
    closed: { GROUP_ID: groupId, '>=REAL_STATUS': 5, '>=CLOSED_DATE': closedSince },
  };
  const cmd = (f: Record<string, unknown>, start: number): BatchCmd => ({
    method: 'tasks.task.list', params: { filter: f, select: SELECT, order: { ID: 'asc' }, start },
  });
  const first: Record<string, BatchCmd> = {};
  for (const [k, f] of Object.entries(filters)) first[k] = cmd(f, 0);
  const r1 = await bxBatch<{ tasks: RawTask[] }>(taskWebhook(), first);
  const all: RawTask[] = Object.values(r1.result).flatMap(p => p?.tasks ?? []);
  const rest: Record<string, BatchCmd> = {};
  for (const [k, f] of Object.entries(filters)) {
    const total = Number(r1.total[k] ?? 0);
    for (let s = 50; s < total; s += 50) rest[`${k}_${s}`] = cmd(f, s);
  }
  if (Object.keys(rest).length) {
    const r2 = await bxBatch<{ tasks: RawTask[] }>(taskWebhook(), rest);
    all.push(...Object.values(r2.result).flatMap(p => p?.tasks ?? []));
  }
  const byId = new Map<number, LiveTask>();
  for (const t of all) {
    byId.set(Number(t.id), {
      id: Number(t.id), status: Number(t.status) || 0, closedDate: iso(t.closedDate), deadline: iso(t.deadline),
      startPlan: iso(t.startDatePlan), endPlan: iso(t.endDatePlan),
    });
  }
  const list = [...byId.values()];
  await persistStatuses(list).catch(e => console.warn('[tasker] persist statuses', e instanceof Error ? e.message : e));
  return { at: Date.now(), tasks: list };
}

async function persistStatuses(list: LiveTask[]): Promise<void> {
  if (!list.length) return;
  await systemDb().query(
    `UPDATE tasker_tasks t SET bitrix_status = x.status,
            closed_at = CASE WHEN x.status = 5 THEN COALESCE(x.closed::timestamptz, t.closed_at, now()) ELSE NULL END,
            updated_at = now()
       FROM unnest($1::bigint[], $2::int[], $3::text[]) AS x(id, status, closed)
      WHERE t.bitrix_task_id = x.id AND t.bitrix_status IS DISTINCT FROM x.status`,
    [list.map(t => t.id), list.map(t => t.status), list.map(t => t.closedDate)],
  );
}

// Без Redis cachedSwr считает каждый раз — держим свой слой в памяти (как big-deals load.ts).
const mem = new Map<number, { at: number; data: LiveSnap }>();

/** Живые задачи проекта + момент снимка (строки БД свежее снимка — PATCH из Монолитики — побеждают). */
export async function loadLiveTasks(groupId: number | null, opts: { force?: boolean } = {}): Promise<{ at: number; byId: Map<number, LiveTask> } | null> {
  if (!groupId) return null;
  try {
    const m = mem.get(groupId);
    let data: LiveSnap;
    if (!opts.force && m && Date.now() - m.at < FRESH_SEC * 1000) data = m.data;
    else {
      data = opts.force ? await fetchLive(groupId) : await cachedSwr(`tasker:live:v1:${groupId}`, FRESH_SEC, KEEP_SEC, () => fetchLive(groupId));
      mem.set(groupId, { at: Date.now(), data });
    }
    return { at: data.at, byId: new Map(data.tasks.map(t => [t.id, t])) };
  } catch (e) {
    console.warn('[tasker] живые статусы недоступны:', e instanceof Error ? e.message : e);
    return null;
  }
}

export function invalidateLive(groupId: number | null): void {
  if (groupId) mem.delete(groupId);
}
