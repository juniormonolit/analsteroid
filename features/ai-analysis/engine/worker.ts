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
import { backfillParsed, claimNext, findDone, heartbeat, refreshLinksLines, requeueStale, saveDone, saveDuplicate, saveError, saveTaskCheckDone } from './store';
import { buildLinksFacts, clarifyLines, proposeLines, type LinksResult } from './links';
import { callsAfterTask, fetchTaskInfo, parseTaskCheck, taskCheckSystem, taskCheckUser, TASK_CHECK_VERSION } from './taskCheck';
import { chat } from './llm';
import { getActivePrompt } from './promptStore';
import { parseReport } from './parse';
import { saveAiAnswers } from '@/features/questionnaires/engine/answers';
import type { CollectedCall } from './collect';

/** Основной менеджер анализа — тот, кто вёл больше всего расшифрованных разговоров. */
function mainManagerOf(calls: CollectedCall[]): string | null {
  const n = new Map<string, number>();
  for (const c of calls) if (c.manager) n.set(c.manager, (n.get(c.manager) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const TICK_MS = 15_000;

interface WorkerState { started: boolean; busy: boolean; timer: ReturnType<typeof setInterval> | null }
const g = globalThis as unknown as { __aiAnalysisWorker?: WorkerState };
const state: WorkerState = (g.__aiAnalysisWorker ??= { started: false, busy: false, timer: null });

async function processOne(): Promise<boolean> {
  const job = await claimNext();
  if (!job) return false;
  const ref = job.clientRef as ClientRef;
  try {
    if (job.checkTaskId) { await runTaskCheck(job.id, job.checkTaskId); return true; }
    const data = await collectClientData(ref);
    // Тест-прогон — черновик из редактора; иначе активная версия (или встроенная из кода).
    const prompt = job.isTest && job.promptBody ? { version: 'draft', body: job.promptBody } : await getActivePrompt();
    if (!job.isTest) {
      const dup = await findDone(ref, callsHashOf(data, prompt.version));
      if (dup) {
        await saveDuplicate(job.id, dup.id);
        // Блоки задачи — по текущим анкетам и правилам сборки (анкеты предлагаемых групп в r не хранятся — берём свежие).
        await refreshLinksLines(job.id, async l => {
          const facts = await buildLinksFacts(data);
          const r = { ...(l as unknown as LinksResult), askForProposed: facts.askForProposed };
          const clarify = clarifyLines(r, facts);
          return { askForProposed: facts.askForProposed, propose: proposeLines(r, facts.shipped12, clarify), clarify } as { propose: string[]; clarify: string[] };
        }).catch(e => console.error('[aiAnalysis] пересборка блоков задачи:', e instanceof Error ? e.message : e));
        return true;
      }
    }
    let lastPhase = 'collecting';
    const out = await analyzeClient(ref, {
      data, prompt,
      onProgress: p => { if (p.phase !== lastPhase) { lastPhase = p.phase; void heartbeat(job.id, p.phase); } },
    });
    await saveDone(job.id, {
      model: out.llm.model, reasoningEffort: DEFAULT_REASONING_EFFORT, callsHash: out.callsHash,
      callsCount: data.calls.length, callsTotal: data.callsTotal, reportMd: out.llm.content, quotes: out.quotes,
      maskHits: out.maskHits, inputTokens: out.llm.usage.promptTokens, cachedTokens: out.llm.usage.cachedTokens,
      outputTokens: out.llm.usage.completionTokens, reasoningTokens: out.llm.usage.reasoningTokens,
      costRub: out.llm.costRub, seconds: out.llm.seconds,
      promptVersion: out.promptVersion, parsed: { ...parseReport(out.llm.content), links: out.links }, mainManager: mainManagerOf(data.calls),
    });
    // Ответы анкеты «по разговорам» (контракт сессии «бриф/теги», questionnaire_answers): только найденные ответы —
    // пустой ответ снял бы прежний; ответы менеджера функция не трогает. Тест-прогон черновика — не пишем.
    const answers = (out.links?.questions ?? []).filter(q => q.audience === 'client' && (q.answerText || q.answerOptions.length));
    if (!job.isTest && answers.length) {
      await saveAiAnswers(ref, job.id, answers.map(q => ({
        questionId: q.id, text: q.answerText, options: q.answerOptions.length ? q.answerOptions : null,
        quote: q.quoteFound ? q.quote : null, callId: q.callId, calledAt: q.calledAt, confidence: q.quoteFound ? 0.9 : 0.5,
      }))).catch(e => console.warn(`[aiAnalysis] #${job.id} ответы анкеты не сохранились:`, e instanceof Error ? e.message : e));
    }
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

/** Проверка звонка по закрытой задаче (вручную, taskCheck.ts). */
async function runTaskCheck(id: number, taskId: number): Promise<void> {
  const t = await fetchTaskInfo(taskId);
  if (!t) throw new Error(`Задача #${taskId} не найдена в копии Битрикса`);
  const calls = await callsAfterTask(t);
  if (!calls.length) throw new Error('После постановки задачи нет расшифрованных разговоров дольше 20 секунд — проверять нечего');
  void heartbeat(id, 'thinking');
  const { text } = taskCheckUser(t, calls);
  const llm = await chat({ system: taskCheckSystem(), user: text, reasoningEffort: DEFAULT_REASONING_EFFORT });
  const { result, quotes } = parseTaskCheck(llm.content, calls);
  await saveTaskCheckDone(id, {
    model: llm.model, reportMd: llm.content, quotes, parsed: { taskCheck: result }, callsCount: calls.length,
    inputTokens: llm.usage.promptTokens, cachedTokens: llm.usage.cachedTokens, outputTokens: llm.usage.completionTokens,
    reasoningTokens: llm.usage.reasoningTokens, costRub: llm.costRub, seconds: llm.seconds, promptVersion: TASK_CHECK_VERSION,
  });
  console.log(`[aiAnalysis] #${id} проверка задачи ${taskId}: ${result.verdict ?? '?'}, ${llm.seconds} с, ${llm.costRub} ₽`);
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
    .then(() => backfillParsed(parseReport))
    .then(n => { if (n) console.log(`[aiAnalysis] разобрано старых отчётов: ${n}`); })
    .catch(e => console.error('[aiAnalysis] requeue/backfill:', e instanceof Error ? e.message : e))
    .finally(() => { void drain(); });
  state.timer = setInterval(() => { void drain(); }, TICK_MS);
}

/** Разбудить воркер сразу после постановки в очередь (если он запущен в этом процессе). */
export function kickAiWorker(): void {
  if (state.started) void drain();
}
