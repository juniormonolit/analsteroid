// Прогрев снимков Задачника (после деплоя кэш пуст — namespace Redis привязан к BUILD_ID, — и «Сейчас» в
// карточке задачи считалось холодным ~15 с, первый снимок в форме — тоже).
//
// 1) «Текущее» открытых задач и задач «на замере» (verdict ещё нет): значение менеджера за период «с дня
//    постановки по сегодня» — то, что показывает карточка. Кладём в свой ключ на задачу (tasker:current:…),
//    GET /api/tasker/tasks отдаёт его полем task.current, и карточка не ждёт POST /snapshot.
//    Значение менеджера в отчёте от среза смотрящего не зависит (срезается только «Итого отдела», карточке оно
//    не нужно), поэтому считаем «глазами» постановщика, как автозамер (withLoopbackRunner), без окна 6 мес.
// 2) Снимок формы: для постановщиков, ставивших задачи за 30 дней, — их показатели за текущий месяц (период
//    формы по умолчанию) в ТЕХ ЖЕ ключах кэша, что читает форма (computeSnapshots + snapshotCacheScope).
//
// Нагрузка: всё строго последовательно, один прогон отчёта за раз; задачи с одинаковыми (показатель, день
// постановки) у одного постановщика — одним прогоном; свежие ключи пропускаем; потолок прогонов и времени на
// тик; отдельный advisory lock (tasker_warm) — один прогрев на кластер, и он не держит лок основной задачи
// (досылка в Битрикс каждую минуту не ждёт прогрева).
import { systemDb } from '@/lib/db/clients';
import { cacheVersion, redisReady } from '@/lib/cache/redis';
import { loadSessionUserById } from '@/lib/auth/session';
import { getSessionScope } from '@/lib/org/sessionScope';
import type { TaskerCurrent } from '../types';
import { loadMetricDefs, mskToday, type TaskerMetricDef } from './config';
import { computeSnapshots, snapshotCacheScope } from './snapshot';
import { withLoopbackRunner } from './reportRunner';

const CURRENT_TTL_SEC = 40 * 60;
/** Не пересчитывать «текущее», если оно моложе этого. */
const CURRENT_FRESH_MS = 14 * 60_000;
const MAX_RUNS_PER_TICK = 60;
const MAX_TICK_MS = 10 * 60_000;

const mskDay = (d: Date | string) => new Date(new Date(d).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
const keyOf = (taskId: number | string, from: string, to: string) => `as:${cacheVersion()}:tasker:current:v1:${taskId}:${from}:${to}`;

// L1 в процессе: без Redis (локально) и чтобы не ходить в Redis лишний раз.
const local = new Map<string, { v: TaskerCurrent; exp: number }>();

async function putCurrent(entries: { key: string; v: TaskerCurrent }[]): Promise<void> {
  const exp = Date.now() + CURRENT_TTL_SEC * 1000;
  for (const e of entries) local.set(e.key, { v: e.v, exp });
  const r = await redisReady();
  if (!r || !entries.length) return;
  const m = r.multi();
  for (const e of entries) m.set(e.key, JSON.stringify(e.v), 'EX', CURRENT_TTL_SEC);
  await m.exec().catch(() => {});
}

/** «Текущее» для задач (по дню постановки → сегодня). Нет в кэше — нет в ответе (карточка посчитает сама). */
export async function readCurrent(tasks: { id: number; createdAt: string }[]): Promise<Map<number, TaskerCurrent>> {
  const out = new Map<number, TaskerCurrent>();
  if (!tasks.length) return out;
  const today = mskToday();
  const keys = tasks.map(t => keyOf(t.id, mskDay(t.createdAt), today));
  const miss: number[] = [];
  keys.forEach((k, i) => {
    const hit = local.get(k);
    if (hit && hit.exp > Date.now()) out.set(tasks[i].id, hit.v); else miss.push(i);
  });
  if (!miss.length) return out;
  const r = await redisReady();
  if (!r) return out;
  try {
    const vals = await r.mget(...miss.map(i => keys[i]));
    vals.forEach((v, j) => { if (v) out.set(tasks[miss[j]].id, JSON.parse(v) as TaskerCurrent); });
  } catch { /* кэш недоступен — карточка посчитает сама */ }
  return out;
}

interface Due { id: string; creator_user_id: string | null; manager_bitrix_id: string; metric_id: string; created_at: Date }

let lastWarm = 0;
let warming = false;
const WARM_EVERY_MS = 15 * 60_000;

/** Зовётся из taskerTick каждую минуту: сам решает, пора ли (при старте и раз в 15 мин), и не ждётся. */
export function maybeWarm(): void {
  if (warming || Date.now() - lastWarm < WARM_EVERY_MS) return;
  lastWarm = Date.now();
  warming = true;
  void warmAll()
    .then(r => { if (r && (r.runs || r.failed)) console.log(`[tasker] прогрев: прогонов ${r.runs}, «текущее» у ${r.current} задач, снимков формы ${r.form}, сбоев ${r.failed}`); })
    .catch(e => { if ((e as { code?: string }).code !== '42P01') console.warn('[tasker] прогрев:', e instanceof Error ? e.message : e); })
    .finally(() => { warming = false; });
}

export async function warmAll(): Promise<{ runs: number; current: number; form: number; failed: number } | null> {
  const client = await systemDb().connect();
  try {
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('tasker_warm')) AS ok`);
    if (!lock.rows[0]?.ok) return null;
    try {
      const st = { runs: 0, current: 0, form: 0, failed: 0, started: Date.now() };
      const metrics = new Map((await loadMetricDefs()).map(m => [m.id, m]));
      await warmCurrent(metrics, st);
      await warmForm(metrics, st);
      return { runs: st.runs, current: st.current, form: st.form, failed: st.failed };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('tasker_warm'))`).catch(() => {});
    }
  } finally {
    client.release();
  }
}

type Stats = { runs: number; current: number; form: number; failed: number; started: number };
const budgetLeft = (st: Stats) => st.runs < MAX_RUNS_PER_TICK && Date.now() - st.started < MAX_TICK_MS;

async function warmCurrent(metrics: Map<string, TaskerMetricDef>, st: Stats): Promise<void> {
  const today = mskToday();
  const rows = (await systemDb().query<Due>(
    `SELECT t.id, t.creator_user_id, t.manager_bitrix_id, t.metric_id, t.created_at FROM tasker_tasks t
      WHERE t.verdict IS NULL AND t.cancelled_at IS NULL AND t.creator_user_id IS NOT NULL
      ORDER BY t.creator_user_id, t.metric_id, t.created_at`)).rows;
  // Уже свежее — пропускаем.
  const have = await readCurrent(rows.map(r => ({ id: Number(r.id), createdAt: new Date(r.created_at).toISOString() })));
  const stale = rows.filter(r => {
    const c = have.get(Number(r.id));
    return !c || Date.now() - Date.parse(c.at) > CURRENT_FRESH_MS;
  });
  // Постановщик → (показатель, день постановки) → задачи: один прогон на группу.
  const byCreator = new Map<string, Map<string, Due[]>>();
  for (const r of stale) {
    if (mskDay(r.created_at) > today || !metrics.has(r.metric_id)) continue;
    const g = byCreator.get(r.creator_user_id!) ?? new Map<string, Due[]>();
    const k = `${r.metric_id}|${mskDay(r.created_at)}`;
    g.set(k, [...(g.get(k) ?? []), r]);
    byCreator.set(r.creator_user_id!, g);
  }
  for (const [creator, groups] of byCreator) {
    if (!budgetLeft(st)) return;
    await withLoopbackRunner(creator, async run => {
      for (const [k, list] of groups) {
        if (!budgetLeft(st)) return;
        const [metricId, from] = k.split('|');
        try {
          st.runs++;
          const snaps = await computeSnapshots(run, [...new Set(list.map(t => t.manager_bitrix_id))], metrics.get(metricId)!, { from, to: today },
            { withOwnAvg: false, cacheScope: null });
          const at = new Date().toISOString();
          // Менеджера нет в строках постановщика (ушёл из его зоны) — не кладём «—»: карточка посчитает глазами смотрящего.
          const found = list.filter(t => { const x = snaps[t.manager_bitrix_id]; return !!x && (x.value !== null || x.denominator !== null); });
          await putCurrent(found.map(t => {
            const s = snaps[t.manager_bitrix_id];
            return { key: keyOf(t.id, from, today), v: { value: s.value, enoughData: s.enoughData, denominator: s.denominator ?? null, from, to: today, at } };
          }));
          st.current += found.length;
        } catch (e) {
          st.failed++;
          console.warn(`[tasker] прогрев «текущего» (${metricId}, с ${from}):`, e instanceof Error ? e.message : e);
        }
      }
    }).catch(e => { st.failed++; console.warn('[tasker] прогрев: сессия постановщика', creator, e instanceof Error ? e.message : e); });
  }
}

/** Снимок формы по умолчанию: текущий месяц по сегодня, показатели, которыми постановщик пользовался за 30 дней. */
async function warmForm(metrics: Map<string, TaskerMetricDef>, st: Stats): Promise<void> {
  const today = mskToday();
  const period = { from: `${today.slice(0, 8)}01`, to: today };
  const rows = (await systemDb().query<{ creator_user_id: string; metric_ids: string[] }>(
    `SELECT creator_user_id, array_agg(DISTINCT metric_id) AS metric_ids FROM tasker_tasks
      WHERE creator_user_id IS NOT NULL AND created_at > now() - interval '30 days'
      GROUP BY creator_user_id ORDER BY max(created_at) DESC LIMIT 20`)).rows;
  const doneScopes = new Set<string>();
  for (const r of rows) {
    if (!budgetLeft(st)) return;
    const user = await loadSessionUserById(r.creator_user_id).catch(() => null);
    if (!user) continue;
    const scope = await getSessionScope(user);
    const cacheScope = snapshotCacheScope(scope.kind, user.id);
    const todo = r.metric_ids.filter(id => metrics.has(id) && !doneScopes.has(`${cacheScope}|${id}`));
    if (!todo.length) continue;
    await withLoopbackRunner(user.id, async run => {
      for (const id of todo) {
        if (!budgetLeft(st)) return;
        doneScopes.add(`${cacheScope}|${id}`);
        try {
          // Свежий ключ cached() вернёт без прогона — считаем прогоном с запасом (потолок консервативный).
          st.runs++;
          await computeSnapshots(run, [], metrics.get(id)!, period, { cacheScope });
          st.form++;
        } catch (e) {
          st.failed++;
          console.warn(`[tasker] прогрев формы (${id}):`, e instanceof Error ? e.message : e);
        }
      }
    }).catch(e => { st.failed++; console.warn('[tasker] прогрев формы: сессия', r.creator_user_id, e instanceof Error ? e.message : e); });
  }
}
