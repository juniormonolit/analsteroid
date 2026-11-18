// Массовое закрытие задач канбана больших чеков (владелец 18.11: в «Не продано (проверка)» висят ~2,7 тыс. задач,
// в основном «ждёт контроля» — разобрать завал одной кнопкой, а не по одной).
//
// Отбор — только из снимка доски (load.ts) и только то, что пользователь ВИДИТ и может ДВИГАТЬ (canSeeTask/canManageTask
// движка), уже закрытые не трогаем. Вход: явный список taskIds (выделение на доске — чужие/невидимые id молча
// отбрасываются) ИЛИ BigFilters (правило по колонке, напр. «Не продано (проверка), не менялась ≥ 30 дней») через matchFilters.
//
// Запуск — фоновая job в памяти процесса (Map; прод — один процесс под systemd). Закрываем вебхуком (владелец — админ
// портала, у него approve на всё; токены РОПов на тысячи задач не годятся), пачками через `batch`:
//   пачка 1: на каждую задачу complete, затем approve (контроль постановщика: complete от не-постановщика оставляет
//            «ждёт контроля», approve админа закрывает; лишняя команда на неподходящем статусе вернёт ошибку — игнорируем) + в конце tasks.task.list по id пачки — реальный статус ПОСЛЕ команд (batch выполняется по порядку);
//   пачка 2: комментарий «Закрыто массово…» — только в реально закрытые (комментарий в незакрытую врал бы).
// Без автоповтора (writeOnce-подобно): повтор batch задвоил бы комментарии. Пауза между пачками 0,5 с, лимит 3000 за запуск.
import { randomUUID } from 'node:crypto';
import { BIG_COLUMNS } from './config';
import type { BigFilters, BigMassCloseJob, BigTaskCard } from './types';
import { actorLabel, type BigActor } from './actions';
import { loadSnapshot, invalidateTask, withAge } from './load';
import { canManageTask, canSeeTask, matchFilters } from './board';
import { qs, taskWebhook, type BatchCmd } from './rest';

export const MASS_CLOSE_LIMIT = 3000;
const SAMPLE = 20;
const PAUSE_MS = 500;
/** Команд закрытия в одной пачке (+1 — проверка статусов). */
const CLOSE_CMDS = 49;

export class MassCloseError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type MassCloseInput = ({ taskIds: number[]; filters?: undefined } | { filters: BigFilters; taskIds?: undefined }) & { comment?: string };

export interface MassClosePlan {
  /** Сколько закроем (≤ лимита). */
  count: number;
  /** Подошло всего (может быть больше лимита). */
  matched: number;
  limited: boolean;
  /** Выделенные id, которых нет среди видимых/управляемых открытых задач. */
  skipped: number;
  sample: BigTaskCard[];
  cards: BigTaskCard[];
}

const columnTitle = (k: string) => BIG_COLUMNS.find(c => c.key === k)?.title ?? k;

/** Что закроется — по снимку доски и правам пользователя. */
export async function planMassClose(input: MassCloseInput, actor: BigActor): Promise<MassClosePlan> {
  if (!actor.canManage) throw new MassCloseError('Закрывать задачи может только РОП', 403);
  const snap = await loadSnapshot();
  const now = Date.now();
  const mine = snap.cards
    .map(c => withAge(c, now))
    .filter(c => c.state !== 'done' && canSeeTask(c, actor) && canManageTask(c, actor));
  let picked: BigTaskCard[];
  let skipped = 0;
  if (Array.isArray(input.taskIds)) {
    const ids = [...new Set(input.taskIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
    if (!ids.length) throw new MassCloseError('Не выбрано ни одной задачи');
    if (ids.length > MASS_CLOSE_LIMIT) throw new MassCloseError(`За раз — не больше ${MASS_CLOSE_LIMIT} задач`);
    const want = new Set(ids);
    picked = mine.filter(c => want.has(c.id));
    skipped = ids.length - picked.length;
  } else if (input.filters && typeof input.filters === 'object') {
    const f = input.filters;
    // Правило без единого условия закрыло бы всю зону — не даём.
    const hasCondition = !!(f.columns?.length || f.states?.length || f.idleDaysMin || f.daysMin || f.groups?.length || f.manager || f.products?.length || f.q || f.stuck || f.noCalls || f.deal || f.createdFrom || f.createdTo || f.sumMin != null || f.sumMax != null);
    if (!hasCondition) throw new MassCloseError('Задайте условие отбора (колонку, статус, срок простоя…)');
    picked = mine.filter(c => matchFilters(c, f, now));
  } else throw new MassCloseError('Нужен список задач или правило отбора');
  // Сначала самые давно не менявшиеся — при упоре в лимит закрываем самый старый завал.
  picked.sort((a, b) => (a.changedAt ?? a.createdAt).localeCompare(b.changedAt ?? b.createdAt) || a.id - b.id);
  const cards = picked.slice(0, MASS_CLOSE_LIMIT);
  return { count: cards.length, matched: picked.length, limited: picked.length > MASS_CLOSE_LIMIT, skipped, sample: cards.slice(0, SAMPLE), cards };
}

// ── job ─────────────────────────────────────────────────────────────────────
interface JobInternal extends BigMassCloseJob { owner: string; closedIds: number[] }
const g = globalThis as unknown as { __bigMassClose?: Map<string, JobInternal> };
const jobs: Map<string, JobInternal> = g.__bigMassClose ??= new Map();
const JOB_TTL_MS = 6 * 3600_000;

function publicJob(j: JobInternal): BigMassCloseJob {
  const { owner: _o, closedIds: _c, ...rest } = j;
  void _o; void _c;
  return rest;
}

export function getMassCloseJob(id: string, ownerLogin: string, isAdmin: boolean): BigMassCloseJob | null {
  const j = jobs.get(id);
  if (!j || (j.owner !== ownerLogin && !isAdmin)) return null;
  return publicJob(j);
}

/** Запустить закрытие в фоне. expectedCount — число, которое пользователь подтвердил: закрыть больше нельзя. */
export async function startMassClose(input: MassCloseInput, actor: BigActor, ownerLogin: string, expectedCount: number): Promise<{ jobId: string; total: number }> {
  for (const [id, j] of jobs) if (Date.now() - Date.parse(j.startedAt) > JOB_TTL_MS) jobs.delete(id);
  const running = [...jobs.values()].find(j => j.owner === ownerLogin && !j.finished);
  if (running) throw new MassCloseError('У вас уже идёт массовое закрытие — дождитесь окончания', 409);
  const plan = await planMassClose(input, actor);
  if (!plan.count) throw new MassCloseError('Нечего закрывать: под условие не попала ни одна открытая задача вашей зоны');
  if (!Number.isInteger(expectedCount) || expectedCount <= 0) throw new MassCloseError('Подтвердите число задач');
  if (plan.count > expectedCount) throw new MassCloseError(`Задач стало больше, чем вы подтвердили (${plan.count} вместо ${expectedCount}) — посмотрите предпросмотр ещё раз`, 409);
  const job: JobInternal = {
    id: randomUUID(), total: plan.count, done: 0, failed: 0, errors: [], finished: false, startedAt: new Date().toISOString(),
    owner: ownerLogin, closedIds: [],
  };
  jobs.set(job.id, job);
  const comment = String(input.comment ?? '').trim().slice(0, 2000);
  const text = `Закрыто массово из канбана больших чеков (Монолитика · ${actorLabel(actor)}).${comment ? `\n${comment}` : ''}`;
  console.log(`[big-deals mass-close] ${ownerLogin} старт job=${job.id} задач=${plan.count}${input.taskIds ? ' (выделение)' : ` (правило ${JSON.stringify(input.filters)})`}`);
  void runJob(job, plan.cards, text, actor.userId).catch(e => {
    job.errors.push(`Остановлено: ${e instanceof Error ? e.message : String(e)}`);
  }).finally(() => {
    job.finished = true;
    invalidateTask();
    console.log(`[big-deals mass-close] ${ownerLogin} итог job=${job.id}: закрыто ${job.done} из ${job.total}, ошибок ${job.failed}${job.errors.length ? ` — ${job.errors.slice(0, 5).join(' | ')}` : ''}`);
  });
  return { jobId: job.id, total: plan.count };
}

/** Команды закрытия одной задачи (как Runner.close в actions.ts, но без перечитывания статуса между шагами). */
export function closeCommands(c: Pick<BigTaskCard, 'id' | 'state'>): [string, BatchCmd][] {
  const out: [string, BatchCmd][] = [];
  // complete шлём и «ждущим контроля»: статус в снимке мог устареть (задачу вернули в работу), а на статусе 4
  // complete просто вернёт ошибку, которую игнорируем — итог решает проверка статуса в конце пачки.
  out.push([`c${c.id}`, { method: 'tasks.task.complete', params: { taskId: c.id } }]);
  out.push([`a${c.id}`, { method: 'tasks.task.approve', params: { taskId: c.id } }]);
  return out;
}

/** Пачки ≤ CLOSE_CMDS команд: задача целиком в одной пачке. */
export function packChunks(cards: Pick<BigTaskCard, 'id' | 'state'>[]): Pick<BigTaskCard, 'id' | 'state'>[][] {
  const chunks: Pick<BigTaskCard, 'id' | 'state'>[][] = [];
  let cur: Pick<BigTaskCard, 'id' | 'state'>[] = [];
  let n = 0;
  for (const c of cards) {
    const k = closeCommands(c).length;
    if (n + k > CLOSE_CMDS) { chunks.push(cur); cur = []; n = 0; }
    cur.push(c); n += k;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

interface BatchBody { result?: { result?: Record<string, unknown> | unknown[]; result_error?: Record<string, { error?: string; error_description?: string } | string> | unknown[] }; error?: string; error_description?: string }

/** Один вызов batch без автоповтора. */
async function batchOnce(cmds: [string, BatchCmd][]): Promise<{ result: Record<string, unknown>; errors: Record<string, string> }> {
  const cmd: Record<string, string> = {};
  for (const [k, c] of cmds) cmd[k] = `${c.method}?${qs(c.params)}`;
  const res = await fetch(`${taskWebhook()}/batch.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ halt: 0, cmd }), signal: AbortSignal.timeout(90_000), cache: 'no-store',
  });
  const body = await res.json().catch(() => null) as BatchBody | null;
  if (!res.ok || !body || body.error) throw new Error(`batch: ${body?.error ?? `HTTP ${res.status}`} ${body?.error_description ?? ''}`.trim());
  const r = body.result ?? {};
  const result = r.result && !Array.isArray(r.result) ? r.result : {};
  const errors: Record<string, string> = {};
  if (r.result_error && !Array.isArray(r.result_error)) {
    for (const [k, v] of Object.entries(r.result_error)) errors[k] = typeof v === 'string' ? v : [v?.error, v?.error_description].filter(Boolean).join(': ');
  }
  return { result, errors };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function runJob(job: JobInternal, cards: BigTaskCard[], text: string, authorId: string | null): Promise<void> {
  const pushErr = (s: string) => { if (job.errors.length < 50) job.errors.push(s); };
  const chunks = packChunks(cards);
  for (let i = 0; i < chunks.length; i++) {
    if (i) await sleep(PAUSE_MS);
    const chunk = chunks[i];
    const ids = chunk.map(c => c.id);
    const cmds: [string, BatchCmd][] = chunk.flatMap(closeCommands);
    cmds.push(['check', { method: 'tasks.task.list', params: { filter: { ID: ids }, select: ['ID', 'STATUS'], start: -1 } }]);
    let closed: number[] = [];
    try {
      const { result, errors } = await batchOnce(cmds);
      const list = (result.check as { tasks?: { id: string; status: string }[] } | undefined)?.tasks ?? [];
      const status = new Map(list.map(t => [Number(t.id), String(t.status)]));
      closed = ids.filter(id => status.get(id) === '5');
      for (const id of ids) {
        if (status.get(id) === '5') continue;
        job.failed++;
        const why = errors[`a${id}`] || errors[`c${id}`] || (status.has(id) ? `статус ${status.get(id)} после закрытия` : 'задача не найдена');
        pushErr(`Задача ${id}: ${why}`);
      }
    } catch (e) {
      // Пачка могла частично пройти — не знаем, что закрылось; честно считаем как ошибки, дальше не идём.
      job.failed += ids.length;
      pushErr(`Пачка задач ${ids[0]}…${ids[ids.length - 1]}: ${e instanceof Error ? e.message : String(e)} — проверьте эти задачи в Битриксе`);
      throw new Error('Битрикс не ответил на пачку — массовое закрытие остановлено, остальные задачи не тронуты');
    }
    job.done += closed.length;
    job.closedIds.push(...closed);
    if (closed.length) {
      const comments: [string, BatchCmd][] = closed.map(id => [`m${id}`, {
        method: 'task.commentitem.add', params: { TASKID: id, FIELDS: { ...(authorId ? { AUTHOR_ID: Number(authorId) } : {}), POST_MESSAGE: text } },
      }]);
      await batchOnce(comments).then(r => {
        const bad = Object.keys(r.errors).length;
        if (bad) pushErr(`Комментарий не ушёл в ${bad} задач(и) пачки (задачи закрыты)`);
      }).catch(e => pushErr(`Комментарии пачки не ушли (задачи закрыты): ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

/** Человеческое описание правила — для заголовка/лога. */
export function describeFilters(f: BigFilters): string {
  const parts: string[] = [];
  if (f.columns?.length) parts.push(f.columns.map(columnTitle).join(', '));
  if (f.idleDaysMin) parts.push(`не менялась ≥ ${f.idleDaysMin} дн.`);
  if (f.daysMin) parts.push(`в колонке ≥ ${f.daysMin} дн.`);
  if (f.states?.length) parts.push(f.states.includes('control') && f.states.length === 1 ? 'ждёт контроля' : `статусы: ${f.states.join(', ')}`);
  return parts.join(' · ');
}
