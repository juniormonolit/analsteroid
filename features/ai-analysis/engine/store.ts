// Таблица ai_analyses (migrations/247) — очередь и хранилище отчётов ИИ-анализа звонков.
import { systemDb } from '@/lib/db/clients';
import type { QuoteCheck } from './verify';
import type { ParsedReport } from './parse';

export type AnalysisStatus = 'queued' | 'running' | 'done' | 'error';

export interface AnalysisRow {
  id: number;
  clientRef: string;
  status: AnalysisStatus;
  phase: string | null;
  promptVersion: string;
  model: string | null;
  callsCount: number | null;
  callsTotal: number | null;
  reportMd: string | null;
  quotes: QuoteCheck[] | null;
  costRub: number | null;
  seconds: number | null;
  error: string | null;
  feedback: 'useful' | 'inaccurate' | null;
  feedbackNote: string | null;
  isTest: boolean;
  parsed: ParsedReport | null;
  mainManager: string | null;
  score: number | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Анализов в день на одного запускающего — защита бюджета (~5 ₽ за анализ). */
export const MAX_PER_DAY = Number(process.env.AI_ANALYSIS_MAX_PER_DAY ?? 30);
/** Попыток на анализ: прерванный деплоем возвращается в очередь, после стольких — ошибка. */
export const MAX_ATTEMPTS = 2;
/** running без heartbeat дольше — процесс умер, вернуть в очередь. */
export const STALE_MINUTES = 15;

const COLS = `id, client_ref, status, phase, prompt_version, model, calls_count, calls_total, report_md, quotes,
  cost_rub, seconds, error, feedback, feedback_note, is_test, parsed, main_manager, score::text AS score,
  created_by, created_by_name, created_at, started_at, finished_at`;

type Raw = {
  id: string; client_ref: string; status: AnalysisStatus; phase: string | null; prompt_version: string; model: string | null;
  calls_count: number | null; calls_total: number | null; report_md: string | null; quotes: QuoteCheck[] | null;
  cost_rub: string | null; seconds: number | null; error: string | null; feedback: 'useful' | 'inaccurate' | null; feedback_note: string | null;
  is_test: boolean; parsed: ParsedReport | null; main_manager: string | null; score: string | null;
  created_by: string; created_by_name: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
};
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
function map(r: Raw): AnalysisRow {
  return {
    id: Number(r.id), clientRef: r.client_ref, status: r.status, phase: r.phase, promptVersion: r.prompt_version, model: r.model,
    callsCount: r.calls_count, callsTotal: r.calls_total, reportMd: r.report_md, quotes: r.quotes,
    costRub: r.cost_rub === null ? null : Number(r.cost_rub), seconds: r.seconds, error: r.error,
    feedback: r.feedback, feedbackNote: r.feedback_note, isTest: !!r.is_test, parsed: r.parsed, mainManager: r.main_manager,
    score: r.score === null ? null : Number(r.score), createdBy: r.created_by, createdByName: r.created_by_name,
    createdAt: iso(r.created_at)!, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
  };
}

export async function getAnalysis(id: number): Promise<AnalysisRow | null> {
  const r = await systemDb().query<Raw>(`SELECT ${COLS} FROM ai_analyses WHERE id = $1`, [id]);
  return r.rows[0] ? map(r.rows[0]) : null;
}

export async function listForClient(clientRef: string, limit = 10): Promise<AnalysisRow[]> {
  const r = await systemDb().query<Raw>(`SELECT ${COLS} FROM ai_analyses WHERE client_ref = $1 AND NOT is_test AND kind = 'client' ORDER BY created_at DESC LIMIT $2`, [clientRef, limit]);
  return r.rows.map(map);
}

export async function countToday(login: string): Promise<number> {
  const r = await systemDb().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_analyses
      WHERE created_by = $1 AND NOT is_test AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow')`,
    [login],
  );
  return r.rows[0]?.n ?? 0;
}

/** Активный (в очереди / в работе) анализ заказчика — второй не ставим. */
export async function activeForClient(clientRef: string): Promise<AnalysisRow | null> {
  const r = await systemDb().query<Raw>(`SELECT ${COLS} FROM ai_analyses WHERE client_ref = $1 AND status IN ('queued','running') AND NOT is_test AND kind = 'client' ORDER BY id DESC LIMIT 1`, [clientRef]);
  return r.rows[0] ? map(r.rows[0]) : null;
}

export async function enqueue(input: {
  clientRef: string; promptVersion: string; by: { login: string; name: string | null };
  /** Тест-прогон черновика промпта: не попадает во вкладку, сводку и дедуп. */
  test?: { body: string };
  /** Проверка звонка по закрытой задаче (migrations/252, taskCheck.ts) — вместо разбора заказчика. */
  checkTaskId?: number;
}): Promise<number> {
  const r = await systemDb().query<{ id: string }>(
    `INSERT INTO ai_analyses (client_ref, prompt_version, created_by, created_by_name, is_test, prompt_body, kind, check_task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.clientRef, input.test ? 'draft' : input.promptVersion, input.by.login, input.by.name, !!input.test, input.test?.body ?? null,
      input.checkTaskId ? 'task_check' : 'client', input.checkTaskId ?? null],
  );
  return Number(r.rows[0].id);
}

/** Взять следующий из очереди (SKIP LOCKED — на случай двух процессов в момент деплоя). */
export async function claimNext(): Promise<{ id: number; clientRef: string; isTest: boolean; promptBody: string | null; checkTaskId: number | null } | null> {
  const r = await systemDb().query<{ id: string; client_ref: string; is_test: boolean; prompt_body: string | null; check_task_id: string | null }>(
    `UPDATE ai_analyses SET status = 'running', phase = 'collecting', attempts = attempts + 1, heartbeat_at = now(), started_at = now()
      WHERE id = (SELECT id FROM ai_analyses WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, client_ref, is_test, prompt_body, check_task_id`,
  );
  const x = r.rows[0];
  return x ? { id: Number(x.id), clientRef: x.client_ref, isTest: !!x.is_test, promptBody: x.prompt_body, checkTaskId: x.check_task_id ? Number(x.check_task_id) : null } : null;
}

export async function heartbeat(id: number, phase: string): Promise<void> {
  await systemDb().query(`UPDATE ai_analyses SET phase = $2, heartbeat_at = now() WHERE id = $1 AND status = 'running'`, [id, phase]);
}

/** Готовый отчёт с тем же входом и версией промпта — отдаём его, а не платим заново. */
export async function findDone(clientRef: string, callsHash: string): Promise<{ id: number } | null> {
  const r = await systemDb().query<{ id: string }>(
    `SELECT id FROM ai_analyses WHERE client_ref = $1 AND calls_hash = $2 AND status = 'done' AND NOT is_test AND kind = 'client' ORDER BY id DESC LIMIT 1`,
    [clientRef, callsHash],
  );
  return r.rows[0] ? { id: Number(r.rows[0].id) } : null;
}

export async function saveDone(id: number, v: {
  model: string; reasoningEffort: string; callsHash: string; callsCount: number; callsTotal: number; reportMd: string;
  quotes: QuoteCheck[]; maskHits: Record<string, number>; inputTokens: number; cachedTokens: number; outputTokens: number;
  reasoningTokens: number; costRub: number; seconds: number;
  promptVersion: string; parsed: ParsedReport; mainManager: string | null;
}): Promise<void> {
  await systemDb().query(
    `UPDATE ai_analyses SET status = 'done', phase = NULL, finished_at = now(), error = NULL,
       model = $2, reasoning_effort = $3, calls_hash = $4, calls_count = $5, calls_total = $6, report_md = $7, quotes = $8,
       mask_hits = $9, input_tokens = $10, cached_tokens = $11, output_tokens = $12, reasoning_tokens = $13, cost_rub = $14, seconds = $15,
       prompt_version = $16, parsed = $17, main_manager = $18, score = $19
     WHERE id = $1`,
    [id, v.model, v.reasoningEffort, v.callsHash, v.callsCount, v.callsTotal, v.reportMd, JSON.stringify(v.quotes), JSON.stringify(v.maskHits),
      v.inputTokens, v.cachedTokens, v.outputTokens, v.reasoningTokens, v.costRub, v.seconds,
      v.promptVersion, JSON.stringify(v.parsed), v.mainManager, v.parsed.score],
  );
}

/** Готовая проверка звонка по задаче (kind task_check). */
export async function saveTaskCheckDone(id: number, v: { model: string; reportMd: string; quotes: unknown; parsed: unknown; callsCount: number; inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; costRub: number; seconds: number; promptVersion: string }): Promise<void> {
  await systemDb().query(
    `UPDATE ai_analyses SET status = 'done', phase = NULL, finished_at = now(), error = NULL, model = $2, report_md = $3, quotes = $4, parsed = $5,
       calls_count = $6, input_tokens = $7, cached_tokens = $8, output_tokens = $9, reasoning_tokens = $10, cost_rub = $11, seconds = $12, prompt_version = $13
     WHERE id = $1`,
    [id, v.model, v.reportMd, JSON.stringify(v.quotes), JSON.stringify(v.parsed), v.callsCount, v.inputTokens, v.cachedTokens, v.outputTokens, v.reasoningTokens, v.costRub, v.seconds, v.promptVersion],
  );
}

/** Дубль готового отчёта: копируем результат, денег не тратим. */
export async function saveDuplicate(id: number, fromId: number): Promise<void> {
  await systemDb().query(
    `UPDATE ai_analyses a SET status = 'done', phase = NULL, finished_at = now(), error = NULL,
       model = s.model, reasoning_effort = s.reasoning_effort, calls_hash = s.calls_hash, calls_count = s.calls_count,
       calls_total = s.calls_total, report_md = s.report_md, quotes = s.quotes, mask_hits = s.mask_hits,
       prompt_version = s.prompt_version, parsed = s.parsed, main_manager = s.main_manager, score = s.score,
       input_tokens = 0, cached_tokens = 0, output_tokens = 0, reasoning_tokens = 0, cost_rub = 0, seconds = 0
      FROM ai_analyses s WHERE a.id = $1 AND s.id = $2`,
    [id, fromId],
  );
}

/** Пересобрать «Предложить / Выяснить» по сохранённым связкам (дубль разбора: звонки те же, а сборка блоков
 *  или анкеты могли поменяться — пересчёт бесплатный, без модели). */
export async function refreshLinksLines(id: number, rebuild: (links: Record<string, unknown>) => Promise<{ propose: string[]; clarify: string[] } | null>): Promise<void> {
  const r = await systemDb().query<{ links: Record<string, unknown> | null }>(`SELECT parsed->'links' AS links FROM ai_analyses WHERE id = $1`, [id]);
  const links = r.rows[0]?.links;
  if (!links || !Array.isArray(links.pairs)) return;
  const next = await rebuild(links);
  if (!next) return;
  await systemDb().query(
    `UPDATE ai_analyses SET parsed = jsonb_set(parsed, '{links}', (parsed->'links') || $2::jsonb) WHERE id = $1`,
    [id, JSON.stringify(next)],
  );
}

export async function saveError(id: number, message: string, retry: boolean): Promise<void> {
  await systemDb().query(
    `UPDATE ai_analyses SET status = CASE WHEN $3 AND attempts < $4 THEN 'queued' ELSE 'error' END,
       phase = NULL, error = $2, finished_at = CASE WHEN $3 AND attempts < $4 THEN NULL ELSE now() END
     WHERE id = $1`,
    [id, message.slice(0, 1000), retry, MAX_ATTEMPTS],
  );
}

/** Старт процесса / зависший running: вернуть в очередь (или ошибка после MAX_ATTEMPTS). */
export async function requeueStale(all: boolean): Promise<number> {
  const r = await systemDb().query(
    `UPDATE ai_analyses SET status = CASE WHEN attempts < $1 THEN 'queued' ELSE 'error' END,
       phase = NULL, error = CASE WHEN attempts < $1 THEN error ELSE 'Анализ прервался (перезапуск сервера) — запустите заново' END,
       finished_at = CASE WHEN attempts < $1 THEN NULL ELSE now() END
     WHERE status = 'running' AND ($2 OR heartbeat_at < now() - make_interval(mins => $3))`,
    [MAX_ATTEMPTS, all, STALE_MINUTES],
  );
  return r.rowCount ?? 0;
}

export async function saveFeedback(id: number, v: { feedback: 'useful' | 'inaccurate'; note: string | null; by: string }): Promise<void> {
  await systemDb().query(
    `UPDATE ai_analyses SET feedback = $2, feedback_note = $3, feedback_by = $4, feedback_at = now() WHERE id = $1 AND status = 'done'`,
    [id, v.feedback, v.note, v.by],
  );
}

/** Журнал для настроек: последние запуски и расход за месяц. */
export async function journal(limit = 50): Promise<{ rows: AnalysisRow[]; monthRub: number; monthCount: number }> {
  const [rows, month] = await Promise.all([
    systemDb().query<Raw>(`SELECT ${COLS} FROM ai_analyses ORDER BY created_at DESC LIMIT $1`, [limit]),
    systemDb().query<{ rub: string | null; n: number }>(
      `SELECT sum(cost_rub)::text AS rub, count(*)::int AS n FROM ai_analyses WHERE created_at >= date_trunc('month', now())`),
  ]);
  return { rows: rows.rows.map(map), monthRub: Number(month.rows[0]?.rub ?? 0), monthCount: month.rows[0]?.n ?? 0 };
}

/** Отчёты до этапа 2 (без parsed) — разобрать кодом при старте воркера; основной менеджер не восстанавливаем. */
export async function backfillParsed(parse: (md: string) => { score: number | null }): Promise<number> {
  const r = await systemDb().query<{ id: string; report_md: string }>(
    `SELECT id, report_md FROM ai_analyses WHERE status = 'done' AND parsed IS NULL AND report_md IS NOT NULL LIMIT 500`,
  );
  for (const row of r.rows) {
    const p = parse(row.report_md);
    await systemDb().query(`UPDATE ai_analyses SET parsed = $2, score = $3 WHERE id = $1`, [row.id, JSON.stringify(p), p.score]);
  }
  return r.rows.length;
}
