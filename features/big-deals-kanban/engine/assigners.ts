// «Кто назначил менеджера» (владелец 18.11) — для разреза аналитики by=assigner.
// Источник — история задачи Битрикса (tasks.task.history.list, поле RESPONSIBLE_ID): кто последним сменил исполнителя
// на текущего. Смены не было (робот сразу поставил исполнителя) — назначил постановщик, kind='creator'.
// История неизменна для закрытых задач → кэш навсегда; у открытых — 30 мин. Redis-хеш bigdeals:assigner
// (taskId → JSON), без Redis — память процесса. Холодная загрузка ~2,5 тыс. задач — ~50 batch-вызовов, поэтому
// идёт в фоне: аналитика отдаёт готовое и пометку «собираю N из M».
import { redisReady } from '@/lib/cache/redis';
import { bxBatch, taskWebhook, type BatchCmd } from './rest';
import type { BigPerson, BigTaskCard } from './types';

const KEY = 'bigdeals:assigner';
const OPEN_TTL_MS = 30 * 60_000;

export interface Assigner { person: BigPerson; kind: 'reassign' | 'creator'; at: number; closed: boolean }
const mem = new Map<number, Assigner>();
let loading: Promise<void> | null = null;
let loadedFromRedis = false;

interface HistRow { field?: string; createdDate?: string; value?: { from?: string | null; to?: string | null }; user?: { id?: number | string; name?: string; lastName?: string } }

async function hydrate(): Promise<void> {
  if (loadedFromRedis) return;
  loadedFromRedis = true;
  const redis = await redisReady().catch(() => null);
  if (!redis) return;
  try {
    const all = await redis.hgetall(KEY);
    for (const [k, v] of Object.entries(all ?? {})) { try { mem.set(Number(k), JSON.parse(v) as Assigner); } catch { /* битая запись */ } }
  } catch { /* без Redis — только память */ }
}

const fresh = (a: Assigner | undefined, card: BigTaskCard, now: number) =>
  !!a && (a.closed || (card.state !== 'done' && now - a.at < OPEN_TTL_MS)) && !(card.state === 'done' && !a.closed);

async function fetchMissing(cards: BigTaskCard[]): Promise<void> {
  const cmds: Record<string, BatchCmd> = {};
  for (const c of cards) cmds[`h${c.id}`] = { method: 'tasks.task.history.list', params: { taskId: c.id, filter: { FIELD: 'RESPONSIBLE_ID' } } };
  // История — лёгкий запрос, но Битрикс выполняет команды batch последовательно: пачки по 25.
  const r = await bxBatch<{ list?: HistRow[] }>(taskWebhook(), cmds, 25);
  const now = Date.now();
  const writes: Record<string, string> = {};
  for (const c of cards) {
    const list = (r.result[`h${c.id}`]?.list ?? []).filter(x => x.field === 'RESPONSIBLE_ID' && String(x.value?.to ?? '') === c.responsible.id);
    const last = list.sort((a, b) => Date.parse(b.createdDate ?? '') - Date.parse(a.createdDate ?? ''))[0];
    if (!(`h${c.id}` in r.result)) continue; // команда не выполнилась — попробуем в следующий раз
    const a: Assigner = last?.user?.id
      ? { person: { id: String(last.user.id), name: [last.user.name, last.user.lastName].filter(Boolean).join(' ') || `#${last.user.id}` }, kind: 'reassign', at: now, closed: c.state === 'done' }
      : { person: c.creator, kind: 'creator', at: now, closed: c.state === 'done' };
    mem.set(c.id, a);
    writes[String(c.id)] = JSON.stringify(a);
  }
  const redis = await redisReady().catch(() => null);
  if (redis && Object.keys(writes).length) await redis.hset(KEY, writes).catch(() => {});
}

/** Назначившие для карточек: готовые — сразу; недостающие догружаются в фоне (не ждём). */
export async function assignersFor(cards: BigTaskCard[]): Promise<{ map: Map<number, Assigner>; missing: number }> {
  await hydrate();
  const now = Date.now();
  const map = new Map<number, Assigner>();
  const missing: BigTaskCard[] = [];
  for (const c of cards) {
    const a = mem.get(c.id);
    if (a && fresh(a, c, now)) map.set(c.id, a);
    else { if (a) map.set(c.id, a); else missing.push(c); }
  }
  const stale = cards.filter(c => { const a = mem.get(c.id); return a && !fresh(a, c, now); });
  const todo = [...missing, ...stale];
  if (todo.length && !loading) {
    loading = fetchMissing(todo.slice(0, 3000))
      .catch(e => console.warn('[big-deals] история исполнителей', e instanceof Error ? e.message : e))
      .finally(() => { loading = null; });
  }
  return { map, missing: missing.length };
}
