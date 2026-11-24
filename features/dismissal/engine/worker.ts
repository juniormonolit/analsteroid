// Воркер «Увольнятора»: живёт в процессе приложения (instrumentation.ts, env DISMISSAL_WORKER), по образцу
// features/ai-analysis/engine/worker.ts. Берёт прогоны scanning/queued/running (захват UPDATE … RETURNING
// с heartbeat: после рестарта/деплоя протухший прогон подхватывается и продолжает с первой pending-строки).
//
// Вежливо к Битриксу: ОДИН вызов за раз, ≥700 мс между вызовами, вокруг запуска БП — ≥1.5 с. Лимит/таймаут/сеть —
// откат паузы (растёт) и повтор той же строки (attempts), после MAX_ATTEMPTS — error строки. Прочие ошибки —
// error строки и дальше. Пауза/отмена проверяются между строками.
//
// v2: задачи/дела «вслед за сделкой» ждут FOLLOW_DELAY_MS после запуска БП по их сделке (БП асинхронный и сам
// завершает робот-задачи и переводит дела сделки). После всех строк — завершающие шаги (finals.ts).
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { DISMISSAL_KIND_LABELS } from '../types';
import { isTransient, sleep } from './bx';
import { executeItem, type Pace } from './execute';
import { runFinals } from './finals';
import { scanAccount } from './scan';
import { markFiredDate } from '../watch/firedDate';
import { dismissalWatchTick } from '../watch/watcher';
import {
  claimRun, completeRun, getFinals, deferItem, failRun, finishItem, heartbeat, itemDoneAt, nextPending, release, runCounts, runStatus, saveScan,
  type ClaimedRun,
} from './store';

const TICK_MS = 10_000;
const STALE_SEC = 180;
const GAP_MS = 700;
const BP_GAP_MS = 1500;
const MAX_ATTEMPTS = 6;
const HEARTBEAT_MS = 20_000;
/** Запас после запуска БП по сделке, прежде чем трогать её задачи и дела. */
const FOLLOW_DELAY_MS = 90_000;

interface WorkerState { started: boolean; busy: boolean; timer: ReturnType<typeof setInterval> | null; id: string }
const g = globalThis as unknown as { __dismissalWorker?: WorkerState };
const state: WorkerState = (g.__dismissalWorker ??= { started: false, busy: false, timer: null, id: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}` });

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Паузы между вызовами Битрикса — общие на процесс (воркер один). */
function makePacer(): Pace {
  let last = 0;
  let nextGap = GAP_MS;
  return async (what) => {
    const gap = Math.max(nextGap, what === 'bp' ? BP_GAP_MS : GAP_MS);
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    nextGap = what === 'bp' ? BP_GAP_MS : GAP_MS;
  };
}
const pace = makePacer();

async function doScan(run: ClaimedRun): Promise<void> {
  let lastBeat = Date.now();
  try {
    const { items, ropBitrixId } = await scanAccount(run.sourceId, async () => {
      if (Date.now() - lastBeat > HEARTBEAT_MS) { lastBeat = Date.now(); await heartbeat(run.id, state.id).catch(() => {}); }
    });
    const ok = await saveScan(run.id, state.id, items, run.plan, ropBitrixId);
    console.log(`[dismissal] ${run.id} сбор #${run.sourceId}: ${items.length} строк, РОП ${ropBitrixId ?? '—'}${ok ? '' : ' — прогон отменён/перехвачен, не сохранено'}`);
  } catch (e) {
    console.error(`[dismissal] ${run.id} сбор:`, errMsg(e));
    await failRun(run.id, state.id, `Сбор не удался: ${errMsg(e)}`).catch(() => {});
  }
}

async function doExecute(run: ClaimedRun): Promise<void> {
  let lastBeat = Date.now();
  let backoff = 0;
  for (;;) {
    const st = await runStatus(run.id);
    if (st !== 'running') { await release(run.id, state.id); console.log(`[dismissal] ${run.id} остановлен: ${st}`); return; }
    if (Date.now() - lastBeat > HEARTBEAT_MS) { lastBeat = Date.now(); await heartbeat(run.id, state.id); }
    const it = await nextPending(run.id);
    if (!it) {
      await heartbeat(run.id, state.id);
      await runFinals(run, pace).catch(e => console.error(`[dismissal] ${run.id} завершающие шаги:`, errMsg(e)));
      if (await completeRun(run.id, state.id)) {
        // v4: дата увольнения в «Сотрудниках» (не перетирая уже стоящую).
        await markFiredDate(run.id, run.sourceId)
          .then(r => console.log(`[dismissal] ${run.id} «Сотрудники»: ${r}`))
          .catch(e => console.error(`[dismissal] ${run.id} дата увольнения:`, errMsg(e)));
        await notifyDone(run);
      }
      else await release(run.id, state.id);
      return;
    }
    if (!it.action) { await finishItem(run.id, it.key, 'error', 'Действие не задано (прогон запущен без разворота плана)'); continue; }
    // Задача/дело сделки — только когда БП по сделке успел доработать.
    if ((it.kind === 'task_deal' || it.kind === 'activity_deal') && it.info.dealKey) {
      const at = await itemDoneAt(run.id, it.info.dealKey);
      const wait = at ? at.getTime() + FOLLOW_DELAY_MS - Date.now() : 0;
      if (wait > 0) {
        for (let left = wait; left > 0; left -= HEARTBEAT_MS) {
          await sleep(Math.min(left, HEARTBEAT_MS));
          await heartbeat(run.id, state.id).catch(() => {});
          lastBeat = Date.now();
        }
        continue; // заново: статус прогона (пауза/отмена) и та же строка
      }
    }
    try {
      const res = await executeItem({ key: it.key, kind: it.kind, entityId: it.entityId, action: it.action, target: it.target, meta: it.meta, brakReason: run.plan.repeatBrakReason ?? null }, run.sourceId, pace);
      const via = typeof it.meta.viaDepartment === 'string' && res.status === 'done' ? ` (раскидано по отделу «${it.meta.viaDepartment}»)` : '';
      const note = typeof it.meta.planNote === 'string' && res.status === 'done' ? ` (${it.meta.planNote})` : '';
      await finishItem(run.id, it.key, res.status, res.detail + via + note);
      backoff = 0;
    } catch (e) {
      const msg = errMsg(e);
      if (isTransient(e)) {
        const n = await deferItem(run.id, it.key, `Повтор позже: ${msg}`);
        if (n >= MAX_ATTEMPTS) { await finishItem(run.id, it.key, 'error', `${msg} (после ${n} попыток)`); backoff = 0; continue; }
        backoff = Math.min(backoff ? backoff * 2 : 5_000, 120_000);
        console.warn(`[dismissal] ${run.id} ${it.key}: ${msg} — пауза ${backoff / 1000} с, попытка ${n}`);
        // Пауза кусками, с heartbeat — чтобы не считаться умершим и заметить паузу/отмену.
        for (let left = backoff; left > 0; left -= HEARTBEAT_MS) {
          await sleep(Math.min(left, HEARTBEAT_MS));
          await heartbeat(run.id, state.id).catch(() => {});
          lastBeat = Date.now();
        }
      } else {
        console.warn(`[dismissal] ${run.id} ${it.key}: ${msg}`);
        await finishItem(run.id, it.key, 'error', msg);
      }
    }
  }
}

async function notifyDone(run: ClaimedRun): Promise<void> {
  if (!run.createdByBitrixId) return;
  try {
    const c = await runCounts(run.id);
    const f = (await getFinals(run.id))?.finals;
    const FS: Record<string, string> = { done: 'сделано', skipped: 'пропущено', error: '[COLOR=#d32f2f]ошибка[/COLOR]', pending: 'не выполнено' };
    const finalsLine = f ? `Сообщение РОПу: ${FS[f.ropMessage.status]}; смена пароля (Кузнецова): ${FS[f.passwordReset.status]}.` : '';
    const base = (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.ru').replace(/\/$/, '');
    const kinds = Object.entries(c.byKind).map(([k, n]) => `${DISMISSAL_KIND_LABELS[k as keyof typeof DISMISSAL_KIND_LABELS] ?? k}: ${n}`).join(', ');
    const msg = [
      `[B]Увольнятор: ${run.source.name} — готово[/B]`,
      `Выполнено: ${c.done}, пропущено: ${c.skipped}${c.error ? `, [COLOR=#d32f2f]с ошибкой: ${c.error}[/COLOR]` : ''} (всего ${c.total}).`,
      kinds ? `По видам: ${kinds}.` : '',
      finalsLine,
      c.error || f?.ropMessage.status === 'error' || f?.passwordReset.status === 'error' ? 'Ошибки можно повторить из прогона.' : '',
      `[URL=${base}/dismissal/${run.id}]Открыть прогон[/URL]`,
    ].filter(Boolean).join('\n');
    await sendBitrixBotMessage(String(run.createdByBitrixId), msg, undefined, 'dismissal');
  } catch (e) {
    console.warn(`[dismissal] ${run.id} сообщение инициатору:`, errMsg(e));
  }
}

async function drain(): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  try {
    for (let guard = 0; guard < 100; guard++) {
      const run = await claimRun(state.id, STALE_SEC);
      if (!run) break;
      if (run.status === 'scanning') await doScan(run);
      else await doExecute(run);
    }
  } catch (e) {
    console.error('[dismissal] очередь:', errMsg(e));
  } finally {
    state.busy = false;
  }
}

/** Запуск воркера (один раз на процесс). */
export function startDismissalWorker(): void {
  if (state.started) return;
  state.started = true;
  console.log(`[dismissal] воркер запущен (${state.id})`);
  void drain();
  state.timer = setInterval(() => { void drain(); }, TICK_MS);
  // v4: «Сторож увольнений» — свой таймер (исполнение прогона может идти долго), опрос чата раз в 3 мин по аренде в БД.
  setInterval(() => { void dismissalWatchTick(); }, 30_000);
}

/** Разбудить воркер сразу после действия в API (если он запущен в этом процессе). */
export function kickDismissalWorker(): void {
  if (state.started) void drain();
}
