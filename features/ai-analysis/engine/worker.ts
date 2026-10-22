// Воркер очереди ИИ-анализа: живёт в процессе приложения (instrumentation.ts), отдельной
// инфраструктуры нет. По одному анализу за раз (~1 мин в reasoning_effort low).
//
// Деплой убивает процесс посреди анализа → при старте все running возвращаются в очередь
// (requeueStale(true)): РОП не получает «ошибка, запустите заново» и второй счёт за тот же запуск.
// API после постановки в очередь зовёт kickAiWorker(), чтобы не ждать тика.
import type { ClientRef } from '@/features/client-module/engine/types';
import { collectClientData } from './collect';
import { analyzeClient, callsHashOf } from './analyze';
import { DEFAULT_REASONING_EFFORT, LlmError } from './llm';
import { claimNext, findDone, heartbeat, requeueStale, saveDone, saveDuplicate, saveError } from './store';

const TICK_MS = 15_000;

interface WorkerState { started: boolean; busy: boolean; timer: ReturnType<typeof setInterval> | null }
const g = globalThis as unknown as { __aiAnalysisWorker?: WorkerState };
const state: WorkerState = (g.__aiAnalysisWorker ??= { started: false, busy: false, timer: null });

async function processOne(): Promise<boolean> {
  const job = await claimNext();
  if (!job) return false;
  const ref = job.clientRef as ClientRef;
  try {
    const data = await collectClientData(ref);
    const dup = await findDone(ref, callsHashOf(data));
    if (dup) { await saveDuplicate(job.id, dup.id); return true; }
    let lastPhase = 'collecting';
    const out = await analyzeClient(ref, {
      data,
      onProgress: p => { if (p.phase !== lastPhase) { lastPhase = p.phase; void heartbeat(job.id, p.phase); } },
    });
    await saveDone(job.id, {
      model: out.llm.model, reasoningEffort: DEFAULT_REASONING_EFFORT, callsHash: out.callsHash,
      callsCount: data.calls.length, callsTotal: data.callsTotal, reportMd: out.llm.content, quotes: out.quotes,
      maskHits: out.maskHits, inputTokens: out.llm.usage.promptTokens, cachedTokens: out.llm.usage.cachedTokens,
      outputTokens: out.llm.usage.completionTokens, reasoningTokens: out.llm.usage.reasoningTokens,
      costRub: out.llm.costRub, seconds: out.llm.seconds,
    });
    console.log(`[aiAnalysis] #${job.id} ${ref}: ${out.llm.seconds} с, ${out.llm.costRub} ₽`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Повторяем только сетевые/временные сбои; «нет денег», «нет звонков», 4xx — сразу ошибка.
    const retry = e instanceof LlmError && e.retryable;
    console.error(`[aiAnalysis] #${job.id} ${ref}: ${msg}`);
    await saveError(job.id, msg, retry).catch(() => {});
  }
  return true;
}

async function drain(): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  try {
    await requeueStale(false);
    while (await processOne()) { /* следующий */ }
  } catch (e) {
    console.error('[aiAnalysis] очередь:', e instanceof Error ? e.message : e);
  } finally {
    state.busy = false;
  }
}

/** Запуск воркера (один раз на процесс). */
export function startAiWorker(): void {
  if (state.started) return;
  state.started = true;
  void requeueStale(true)
    .then(n => { if (n) console.log(`[aiAnalysis] после рестарта возвращено в очередь: ${n}`); })
    .catch(e => console.error('[aiAnalysis] requeue:', e instanceof Error ? e.message : e))
    .finally(() => { void drain(); });
  state.timer = setInterval(() => { void drain(); }, TICK_MS);
}

/** Разбудить воркер сразу после постановки в очередь (если он запущен в этом процессе). */
export function kickAiWorker(): void {
  if (state.started) void drain();
}
