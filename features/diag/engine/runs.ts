// Фоновые прогоны движка с прогрессом (diag_runs, миграция 208). API стартует прогон и
// сразу отвечает id; сама работа идёт в процессе сервера, прогресс — в БД, страница опрашивает.
import { systemDb } from '@/lib/db/clients';

export interface RunProgress { id: number; kind: string; status: 'running' | 'done' | 'error'; stage: string | null; total: number; done: number; summary: unknown; error: string | null; startedAt: string; finishedAt: string | null }

export type Progress = (stage: string, done: number, total: number) => Promise<void>;

export async function startRun(kind: 'refs' | 'daily', startedBy: string, job: (progress: Progress) => Promise<unknown>): Promise<{ id: number } | { busy: RunProgress }> {
  const db = systemDb();
  const busy = await db.query<{ id: string }>(`SELECT id::text FROM diag_runs WHERE kind = $1 AND status = 'running' AND updated_at > now() - interval '20 minutes' LIMIT 1`, [kind]);
  if (busy.rows[0]) return { busy: (await getRun(Number(busy.rows[0].id)))! };
  // Зависшие прогоны (сервер перезапустили посреди) — закрываем.
  await db.query(`UPDATE diag_runs SET status = 'error', error = 'прерван (сервер перезапущен?)', finished_at = now() WHERE kind = $1 AND status = 'running'`, [kind]);
  const ins = await db.query<{ id: string }>(`INSERT INTO diag_runs (kind, started_by, stage) VALUES ($1, $2, 'старт') RETURNING id::text`, [kind, startedBy]);
  const id = Number(ins.rows[0].id);
  let lastWrite = 0;
  const progress: Progress = async (stage, done, total) => {
    const now = Date.now();
    if (now - lastWrite < 700 && done < total) return; // не чаще ~1.5 раз/с
    lastWrite = now;
    await db.query(`UPDATE diag_runs SET stage = $2, done = $3, total = $4, updated_at = now() WHERE id = $1`, [id, stage, done, total]).catch(() => {});
  };
  void (async () => {
    try {
      const summary = await job(progress);
      await db.query(`UPDATE diag_runs SET status = 'done', summary = $2, finished_at = now(), updated_at = now(), stage = 'готово' WHERE id = $1`, [id, JSON.stringify(summary ?? {})]);
    } catch (e) {
      console.error(`[diag] прогон ${kind} #${id} упал:`, e);
      await db.query(`UPDATE diag_runs SET status = 'error', error = $2, finished_at = now(), updated_at = now() WHERE id = $1`, [id, e instanceof Error ? e.message : String(e)]).catch(() => {});
    }
  })();
  return { id };
}

export async function getRun(id: number): Promise<RunProgress | null> {
  const r = await systemDb().query<{ id: string; kind: string; status: RunProgress['status']; stage: string | null; total: number; done: number; summary: unknown; error: string | null; started_at: Date; finished_at: Date | null }>(
    `SELECT id::text, kind, status, stage, total, done, summary, error, started_at, finished_at FROM diag_runs WHERE id = $1`, [id]);
  const x = r.rows[0];
  return x ? { id: Number(x.id), kind: x.kind, status: x.status, stage: x.stage, total: x.total, done: x.done, summary: x.summary, error: x.error, startedAt: new Date(x.started_at).toISOString(), finishedAt: x.finished_at ? new Date(x.finished_at).toISOString() : null } : null;
}

export async function lastRuns(): Promise<RunProgress[]> {
  const r = await systemDb().query<{ id: string }>(`SELECT DISTINCT ON (kind) id::text FROM diag_runs ORDER BY kind, started_at DESC`);
  const out: RunProgress[] = [];
  for (const row of r.rows) { const p = await getRun(Number(row.id)); if (p) out.push(p); }
  return out;
}
